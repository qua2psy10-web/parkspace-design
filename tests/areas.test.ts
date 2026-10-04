import { describe, expect, it } from 'vitest';
import { layoutAreas } from '../src/layout/areas';
import { VEHICLE_DEFAULTS, withDefaults, type VehicleKind, type LayoutParams } from '../src/layout/standards';
import { convexInside, convexOverlap, ringsToEdges } from '../src/geo/geometry';
import type { Pt } from '../src/geo/projection';

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const params = Object.fromEntries(
  (Object.keys(VEHICLE_DEFAULTS) as VehicleKind[]).map((k) => [k, withDefaults(k)]),
) as Record<VehicleKind, LayoutParams>;

const size = (q: Pt[]) => {
  const e = (i: number) => Math.hypot(q[(i + 1) % 4].x - q[i].x, q[(i + 1) % 4].y - q[i].y);
  return [e(0), e(1)].sort((a, b) => a - b);
};

describe('エリア分割', () => {
  // 120m × 60m の敷地。東側 40m を大型車エリア、南西の一角を自転車エリア。出入口は南辺
  const boundary = rect(0, 0, 120, 60);
  const large = rect(80, 0, 120, 60);
  const bicycle = rect(0, 0, 12, 10);
  const res = layoutAreas({
    boundary,
    obstacles: [],
    entrances: [{ x: 50, y: 0 }],
    areas: [
      { kind: 'large', ring: large },
      { kind: 'bicycle', ring: bicycle },
    ],
    params,
  });
  const byKind = (k: VehicleKind) => res.filter((r) => r.kind === k);

  it('普通車・大型車・自転車のエリアがそれぞれ割付される', () => {
    for (const k of ['normal', 'large', 'bicycle'] as VehicleKind[]) {
      expect(byKind(k).length).toBe(1);
      expect(byKind(k)[0].plans.length).toBeGreaterThan(0);
      expect(byKind(k)[0].plans[0].count).toBeGreaterThan(0);
    }
  });

  it('マス寸法が車種ごとの値になる', () => {
    expect(size(byKind('large')[0].plans[0].stalls[0].corners)[0]).toBeCloseTo(3.3, 6);
    expect(size(byKind('large')[0].plans[0].stalls[0].corners)[1]).toBeCloseTo(13.0, 6);
    const cyc = byKind('bicycle')[0].plans[0].stalls.find((s) => Math.abs(size(s.corners)[0] - 0.6) < 1e-6);
    expect(cyc).toBeTruthy();
    expect(size(cyc!.corners)[1]).toBeCloseTo(1.9, 6);
  });

  it('各エリアの選んだ案のマスは自分のエリア内に収まり、全体で互いに重ならない', () => {
    const all: Pt[][] = [];
    for (const r of res) {
      const edges = ringsToEdges([r.outer, ...r.holes]);
      for (const s of r.plans[0].stalls) {
        expect(convexInside(s.corners, edges)).toBe(true);
        all.push(s.corners);
      }
    }
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) expect(convexOverlap(all[i], all[j])).toBe(false);
  });

  it('大型車エリアには普通車エリアとの境に接続口があり、普通車エリアにもその接続口から幹線車路を通す', () => {
    const lg = byKind('large')[0];
    expect(lg.entrances.length).toBe(1);
    const c = lg.entrances[0];
    expect(c.x).toBeCloseTo(80, 6); // 西側の境界線上
    const nm = byKind('normal')[0];
    expect(nm.entrances.some((e) => Math.hypot(e.x - c.x, e.y - c.y) < 1e-6)).toBe(true);
    expect(nm.entrances.some((e) => Math.hypot(e.x - 50, e.y) < 1e-6)).toBe(true);
  });

  it('バイクのマスは 1.0m × 2.3m', () => {
    const r = layoutAreas({
      boundary: rect(0, 0, 40, 30),
      obstacles: [],
      entrances: [{ x: 20, y: 0 }],
      areas: [{ kind: 'bike', ring: rect(0, 20, 40, 30) }],
      params,
    });
    const bike = r.find((x) => x.kind === 'bike')!;
    expect(bike.plans[0].count).toBeGreaterThan(0);
    const s = bike.plans[0].stalls.find((st) => Math.abs(size(st.corners)[0] - 1.0) < 1e-6)!;
    expect(size(s.corners)[1]).toBeCloseTo(2.3, 6);
  });
});
