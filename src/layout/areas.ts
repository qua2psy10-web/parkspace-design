import polygonClipping from 'polygon-clipping';
import type { Pt } from '../geo/projection';
import { type PCMulti, closestOnSegment, distToSegment, fromPC, signedArea, toPC } from '../geo/geometry';
import { generatePlans, type Plan } from './generator';
import type { LayoutParams, VehicleKind } from './standards';

/** 敷地内に描いた特別エリア（大型車・バイク・自転車） */
export interface AreaSpec {
  kind: Exclude<VehicleKind, 'normal'>;
  ring: Pt[];
}

export interface AreasInput {
  boundary: Pt[];
  obstacles: Pt[][];
  entrances: Pt[];
  areas: AreaSpec[];
  params: Record<VehicleKind, LayoutParams>;
}

/** エリア1つ分の割付結果 */
export interface AreaResult {
  kind: VehicleKind;
  /** 描いたエリアの番号（普通車エリアは -1） */
  source: number;
  /** エリアの外周と穴（平面直角座標） */
  outer: Pt[];
  holes: Pt[][];
  /** このエリアに使った出入口・接続口 */
  entrances: Pt[];
  plans: Plan[];
  warnings: string[];
}

/** 出入口が輪郭上にあるとみなす距離（m） */
const ON_EDGE = 0.5;

function ringDist(p: Pt, ring: Pt[]): number {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(p, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

function area(ring: Pt[]): number {
  return Math.abs(signedArea(ring));
}

/** 多角形群を「外周＋穴」の組に分け、小さすぎる片は捨てる */
function pieces(m: PCMulti, minArea = 1): { outer: Pt[]; holes: Pt[][] }[] {
  return m
    .map((poly) => ({ outer: fromPC(poly[0]), holes: poly.slice(1).map(fromPC) }))
    .filter((p) => area(p.outer) >= minArea);
}

/**
 * 特別エリアの接続口を求める。
 * 敷地の出入口がエリアの輪郭上にあればそれを使う。なければ、最寄りの出入口に最も近い、
 * 敷地境界ではない（他のエリアと接する）辺の上の点にする。
 * 返す法線はエリアの内側向き。
 */
function connectionPoint(ring: Pt[], boundary: Pt[], entrances: Pt[]): { pt: Pt; normal: Pt; fromSite: boolean } | null {
  if (!entrances.length) return null;
  const sign = signedArea(ring) > 0 ? 1 : -1;
  const normalOf = (a: Pt, b: Pt) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (-(b.y - a.y) / len) * sign, y: ((b.x - a.x) / len) * sign };
  };
  for (const e of entrances) {
    if (ringDist(e, ring) < ON_EDGE) {
      let best = { d: Infinity, n: { x: 0, y: 0 }, pt: e };
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const { pt } = closestOnSegment(e, a, b);
        const d = Math.hypot(pt.x - e.x, pt.y - e.y);
        if (d < best.d) best = { d, n: normalOf(a, b), pt };
      }
      return { pt: best.pt, normal: best.n, fromSite: true };
    }
  }
  let best: { d: number; pt: Pt; normal: Pt } | null = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // 敷地境界に沿った辺には接続口を置かない
    if (ringDist(mid, boundary) < 0.01) continue;
    for (const e of entrances) {
      const { pt, t } = closestOnSegment(e, a, b);
      // 辺の端ちょうどだと幹線車路がはみ出しやすいので、少し内側に寄せる
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const margin = Math.min(0.5, 4 / Math.max(len, 1e-9));
      const tt = Math.max(margin, Math.min(1 - margin, t));
      const q = len > 0 ? { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt } : pt;
      const d = Math.hypot(q.x - e.x, q.y - e.y);
      if (!best || d < best.d) best = { d, pt: q, normal: normalOf(a, b) };
    }
  }
  return best ? { pt: best.pt, normal: best.normal, fromSite: false } : null;
}

/** 敷地をエリアに分け、エリアごとに車種の寸法で割付する */
export function layoutAreas(input: AreasInput): AreaResult[] {
  const site: PCMulti = [[toPC(input.boundary)]];
  const results: AreaResult[] = [];
  const obstaclesIn = (m: PCMulti): Pt[][] =>
    input.obstacles
      .filter((o) => o.length >= 3)
      .flatMap((o) => pieces(polygonClipping.intersection(m, [[toPC(o)]]), 0.01).map((p) => p.outer));

  // 特別エリア（敷地内に切り詰め、先に描いたエリアを優先して重なりを除く）
  let taken: PCMulti = [];
  const connections: { pt: Pt; normal: Pt }[] = [];
  input.areas.forEach((a, idx) => {
    if (a.ring.length < 3) return;
    let m = polygonClipping.intersection(site, [[toPC(a.ring)]]);
    if (taken.length) m = polygonClipping.difference(m, taken);
    taken = taken.length ? polygonClipping.union(taken, m) : m;
    for (const piece of pieces(m)) {
      const warnings: string[] = [];
      const conn = connectionPoint(piece.outer, input.boundary, input.entrances);
      if (conn && !conn.fromSite) connections.push({ pt: conn.pt, normal: { x: -conn.normal.x, y: -conn.normal.y } });
      if (!conn && input.entrances.length) warnings.push('このエリアに接続口を置ける辺がありません。');
      const plans = generatePlans(
        {
          boundary: piece.outer,
          obstacles: [...piece.holes, ...obstaclesIn([[toPC(piece.outer), ...piece.holes.map(toPC)]])],
          entrances: conn ? [conn.pt] : [],
          entranceNormals: conn ? [conn.normal] : undefined,
        },
        input.params[a.kind],
      );
      results.push({ kind: a.kind, source: idx, outer: piece.outer, holes: piece.holes, entrances: conn ? [conn.pt] : [], plans, warnings });
    }
  });

  // 残りが普通車エリア。敷地の出入口と特別エリアの接続口から幹線車路を通す
  const normal = taken.length ? polygonClipping.difference(site, taken) : site;
  for (const piece of pieces(normal)) {
    const ents: Pt[] = [];
    const normals: (Pt | null)[] = [];
    for (const e of input.entrances) {
      if (ringDist(e, piece.outer) < ON_EDGE) {
        ents.push(e);
        normals.push(null);
      }
    }
    for (const c of connections) {
      if (ringDist(c.pt, piece.outer) < ON_EDGE || piece.holes.some((h) => ringDist(c.pt, h) < ON_EDGE)) {
        ents.push(c.pt);
        normals.push(c.normal);
      }
    }
    const plans = generatePlans(
      {
        boundary: piece.outer,
        obstacles: [...piece.holes, ...obstaclesIn([[toPC(piece.outer), ...piece.holes.map(toPC)]])],
        entrances: ents,
        entranceNormals: normals,
      },
      input.params.normal,
    );
    results.push({ kind: 'normal', source: -1, outer: piece.outer, holes: piece.holes, entrances: ents, plans, warnings: [] });
  }
  return results;
}
