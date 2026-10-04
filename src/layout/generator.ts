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
  convexOverlap,
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
  /**
   * 出入口ごとの敷地内側を向く単位ベクトル（省略時は最寄りの境界辺から求める）。
   * エリアの接続口が穴（障害物）の輪郭上にある場合などに指定する。
   */
  entranceNormals?: (Pt | null)[];
}

export interface Stall {
  corners: Pt[];
  kind: 'normal' | 'wheelchair';
}

/** 一方通行の向きを示す矢印（from → to） */
export interface Arrow {
  from: Pt;
  to: Pt;
}

export interface Plan {
  angle: AngleType;
  /** 車路の向き（度, 東を0として反時計回り） */
  direction: number;
  count: number;
  wheelchair: number;
  /** 余白に追加したマスの数（count の内数） */
  added: number;
  stalls: Stall[];
  aisles: Ring[];
  trunks: Ring[];
  arrows: Arrow[];
  warnings: string[];
}

/** マスを横にずらしながら探す刻み（m） */
const SCAN_STEP = 0.25;
/** 方向候補として採用する辺の最小長さ（m） */
const MIN_EDGE_FOR_DIRECTION = 3;
/** 方向候補の上限（辺の長い順） */
const MAX_DIRECTIONS = 6;
/** 一方通行の矢印の間隔と長さ（m） */
const ARROW_SPACING = 15;
const ARROW_LENGTH = 4;
/** 連絡車路を車路の端から内側へずらして探す範囲（m） */
const CONNECTOR_SEARCH = 3;

interface Row {
  /** 奥側・手前側の y（回転座標） */
  backY: number;
  frontY: number;
  aisleY0: number;
  aisleY1: number;
  /** 車路の通行方向（+1: x の正方向, -1: 負方向）。斜めマスの傾きもこれに合わせる */
  flow: 1 | -1;
}

interface Frame {
  edgesStall: Edge[];
  edgesUsable: Edge[];
  usable: PCMulti;
  corridors: PCMulti;
  /** 幹線車路の長方形（回転座標, 敷地で切る前） */
  corridorRects: Pt[][];
  entrances: Pt[];
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

interface Piece {
  poly: PCMulti[number];
  edges: Edge[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  flow: 1 | -1;
  connected: boolean;
}

/** 隣り合う車路片 a, b の端をつなぐ連絡車路 */
interface Connector {
  rect: Pt[];
  a: number;
  b: number;
}

interface RowResult {
  row: Row;
  stalls: Pt[][];
  /** この列が面する車路片の候補（番号） */
  cands: number[];
  /** 使った車路片の番号 */
  pieces: Set<number>;
}

interface Layout {
  rows: RowResult[];
  pieces: Piece[];
  connectors: Connector[];
  count: number;
}

/** マスの形の指定。rect = true なら角度によらず直角の長方形（車いす用） */
interface ShapeSpec {
  width: number;
  rect: boolean;
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

