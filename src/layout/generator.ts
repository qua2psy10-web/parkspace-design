import polygonClipping from 'polygon-clipping';
import type { Pt } from '../geo/projection';
import {
  type Edge,
  type PCMulti,
  type Ring,
  add,
  bbox,
  closestOnSegment,
  convexInside,
  fromPC,
  multiRings,
  pointStatus,
  ringsToEdges,
  rotate,
  signedArea,
  sub,
  toPC,
} from '../geo/geometry';
import { type AngleType, type LayoutParams, stallShape } from './standards';

/** 割付の入力（すべて平面直角座標, m） */
export interface SiteInput {
  boundary: Pt[];
  obstacles: Pt[][];
  /** 出入口の位置（境界線上の点） */
  entrances: Pt[];
}

export interface Stall {
  corners: Pt[];
  kind: 'normal' | 'wheelchair';
}

export interface Plan {
  angle: AngleType;
  /** 車路の向き（度, 東を0として反時計回り） */
  direction: number;
  count: number;
  wheelchair: number;
  stalls: Stall[];
  aisles: Ring[];
  trunks: Ring[];
  warnings: string[];
}

/** マスを横にずらしながら探す刻み（m） */
const SCAN_STEP = 0.25;
/** 方向候補として採用する辺の最小長さ（m） */
const MIN_EDGE_FOR_DIRECTION = 3;
/** 方向候補の上限（辺の長い順） */
const MAX_DIRECTIONS = 6;

interface Row {
  /** 奥側・手前側の y（回転座標） */
  backY: number;
  frontY: number;
  aisleY0: number;
  aisleY1: number;
}

interface Frame {
  edgesStall: Edge[];
  edgesUsable: Edge[];
  usable: PCMulti;
  corridors: PCMulti;
  entrances: Pt[];
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

interface RowResult {
  row: Row;
  stalls: Pt[][];
  /** 使った車路片の番号 */
  pieces: Set<number>;
}

interface Layout {
  rows: RowResult[];
  pieces: PCMulti;
  count: number;
}

export function generatePlans(site: SiteInput, params: LayoutParams): Plan[] {
  if (site.boundary.length < 3) return [];
  const origin = site.boundary[0];
  const boundary = site.boundary.map((p) => sub(p, origin));
  const obstacles = site.obstacles.filter((o) => o.length >= 3).map((o) => o.map((p) => sub(p, origin)));
  const entrances = site.entrances.map((p) => sub(p, origin));
  if (Math.abs(signedArea(boundary)) < 1) return [];

  let usable: PCMulti = [[toPC(boundary)]];
  if (obstacles.length) {
    usable = polygonClipping.difference(usable, ...obstacles.map((o) => [toPC(o)]));
  }

  const entranceNormals = entrances.map((e) => inwardNormal(boundary, e));
  const plans: Plan[] = [];

  for (const dir of candidateDirections(boundary)) {
    let frame: Frame;
    try {
      frame = makeFrame(usable, entrances, entranceNormals, dir, params);
    } catch (e) {
      console.warn('割付に失敗した方向をスキップしました', dir, e);
      continue;
    }
    for (const angle of params.angles) {
      try {
        const best = bestLayout(frame, angle, params);
        if (!best || best.count === 0) continue;
        plans.push(toPlan(best, frame, angle, dir, origin, params, entrances.length > 0));
      } catch (e) {
        // 図形演算ライブラリが特殊な形状で失敗した場合は、その方向・方式だけ飛ばす
        console.warn('割付に失敗した方向をスキップしました', dir, angle, e);
      }
    }
  }
  plans.sort((a, b) => b.count - a.count);
  return plans;
}

/** 境界の辺の向き（長い辺から）とその直角方向を候補にする */
function candidateDirections(boundary: Pt[]): number[] {
  const edges = boundary
    .map((a, i) => {
      const b = boundary[(i + 1) % boundary.length];
      return { len: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
    })
    .filter((e) => e.len >= MIN_EDGE_FOR_DIRECTION)
    .sort((a, b) => b.len - a.len);
  const dirs: number[] = [];
  const pushDir = (ang: number) => {
    const a = ((ang % Math.PI) + Math.PI) % Math.PI;
    const dup = dirs.some((d) => {
      const diff = Math.abs(d - a);
      return Math.min(diff, Math.PI - diff) < (0.5 * Math.PI) / 180;
    });
    if (!dup) dirs.push(a);
  };
  for (const e of edges) {
    if (dirs.length >= MAX_DIRECTIONS * 2) break;
    pushDir(e.ang);
    pushDir(e.ang + Math.PI / 2);
  }
  if (!dirs.length) dirs.push(0, Math.PI / 2);
  return dirs;
}

/** 出入口がのる境界辺の、敷地内側を向く単位ベクトル */
function inwardNormal(boundary: Pt[], e: Pt): Pt {
  let best = { d: Infinity, a: boundary[0], b: boundary[1] };
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i];
    const b = boundary[(i + 1) % boundary.length];
    const { pt } = closestOnSegment(e, a, b);
    const d = Math.hypot(pt.x - e.x, pt.y - e.y);
    if (d < best.d) best = { d, a, b };
  }
  const dx = best.b.x - best.a.x;
  const dy = best.b.y - best.a.y;
  const len = Math.hypot(dx, dy) || 1;
  // 反時計回りの輪郭なら左手側が内側
  const s = signedArea(boundary) > 0 ? 1 : -1;
  return { x: (-dy / len) * s, y: (dx / len) * s };
}

