import type { Pt } from './projection';

export type Ring = Pt[];

const EPS = 1e-7;

export function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Pt, b: Pt): Pt {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function rotate(p: Pt, ang: number): Pt {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** 符号付き面積（反時計回りで正） */
export function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function bbox(rings: Ring[]): { xmin: number; ymin: number; xmax: number; ymax: number } {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const r of rings) {
    for (const p of r) {
      if (p.x < xmin) xmin = p.x;
      if (p.y < ymin) ymin = p.y;
      if (p.x > xmax) xmax = p.x;
      if (p.y > ymax) ymax = p.y;
    }
  }
  return { xmin, ymin, xmax, ymax };
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** 線分 p-q と r-s が端点以外で交差するか（重なり・接触は除く） */
export function segmentsCross(p: Pt, q: Pt, r: Pt, s: Pt): boolean {
  const d1 = cross(r, s, p);
  const d2 = cross(r, s, q);
  const d3 = cross(p, q, r);
  const d4 = cross(p, q, s);
  return (
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
    ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
  );
}

/** 点と線分の距離 */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 線分上で点に最も近い点 */
export function closestOnSegment(p: Pt, a: Pt, b: Pt): { pt: Pt; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { pt: { x: a.x + t * dx, y: a.y + t * dy }, t };
}

/** 輪郭の辺を列挙した形（判定の高速化用） */
export interface Edge {
  a: Pt;
  b: Pt;
  ymin: number;
  ymax: number;
}

export function ringsToEdges(rings: Ring[]): Edge[] {
  const edges: Edge[] = [];
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      edges.push({ a, b, ymin: Math.min(a.y, b.y), ymax: Math.max(a.y, b.y) });
    }
  }
  return edges;
}

/** 点の内外判定（偶奇規則）。辺上は 'on' */
export function pointStatus(p: Pt, edges: Edge[]): 'in' | 'out' | 'on' {
  let inside = false;
  for (const e of edges) {
    if (distToSegment(p, e.a, e.b) < 1e-6) return 'on';
    const { a, b } = e;
    if (a.y > p.y !== b.y > p.y) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < x) inside = !inside;
    }
  }
  return inside ? 'in' : 'out';
}

/**
 * 凸多角形 poly が領域（edges で表す、穴あり可）の中に完全に入っているか。
 * 辺上に接しているのは「中」とみなす。clearance > 0 なら領域の輪郭からその距離以上離す。
 */
export function convexInside(poly: Pt[], edges: Edge[], clearance = 0): boolean {
  for (const p of poly) {
    if (pointStatus(p, edges) === 'out') return false;
  }
  const c = centroid(poly);
  if (pointStatus(c, edges) === 'out') return false;
  for (const e of edges) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      if (segmentsCross(p, q, e.a, e.b)) return false;
    }
    // 領域の頂点が図形の内側に入り込んでいないか
    if (strictlyInsideConvex(e.a, poly)) return false;
    // 辺の中点が図形の内側を通っていないか（頂点同士が一致する場合の抜け対策）
    if (strictlyInsideConvex({ x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }, poly)) return false;
  }
  if (clearance > 0) {
    for (const e of edges) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        if (distToSegment(p, e.a, e.b) < clearance - 1e-9) return false;
        if (distToSegment(e.a, p, q) < clearance - 1e-9) return false;
      }
    }
  }
  return true;
}

function strictlyInsideConvex(p: Pt, poly: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const c = cross(poly[i], poly[(i + 1) % poly.length], p);
    if (Math.abs(c) < 1e-6) return false;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function centroid(poly: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

// ---- polygon-clipping との相互変換 ----
type PCPair = [number, number];
type PCRing = PCPair[];
type PCPolygon = PCRing[];
export type PCMulti = PCPolygon[];

export function toPC(r: Ring): PCRing {
  const out: PCRing = r.map((p) => [p.x, p.y]);
  out.push([r[0].x, r[0].y]);
  return out;
}

export function fromPC(r: PCRing): Ring {
  const out = r.map(([x, y]) => ({ x, y }));
  const f = out[0];
  const l = out[out.length - 1];
  if (out.length > 1 && f.x === l.x && f.y === l.y) out.pop();
  return out;
}

/** 多角形群の全輪郭（外周・穴とも）をまとめて返す */
export function multiRings(m: PCMulti): Ring[] {
  return m.flatMap((poly) => poly.map(fromPC));
}
