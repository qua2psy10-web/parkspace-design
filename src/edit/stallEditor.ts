import type { Pt } from '../geo/projection';
import { centroid, convexInside, convexOverlap, polyOverlap, ringsToEdges } from '../geo/geometry';
import type { Stall } from '../layout/generator';

/**
 * マスの手直し（削除・追加・移動）の計算。地図からは切り離してある。
 * マスの頂点は [前面左, 前面右, 奥右, 奥左]（前面＝車路側）の順。
 */

/** 編集の対象になるエリア（外周・穴）と、マスを置いてはいけない車路など */
export interface EditArea {
  outer: Pt[];
  holes: Pt[][];
  /** 車路・幹線車路など（凹形でもよい） */
  blockers: Pt[][];
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt): Pt => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};

/** マスの前面方向（列の向き）の単位ベクトル */
export function rowDir(s: Stall): Pt {
  return unit(sub(s.corners[1], s.corners[0]));
}

/** マスの前面から奥へ向かう単位ベクトル（前面に直角） */
export function backDir(s: Stall): Pt {
  const u = rowDir(s);
  const n = { x: -u.y, y: u.x };
  return dot(sub(s.corners[3], s.corners[0]), n) >= 0 ? n : { x: -n.x, y: -n.y };
}

/** マスの奥行（前面に直角な方向, m） */
function depthOf(s: Stall): number {
  return Math.abs(dot(sub(s.corners[3], s.corners[0]), backDir(s)));
}

/**
 * i 番目のマスと同じ列のマスの番号。
 * 前面の辺が同一直線上（向き1°以内・距離5cm以内）で、奥の向きと奥行が同じものを列とみなす。
 */
export function rowOf(stalls: Stall[], i: number): number[] {
  const s = stalls[i];
  const u = rowDir(s);
  const b = backDir(s);
  const d = depthOf(s);
  const sin1 = Math.sin((1 * Math.PI) / 180);
  return stalls
    .map((t, j) => ({ t, j }))
    .filter(({ t }) => {
      const ut = rowDir(t);
      if (Math.abs(u.x * ut.y - u.y * ut.x) > sin1) return false;
      if (Math.abs(dot(sub(t.corners[0], s.corners[0]), b)) > 0.05) return false;
      if (dot(backDir(t), b) < 0.99) return false;
      return Math.abs(depthOf(t) - d) < 0.05;
    })
    .map(({ j }) => j);
}

export function deleteStalls(stalls: Stall[], ids: Iterable<number>): Stall[] {
  const del = new Set(ids);
  return stalls.filter((_, i) => !del.has(i));
}

function inside(area: EditArea, q: Pt[]): boolean {
  return convexInside(q, ringsToEdges([area.outer, ...area.holes]));
}

/** マス q が置けない理由（置けるなら null） */
function problem(area: EditArea, others: Stall[], q: Pt[]): string | null {
  if (!inside(area, q)) return 'エリアの外にはみ出します。';
  if (others.some((o) => convexOverlap(q, o.corners))) return '他のマスと重なります。';
  if (area.blockers.some((b) => polyOverlap(q, b))) return '車路と重なります。';
  return null;
}

export type AddResult = { ok: true; stall: Stall } | { ok: false; reason: string };

/**
 * クリック点 p の近くにマスを追加する。
 * 近くの普通マス（なければ最も近いマス）を手本にし、その列の方向でクリック点に最も近い
 * 「マス何個分か隣」の位置に同じ形で置く。そこが埋まっていれば、同じ向きにさらに先を最大3つまで試す。
 */
export function addStallAt(area: EditArea, stalls: Stall[], p: Pt): AddResult {
  if (!stalls.length) return { ok: false, reason: '手本にするマスがありません。' };
  const dist = (s: Stall) => len(sub(centroid(s.corners), p));
  const nearest = stalls.reduce((a, b) => (dist(a) < dist(b) ? a : b));
  // 車いす用は幅が違うので、同じ列の普通マスがあればそれを手本にする
  const row = rowOf(stalls, stalls.indexOf(nearest)).map((i) => stalls[i]);
  const normals = row.filter((s) => s.kind !== 'wheelchair');
  const tpl = nearest.kind === 'wheelchair' && normals.length ? normals.reduce((a, b) => (dist(a) < dist(b) ? a : b)) : nearest;
  const front = sub(tpl.corners[1], tpl.corners[0]);
  const pitch = len(front);
  const u = unit(front);
  const along = dot(sub(p, centroid(tpl.corners)), u);
  const sign = along >= 0 ? 1 : -1;
  let k = Math.round(along / pitch);
  if (k === 0) k = sign;
  let reason = '';
  for (let tries = 0; tries < 4; tries++, k += sign) {
    const corners = tpl.corners.map((c) => ({ x: c.x + u.x * pitch * k, y: c.y + u.y * pitch * k }));
    const why = problem(area, stalls, corners);
    if (!why) return { ok: true, stall: { corners, kind: 'normal' } };
    reason = why;
    // 他のマスと重なるときだけ先へ進める（はみ出し・車路はそれ以上進んでも解決しない）
    if (why !== '他のマスと重なります。') break;
  }
  return { ok: false, reason };
}

/** ids のマスを (dx, dy) だけ動かし、動かした後で問題のあるマスの番号を返す */
export function moveStalls(area: EditArea, stalls: Stall[], ids: Iterable<number>, d: Pt): { stalls: Stall[]; conflicts: number[] } {
  const set = new Set(ids);
  const moved = stalls.map((s, i) => (set.has(i) ? { ...s, corners: s.corners.map((c) => ({ x: c.x + d.x, y: c.y + d.y })) } : s));
  const conflicts: number[] = [];
  for (const i of set) {
    const others = moved.filter((_, j) => j !== i);
    if (problem(area, others, moved[i].corners)) conflicts.push(i);
  }
  return { stalls: moved, conflicts };
}

/** 問題のあるマスの番号（表示用） */
export function findConflicts(area: EditArea, stalls: Stall[]): number[] {
  return stalls.map((s, i) => (problem(area, stalls.filter((_, j) => j !== i), s.corners) ? i : -1)).filter((i) => i >= 0);
}