function rotateMulti(m: PCMulti, ang: number): PCMulti {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  // 図形演算の誤差で失敗しないよう 1μm 単位に丸める
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return m.map((poly) => poly.map((ring) => ring.map(([x, y]) => [r(x * c - y * s), r(x * s + y * c)] as [number, number])));
}

function rect(x0: number, x1: number, y0: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** 車路が x 軸に沿うように回転した座標系を準備する */
function makeFrame(usable: PCMulti, entrances: Pt[], normals: Pt[], dir: number, params: LayoutParams): Frame {
  const u = rotateMulti(usable, -dir);
  const rings = multiRings(u);
  const bb = bbox(rings);
  const ents = entrances.map((e) => rotate(e, -dir));
  const tw = params.trunkWidth;
  // 出入口から敷地内側へ車路と直交する幹線車路を通す
  const corridorRects: PCMulti = ents.map((e, i) => {
    const n = rotate(normals[i], -dir);
    const cx = e.x + (n.x * tw) / 2;
    return [toPC(rect(cx - tw / 2, cx + tw / 2, bb.ymin - 1, bb.ymax + 1))];
  });
  let stallArea = u;
  let corridors: PCMulti = [];
  if (corridorRects.length) {
    corridors = polygonClipping.intersection(u, polygonClipping.union(corridorRects[0], ...corridorRects.slice(1)));
    stallArea = polygonClipping.difference(u, ...corridorRects);
  }
  return {
    edgesStall: ringsToEdges(multiRings(stallArea)),
    edgesUsable: ringsToEdges(rings),
    usable: u,
    corridors,
    entrances: ents,
    ...bb,
  };
}

function bestLayout(frame: Frame, angle: AngleType, params: LayoutParams): Layout | null {
  const shape = stallShape(angle, params);
  const A = params.aisle[angle];
  const period = 2 * shape.depth + A;
  const step = Math.min(1.0, period / 8);
  let best: Layout | null = null;
  for (let off = 0; off < period - 1e-9; off += step) {
    const layout = buildLayout(frame, angle, params, frame.ymin - period + off, period);
    if (!best || layout.count > best.count) best = layout;
  }
  return best;
}

/** 「マス列＋車路＋マス列」の帯を y0 から period ごとに並べる */
function buildLayout(frame: Frame, angle: AngleType, params: LayoutParams, y0: number, period: number): Layout {
  const shape = stallShape(angle, params);
  const D = shape.depth;
  const A = params.aisle[angle];
  const rows: RowResult[] = [];
  const allPieces: PCMulti = [];
  let count = 0;
  for (let base = y0; base < frame.ymax; base += period) {
    const ay0 = base + D;
    const ay1 = base + D + A;
    if (ay1 <= frame.ymin || ay0 >= frame.ymax) continue;
    const pieces = aislePieces(frame, ay0, ay1);
    const pieceOffset = allPieces.length;
    allPieces.push(...pieces.map((p) => p.poly));
    for (const row of [
      { backY: base, frontY: ay0, aisleY0: ay0, aisleY1: ay1 },
      { backY: ay1 + D, frontY: ay1, aisleY0: ay0, aisleY1: ay1 },
    ]) {
      const res = fillRow(frame, row, angle, params, pieces, () => params.stallWidth, 1);
      res.pieces = new Set([...res.pieces].map((i) => i + pieceOffset));
      count += res.stalls.length;
      rows.push(res);
    }
  }
  return { rows, pieces: allPieces, count };
}

interface Piece {
  poly: PCMulti[number];
  edges: Edge[];
  connected: boolean;
}

/** 車路の帯のうち敷地内に入る部分を片ごとに分け、出入口とつながるか判定する */
function aislePieces(frame: Frame, y0: number, y1: number): Piece[] {
  const band = [toPC(rect(frame.xmin - 1, frame.xmax + 1, y0, y1))];
  const inter = polygonClipping.intersection(frame.usable, band);
  const noEntrance = frame.entrances.length === 0;
  return inter.map((poly) => ({
    poly,
    edges: ringsToEdges(poly.map(fromPC)),
    connected: noEntrance || polygonClipping.intersection([poly], frame.corridors).length > 0,
  }));
}

function makeStall(x: number, pitch: number, row: Row, shift: number): Pt[] {
  return [
    { x, y: row.frontY },
    { x: x + pitch, y: row.frontY },
    { x: x + pitch + shift, y: row.backY },
    { x: x + shift, y: row.backY },
  ];
}

/**
 * 1列分のマスを端から詰めて並べる。
 * widthAt(i) は i 番目に置くマスの幅、dirSign は +1 で x の小さい側から、-1 で大きい側から詰める。
 * startX を指定するとその位置から詰め始める（+1 ならマスの左端、-1 なら右端）。
 */
function fillRow(
  frame: Frame,
  row: Row,
  angle: AngleType,
  params: LayoutParams,
  pieces: Piece[],
  widthAt: (i: number) => number,
  dirSign: 1 | -1,
  startX?: number,
): RowResult {
  const lo = Math.min(row.backY, row.frontY) - params.setback - 1e-6;
  const hi = Math.max(row.backY, row.frontY) + params.setback + 1e-6;
  const edgesS = frame.edgesStall.filter((e) => e.ymax >= lo && e.ymin <= hi);
  const edgesA = frame.edgesUsable.filter((e) => e.ymax >= row.aisleY0 - 1e-6 && e.ymin <= row.aisleY1 + 1e-6);
  const stalls: Pt[][] = [];
  const used = new Set<number>();
  const base = stallShape(angle, params);
  let x = startX ?? (dirSign > 0 ? frame.xmin : frame.xmax);
  for (let guard = 0; guard < 100000; guard++) {
    const shape = stallShape(angle, params, angle === 0 ? undefined : widthAt(stalls.length));
    const pitch = angle === 0 ? base.pitch : shape.pitch;
    const shift = base.shift;
    const left = dirSign > 0 ? x : x - pitch - shift;
    if (dirSign > 0 ? left > frame.xmax : left + pitch + shift < frame.xmin) break;
    const quad = makeStall(left, pitch, row, shift);
    const front = rect(left, left + pitch, row.aisleY0, row.aisleY1);
    let ok = convexInside(quad, edgesS, params.setback) && convexInside(front, edgesA);
    let pieceIdx = -1;
    if (ok) {
      const c = { x: left + pitch / 2, y: (row.aisleY0 + row.aisleY1) / 2 };
      pieceIdx = pieces.findIndex((p) => pointStatus(c, p.edges) !== 'out');
      ok = pieceIdx >= 0 && pieces[pieceIdx].connected;
    }
    if (ok) {
      stalls.push(quad);
      used.add(pieceIdx);
      x += dirSign * pitch;
    } else {
      x += dirSign * SCAN_STEP;
    }
  }
  return { row, stalls, pieces: used };
}

function toPlan(
  layout: Layout,
  frame: Frame,
  angle: AngleType,
  dir: number,
  origin: Pt,
  params: LayoutParams,
  hasEntrance: boolean,
): Plan {
  const warnings: string[] = [];
  if (!hasEntrance) warnings.push('出入口が未指定のため、車路と出入口の接続は確認していません。');

  const rows = layout.rows.map((r) => ({ ...r, kinds: r.stalls.map(() => 'normal' as Stall['kind']) }));
  let wheelchair = 0;
  const want = params.wheelchairCount;
  if (want > 0) {
    if (angle !== 90) {
      warnings.push('車いす使用者用マスは直角駐車の案でのみ自動配置します。');
    } else {
      wheelchair = placeWheelchair(rows, frame, params, layout);
      if (wheelchair < want) warnings.push(`車いす使用者用マスは ${want} 台中 ${wheelchair} 台しか配置できませんでした。`);
    }
  }

  const toWorld = (p: Pt) => add(rotate(p, dir), origin);
  const stalls: Stall[] = [];
  const usedPieces = new Set<number>();
  for (const r of rows) {
    r.stalls.forEach((q, i) => stalls.push({ corners: q.map(toWorld), kind: r.kinds[i] }));
    r.pieces.forEach((i) => usedPieces.add(i));
  }
  const aisles = [...usedPieces].flatMap((i) => layout.pieces[i].map((ring) => fromPC(ring).map(toWorld)));
  const trunks = multiRings(frame.corridors).map((r) => r.map(toWorld));
  const deg = ((dir * 180) / Math.PI + 360) % 180;
  return { angle, direction: deg, count: stalls.length, wheelchair, stalls, aisles, trunks, warnings };
}

/** 出入口に近い列から、出入口側の端に車いす使用者用マスを詰め直す */
function placeWheelchair(
  rows: (RowResult & { kinds: Stall['kind'][] })[],
  frame: Frame,
  params: LayoutParams,
  layout: Layout,
): number {
  const ents = frame.entrances.length ? frame.entrances : [{ x: frame.xmin, y: frame.ymin }];
  const distOf = (q: Pt[]) => {
    const c = { x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 };
    return Math.min(...ents.map((e) => Math.hypot(c.x - e.x, c.y - e.y)));
  };
  const order = rows
    .map((r, i) => ({ i, d: r.stalls.length ? Math.min(...r.stalls.map(distOf)) : Infinity }))
    .filter((o) => o.d < Infinity)
    .sort((a, b) => a.d - b.d);
  let placed = 0;
  for (const { i } of order) {
    const remaining = params.wheelchairCount - placed;
    if (remaining <= 0) break;
    const r = rows[i];
    // 出入口に最も近いマスの、出入口側の辺を起点にする
    const nearest = r.stalls.reduce((a, b) => (distOf(a) < distOf(b) ? a : b));
    const nx0 = Math.min(...nearest.map((p) => p.x));
    const nx1 = Math.max(...nearest.map((p) => p.x));
    const ent = ents.reduce((a, b) => (Math.hypot(a.x - nearest[0].x, a.y - nearest[0].y) < Math.hypot(b.x - nearest[0].x, b.y - nearest[0].y) ? a : b));
    const towardPlus = ent.x >= (nx0 + nx1) / 2;
    const anchor = towardPlus ? nx1 : nx0;
    const pieces = aislePieces(frame, r.row.aisleY0, r.row.aisleY1);
    const hcWidth = (k: number) => (k < remaining ? params.wheelchairWidth : params.stallWidth);
    // 起点から出入口と反対側へ車いす用→普通の順に、出入口側へは普通マスを詰め直す
    const away = fillRow(frame, r.row, 90, params, pieces, hcWidth, towardPlus ? -1 : 1, anchor);
    const toward = fillRow(frame, r.row, 90, params, pieces, () => params.stallWidth, towardPlus ? 1 : -1, anchor);
    const hc = Math.min(remaining, away.stalls.length);
    const stalls = [...away.stalls, ...toward.stalls];
    rows[i] = {
      ...r,
      stalls,
      kinds: stalls.map((_, k) => (k < hc ? 'wheelchair' : 'normal')),
    };
    placed += hc;
  }
  layout.count = rows.reduce((s, r) => s + r.stalls.length, 0);
  return placed;
}