  const entranceNormals = entrances.map((e, i) => site.entranceNormals?.[i] ?? inwardNormal(boundary, e));
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
        plans.push(toPlan(best, frame, angle, dir, origin, params));
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

function polyBox(q: Pt[]) {
  return bbox([q]);
}

/** 車路が x 軸に沿うように回転した座標系を準備する */
function makeFrame(usable: PCMulti, entrances: Pt[], normals: Pt[], dir: number, params: LayoutParams): Frame {
  const u = rotateMulti(usable, -dir);
  const rings = multiRings(u);
  const bb = bbox(rings);
  const ents = entrances.map((e) => rotate(e, -dir));
  const tw = params.trunkWidth;
  // 出入口から敷地内側へ車路と直交する幹線車路を通す
  const corridorRects = ents.map((e, i) => {
    const n = rotate(normals[i], -dir);
    const cx = e.x + (n.x * tw) / 2;
    return rect(cx - tw / 2, cx + tw / 2, bb.ymin - 1, bb.ymax + 1);
  });
  let stallArea = u;
  let corridors: PCMulti = [];
  if (corridorRects.length) {
    const pcRects: PCMulti = corridorRects.map((r) => [toPC(r)]);
    corridors = polygonClipping.intersection(u, polygonClipping.union(pcRects[0], ...pcRects.slice(1)));
    stallArea = polygonClipping.difference(u, ...pcRects);
  }
  return {
    edgesStall: ringsToEdges(multiRings(stallArea)),
    edgesUsable: ringsToEdges(rings),
    usable: u,
    corridors,
    corridorRects,
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
  const D = stallShape(angle, params).depth;
  const A = params.aisle[angle];
  const strips: { ay0: number; ay1: number; base: number; flow: 1 | -1; idx: number[] }[] = [];
  const pieces: Piece[] = [];
  let k = 0;
  for (let base = y0; base < frame.ymax; base += period, k++) {
    const ay0 = base + D;
    const ay1 = base + D + A;
    if (ay1 <= frame.ymin || ay0 >= frame.ymax) continue;
    // 直角駐車は対面通行、斜め・縦列は一方通行で帯ごとに向きを交互にする
    const flow: 1 | -1 = angle === 90 || k % 2 === 0 ? 1 : -1;
    const ps = aislePieces(frame, ay0, ay1, flow);
    strips.push({ ay0, ay1, base, flow, idx: ps.map((_, i) => pieces.length + i) });
    pieces.push(...ps);
  }

  const connectors = params.loopAisles ? makeConnectors(frame, strips, pieces, A) : [];
  propagateConnection(pieces, connectors);

  const rows: RowResult[] = [];
  let count = 0;
  for (const s of strips) {
    for (const row of [
      { backY: s.base, frontY: s.ay0, aisleY0: s.ay0, aisleY1: s.ay1, flow: s.flow },
      { backY: s.ay1 + D, frontY: s.ay1, aisleY0: s.ay0, aisleY1: s.ay1, flow: s.flow },
    ]) {
      const blocked = blockedFor(row, connectors);
      const res = fillRow(frame, row, angle, params, pieces, s.idx, () => ({ width: params.stallWidth, rect: false }), 1, undefined, blocked);
      count += res.stalls.length;
      rows.push(res);
    }
  }
  return { rows, pieces, connectors, count };
}

function blockedFor(row: Row, connectors: Connector[]): Pt[][] {
  const lo = Math.min(row.backY, row.frontY);
  const hi = Math.max(row.backY, row.frontY);
  return connectors.filter((c) => c.rect[0].y < hi && c.rect[2].y > lo).map((c) => c.rect);
}

/** 車路の帯のうち敷地内に入る部分を片ごとに分け、幹線車路とつながるか判定する */
function aislePieces(frame: Frame, y0: number, y1: number, flow: 1 | -1): Piece[] {
  const band = [toPC(rect(frame.xmin - 1, frame.xmax + 1, y0, y1))];
  const inter = polygonClipping.intersection(frame.usable, band);
  const noEntrance = frame.entrances.length === 0;
  return inter.map((poly) => {
    const rings = poly.map(fromPC);
    const bb = bbox(rings);
    return {
      poly,
      edges: ringsToEdges(rings),
      x0: bb.xmin,
      x1: bb.xmax,
      y0,
      y1,
      flow,
      connected: noEntrance || polygonClipping.intersection([poly], frame.corridors).length > 0,
    };
  });
}

/** 車路片の端（x0 側なら side=-1）が幹線車路に接しているか */
function endTouchesTrunk(frame: Frame, p: Piece, side: -1 | 1, w: number): boolean {
  const a = side < 0 ? p.x0 : p.x1 - w;
  const b = side < 0 ? p.x0 + w : p.x1;
  return frame.corridorRects.some((r) => r[0].x <= b + 1e-6 && r[1].x >= a - 1e-6);
}

/**
 * 隣り合う帯の車路片の端どうしを、帯をまたぐ連絡車路でつなぐ。
 * 幹線車路に接している端には作らない。
 */
function makeConnectors(
  frame: Frame,
  strips: { ay0: number; ay1: number; idx: number[] }[],
  pieces: Piece[],
  w: number,
): Connector[] {
  const out: Connector[] = [];
  for (let i = 0; i + 1 < strips.length; i++) {
    const s = strips[i];
    const t = strips[i + 1];
    for (const a of s.idx) {
      for (const b of t.idx) {
        const P = pieces[a];
        const Q = pieces[b];
        const lo = Math.max(P.x0, Q.x0);
        const hi = Math.min(P.x1, Q.x1);
        if (hi - lo < w) continue;
        // 端が斜めの境界だと端ちょうどでははみ出すため、内側へずらしながら置ける位置を探す
        const place = (from: number, sign: 1 | -1) => {
          for (let d = 0; d <= CONNECTOR_SEARCH; d += SCAN_STEP) {
            const x = sign > 0 ? from + d : from - d - w;
            if (x < lo - 1e-9 || x + w > hi + 1e-9) return null;
            const r = rect(x, x + w, s.ay0, t.ay1);
            if (convexInside(r, frame.edgesUsable)) return r;
          }
          return null;
        };
        const left = !endTouchesTrunk(frame, P, -1, w) || !endTouchesTrunk(frame, Q, -1, w) ? place(lo, 1) : null;
        const right = !endTouchesTrunk(frame, P, 1, w) || !endTouchesTrunk(frame, Q, 1, w) ? place(hi, -1) : null;
        if (left) out.push({ rect: left, a, b });
        if (right && (!left || right[0].x >= left[1].x + w)) out.push({ rect: right, a, b });
      }
    }
  }
  return out;
}

/** 連絡車路を通じて幹線車路につながる車路片を広げる */
function propagateConnection(pieces: Piece[], connectors: Connector[]) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of connectors) {
      const A = pieces[c.a];
      const B = pieces[c.b];
      if (A.connected !== B.connected) {
        A.connected = B.connected = true;
        changed = true;
      }
    }
  }
}

/**
 * 1列分のマスを端から詰めて並べる。
 * shapeAt(i) は i 番目に置くマスの形、dirSign は +1 で x の小さい側から、-1 で大きい側から詰める。
 * startX を指定するとその位置から詰め始める（+1 ならマスの左端、-1 なら右端）。
 * blocked と重なる位置、直前に置いたマスと重なる位置には置かない。
 */
function fillRow(
  frame: Frame,
  row: Row,
  angle: AngleType,
  params: LayoutParams,
  pieces: Piece[],
  cands: number[],
  shapeAt: (i: number) => ShapeSpec,
  dirSign: 1 | -1,
  startX?: number,
  blocked: Pt[][] = [],
): RowResult {
  const backSign = row.backY > row.frontY ? 1 : -1;
  const farY = row.frontY + backSign * Math.max(Math.abs(row.backY - row.frontY), params.stallLength);
  const lo = Math.min(farY, row.frontY) - params.setback - 1e-6;
  const hi = Math.max(farY, row.frontY) + params.setback + 1e-6;
  const edgesS = frame.edgesStall.filter((e) => e.ymax >= lo && e.ymin <= hi);
  const edgesA = frame.edgesUsable.filter((e) => e.ymax >= row.aisleY0 - 1e-6 && e.ymin <= row.aisleY1 + 1e-6);
  const stalls: Pt[][] = [];
  const used = new Set<number>();
  const base = stallShape(angle, params);
  let last: Pt[] | null = null;
  let x = startX ?? (dirSign > 0 ? frame.xmin : frame.xmax);
  for (let guard = 0; guard < 100000; guard++) {
    const spec = shapeAt(stalls.length);
    let pitch: number;
    let shift: number;
    let backY = row.backY;
    if (spec.rect) {
      pitch = spec.width;
      shift = 0;
      backY = row.frontY + backSign * params.stallLength;
    } else if (angle === 0) {
      pitch = base.pitch;
      shift = 0;
    } else {
      const sh = stallShape(angle, params, spec.width);
      pitch = sh.pitch;
      shift = sh.shift * row.flow;
    }
    // マスが占める x の範囲は [left + ext0, left + ext1]
    const ext0 = Math.min(0, shift);
    const ext1 = pitch + Math.max(0, shift);
    const left = dirSign > 0 ? x - ext0 : x - ext1;
    if (dirSign > 0 ? left + ext0 > frame.xmax : left + ext1 < frame.xmin) break;
    const quad = [
      { x: left, y: row.frontY },
      { x: left + pitch, y: row.frontY },
      { x: left + pitch + shift, y: backY },
      { x: left + shift, y: backY },
    ];
    const front = rect(left, left + pitch, row.aisleY0, row.aisleY1);
    let ok =
      convexInside(quad, edgesS, params.setback) &&
      convexInside(front, edgesA) &&
      !(last && convexOverlap(quad, last)) &&
      !blocked.some((b) => convexOverlap(quad, b));
    let pieceIdx = -1;
    if (ok) {
      const c = { x: left + pitch / 2, y: (row.aisleY0 + row.aisleY1) / 2 };
      pieceIdx = cands.find((i) => pointStatus(c, pieces[i].edges) !== 'out') ?? -1;
      ok = pieceIdx >= 0 && pieces[pieceIdx].connected;
    }
    if (ok) {
      stalls.push(quad);
      used.add(pieceIdx);
      last = quad;
      x = dirSign > 0 ? left + pitch + ext0 : left + ext1 - pitch;
    } else {
      x += dirSign * SCAN_STEP;
    }
  }
  return { row, stalls, cands, pieces: used };
}

type KindRow = RowResult & { kinds: Stall['kind'][] };

function toPlan(layout: Layout, frame: Frame, angle: AngleType, dir: number, origin: Pt, params: LayoutParams): Plan {
  const warnings: string[] = [];
  if (!frame.entrances.length) warnings.push('出入口が未指定のため、車路と出入口の接続は確認していません。');

  const rows: KindRow[] = layout.rows.map((r) => ({ ...r, kinds: r.stalls.map(() => 'normal' as Stall['kind']) }));
  let wheelchair = 0;
  const want = params.wheelchairCount;
  if (want > 0) {
    const D = stallShape(angle, params).depth;
    if (angle === 0) {
      warnings.push('縦列駐車の案では車いす使用者用マスを自動配置しません。');
    } else if (D < params.stallLength - 1e-9) {
      warnings.push('列の奥行が足りないため、この案では車いす使用者用マスを自動配置しません。');
    } else {
      wheelchair = placeWheelchair(rows, frame, params, angle, layout);
      if (wheelchair < want) warnings.push(`車いす使用者用マスは ${want} 台中 ${wheelchair} 台しか配置できませんでした。`);
    }
  }

  const usedPieces = new Set<number>();
  for (const r of rows) r.pieces.forEach((i) => usedPieces.add(i));
  const usedConnectors = layout.connectors.filter((c) => layout.pieces[c.a].connected && (usedPieces.has(c.a) || usedPieces.has(c.b)));

  const filled = params.infill ? infill(frame, layout, rows, usedConnectors, params) : { stalls: [], pieces: new Set<number>() };
  const extra = filled.stalls;
  filled.pieces.forEach((i) => usedPieces.add(i));

  // 行き止まりの車路を数える
  const A = params.aisle[angle];
  let deadEnds = 0;
  for (const i of usedPieces) {
    const p = layout.pieces[i];
    for (const side of [-1, 1] as const) {
      if (endTouchesTrunk(frame, p, side, A)) continue;
      const end = side < 0 ? p.x0 : p.x1;
      const hasConn = usedConnectors.some(
        (c) => (c.a === i || c.b === i) && Math.min(Math.abs(c.rect[0].x - end), Math.abs(c.rect[1].x - end)) < A + CONNECTOR_SEARCH + 1e-6,
      );
      if (!hasConn) deadEnds++;
    }
  }
  if (deadEnds > 0 && frame.entrances.length) {
    warnings.push(`行き止まりの車路が ${deadEnds} か所あります。転回できる広さか確認してください。`);
  }

  const toWorld = (p: Pt) => add(rotate(p, dir), origin);
  const stalls: Stall[] = [];
  for (const r of rows) r.stalls.forEach((q, i) => stalls.push({ corners: q.map(toWorld), kind: r.kinds[i] }));
  for (const q of extra) stalls.push({ corners: q.map(toWorld), kind: 'normal' });

  const aisles = [
    ...[...usedPieces].flatMap((i) => layout.pieces[i].poly.map((ring) => fromPC(ring).map(toWorld))),
    ...usedConnectors.map((c) => c.rect.map(toWorld)),
  ];
  const trunks = multiRings(frame.corridors).map((r) => r.map(toWorld));

  const arrows: Arrow[] = [];
  if (angle !== 90) {
    for (const i of usedPieces) {
      const p = layout.pieces[i];
      const len = p.x1 - p.x0;
      if (len < ARROW_LENGTH) continue;
      const n = Math.max(1, Math.floor(len / ARROW_SPACING));
      const y = (p.y0 + p.y1) / 2;
      for (let k = 0; k < n; k++) {
        const cx = p.x0 + (len * (k + 0.5)) / n;
        arrows.push({
          from: toWorld({ x: cx - (p.flow * ARROW_LENGTH) / 2, y }),
          to: toWorld({ x: cx + (p.flow * ARROW_LENGTH) / 2, y }),
        });
      }
    }
  }

  const deg = ((dir * 180) / Math.PI + 360) % 180;
  return { angle, direction: deg, count: stalls.length, wheelchair, added: extra.length, stalls, aisles, trunks, arrows, warnings };
}

/** 出入口に最も近いマスを起点に、車いす使用者用マス（直角の長方形）を詰め直す */
function placeWheelchair(rows: KindRow[], frame: Frame, params: LayoutParams, angle: AngleType, layout: Layout): number {
  const ents = frame.entrances.length ? frame.entrances : [{ x: frame.xmin, y: frame.ymin }];
  const center = (q: Pt[]) => ({ x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length });
  const distOf = (q: Pt[]) => {
    const c = center(q);
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
    // 出入口に最も近いマスの、出入口側の端を起点にする
    const nearest = r.stalls.reduce((a, b) => (distOf(a) < distOf(b) ? a : b));
    const nx0 = Math.min(...nearest.map((p) => p.x));
    const nx1 = Math.max(...nearest.map((p) => p.x));
    const nc = center(nearest);
    const ent = ents.reduce((a, b) => (Math.hypot(a.x - nc.x, a.y - nc.y) < Math.hypot(b.x - nc.x, b.y - nc.y) ? a : b));
    const towardPlus = ent.x >= nc.x;
    const anchor = towardPlus ? nx1 : nx0;
    const blocked = blockedFor(r.row, layout.connectors);
    const hcShape = (k: number): ShapeSpec =>
      k < remaining ? { width: params.wheelchairWidth, rect: true } : { width: params.stallWidth, rect: false };
    const normal = (): ShapeSpec => ({ width: params.stallWidth, rect: false });
    // 起点から出入口と反対側へ車いす用→普通の順に、出入口側へは普通マスを詰め直す
    const away = fillRow(frame, r.row, angle, params, layout.pieces, r.cands, hcShape, towardPlus ? -1 : 1, anchor, blocked);
    const toward = fillRow(frame, r.row, angle, params, layout.pieces, r.cands, normal, towardPlus ? 1 : -1, anchor, [
      ...blocked,
      ...away.stalls,
    ]);
    const hc = Math.min(remaining, away.stalls.length);
    const stalls = [...away.stalls, ...toward.stalls];
    rows[i] = {
      ...r,
      stalls,
      pieces: new Set([...away.pieces, ...toward.pieces]),
      kinds: stalls.map((_, k) => (k < hc ? 'wheelchair' : 'normal')),
    };
    placed += hc;
  }
  return placed;
}

/** 近くのマスだけを調べるための格子 */
class Grid {
  private cells = new Map<string, Pt[][]>();
  constructor(private size: number) {}
  private keys(q: Pt[]): string[] {
    const b = polyBox(q);
    const out: string[] = [];
    for (let i = Math.floor(b.xmin / this.size); i <= Math.floor(b.xmax / this.size); i++)
      for (let j = Math.floor(b.ymin / this.size); j <= Math.floor(b.ymax / this.size); j++) out.push(`${i},${j}`);
    return out;
  }
  add(q: Pt[]) {
    for (const k of this.keys(q)) {
      const list = this.cells.get(k);
      if (list) list.push(q);
      else this.cells.set(k, [q]);
    }
  }
  near(q: Pt[]): Pt[][] {
    const set = new Set<Pt[]>();
    for (const k of this.keys(q)) this.cells.get(k)?.forEach((p) => set.add(p));
    return [...set];
  }
}

/**
 * 幹線車路・連絡車路・車路の両側に沿って、空いている所へマスを追加する。
 * 幹線車路・連絡車路の脇には直角マス（通路幅が直角駐車の車路幅以上の場合）と縦列マス、
 * 車路の脇には縦列マスを試す。
 */
function infill(
  frame: Frame,
  layout: Layout,
  rows: RowResult[],
  connectors: Connector[],
  params: LayoutParams,
): { stalls: Pt[][]; pieces: Set<number> } {
  const grid = new Grid(10);
  for (const r of rows) r.stalls.forEach((q) => grid.add(q));

  // piece: 車路片の番号（車路片の脇に置いたマスがあれば、その車路片も表示・出力に含める）
  const bandRects: { r: Pt[]; vertical: boolean; piece?: number }[] = [];
  layout.pieces.forEach((p, i) => {
    if (p.connected) bandRects.push({ r: rect(p.x0, p.x1, p.y0, p.y1), vertical: false, piece: i });
  });
  connectors.forEach((c) => bandRects.push({ r: c.rect, vertical: true }));
  frame.corridorRects.forEach((c) => bandRects.push({ r: rect(c[0].x, c[1].x, frame.ymin, frame.ymax), vertical: true }));
  // 未接続の車路片も空き地として使えるよう、交通の障害としては接続済みのものだけを扱う
  const traffic = bandRects.map((b) => b.r);

  const added: Pt[][] = [];
  const usedPieces = new Set<number>();
  const tryPlace = (q: Pt[]) => {
    const b = polyBox(q);
    const edges = frame.edgesStall.filter((e) => e.ymax >= b.ymin - params.setback - 1e-6 && e.ymin <= b.ymax + params.setback + 1e-6);
    if (!convexInside(q, edges, params.setback)) return false;
    if (traffic.some((t) => convexOverlap(q, t))) return false;
    if (grid.near(q).some((p) => convexOverlap(q, p))) return false;
    grid.add(q);
    added.push(q);
    return true;
  };

  for (const band of bandRects) {
    const [p00, p10, , p01] = band.r; // (x0,y0), (x1,y0), (x0,y1)
    const x0 = p00.x, x1 = p10.x, y0 = p00.y, y1 = p01.y;
    const width = band.vertical ? x1 - x0 : y1 - y0;
    const sides = band.vertical
      ? [
          { o: { x: x0, y: y0 }, t: { x: 0, y: 1 }, n: { x: -1, y: 0 }, len: y1 - y0 },
          { o: { x: x1, y: y0 }, t: { x: 0, y: 1 }, n: { x: 1, y: 0 }, len: y1 - y0 },
        ]
      : [
          { o: { x: x0, y: y0 }, t: { x: 1, y: 0 }, n: { x: 0, y: -1 }, len: x1 - x0 },
          { o: { x: x0, y: y1 }, t: { x: 1, y: 0 }, n: { x: 0, y: 1 }, len: x1 - x0 },
        ];
    const types: { along: number; depth: number }[] = [];
    if (band.vertical && width >= params.aisle[90] - 1e-9) types.push({ along: params.stallWidth, depth: params.stallLength });
    types.push({ along: params.parallelLength, depth: params.parallelWidth });
    for (const side of sides) {
      for (const ty of types) {
        let s = 0;
        while (s + ty.along <= side.len + 1e-9) {
          const a = { x: side.o.x + side.t.x * s, y: side.o.y + side.t.y * s };
          const b = { x: a.x + side.t.x * ty.along, y: a.y + side.t.y * ty.along };
          const q = [a, b, { x: b.x + side.n.x * ty.depth, y: b.y + side.n.y * ty.depth }, { x: a.x + side.n.x * ty.depth, y: a.y + side.n.y * ty.depth }];
          if (tryPlace(q)) {
            if (band.piece !== undefined) usedPieces.add(band.piece);
            s += ty.along;
          } else {
            s += SCAN_STEP;
          }
        }
      }
    }
  }
  return { stalls: added, pieces: usedPieces };
}
