import { describe, expect, it } from 'vitest';
import { generatePlans, type Plan } from '../src/layout/generator';
import { DEFAULT_PARAMS, type LayoutParams } from '../src/layout/standards';
import { convexInside, convexOverlap, ringsToEdges } from '../src/geo/geometry';
import type { Pt } from '../src/geo/projection';

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const base: LayoutParams = { ...DEFAULT_PARAMS, angles: [90], wheelchairCount: 0, loopAisles: false, infill: false };

/** 全マスが敷地内・障害物外で、互いに重ならないこと */
function expectValid(plan: Plan, boundary: Pt[], obstacles: Pt[][] = []) {
  const edges = ringsToEdges([boundary]);
  const s = plan.stalls.map((st) => st.corners);
  for (const q of s) {
    expect(convexInside(q, edges)).toBe(true);
    for (const o of obstacles) expect(convexOverlap(q, o)).toBe(false);
  }
  for (let i = 0; i < s.length; i++)
    for (let j = i + 1; j < s.length; j++) expect(convexOverlap(s[i], s[j])).toBe(false);
}

describe('自動割付', () => {
  it('50m × 18m の長方形・直角駐車・出入口なし → 20台 × 2列 = 40台', () => {
    // 平面直角座標の大きな値でも誤差が出ないことも確認する
    const off = { x: -12345.6, y: 45678.9 };
    const b = rect(0, 0, 50, 18).map((p) => ({ x: p.x + off.x, y: p.y + off.y }));
    const plans = generatePlans({ boundary: b, obstacles: [], entrances: [] }, base);
    expect(plans[0].count).toBe(40);
    expect(plans[0].direction).toBeCloseTo(0, 6);
  });

  it('傾いた長方形でも同じ台数になる', () => {
    const ang = (30 * Math.PI) / 180;
    const b = rect(0, 0, 50, 18).map((p) => ({
      x: p.x * Math.cos(ang) - p.y * Math.sin(ang),
      y: p.x * Math.sin(ang) + p.y * Math.cos(ang),
    }));
    const plans = generatePlans({ boundary: b, obstacles: [], entrances: [] }, base);
    expect(plans[0].count).toBe(40);
  });

  it('全機能を有効にしても、マスは障害物・他のマスと重ならず敷地内に収まる', () => {
    const b = rect(0, 0, 60, 40);
    const obstacle = rect(20, 10, 30, 25);
    const plans = generatePlans({ boundary: b, obstacles: [obstacle], entrances: [{ x: 45, y: 0 }] }, DEFAULT_PARAMS);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expectValid(plan, b, [obstacle]);
      const stalls = plan.stalls.map((s) => s.corners);
      for (const q of stalls) for (const t of plan.trunks) expect(convexOverlap(q, t)).toBe(false);
    }
  });

  it('出入口から幹線車路を通し、その分マスが減る', () => {
    const b = rect(0, 0, 50, 18);
    const plans = generatePlans({ boundary: b, obstacles: [], entrances: [{ x: 25, y: 0 }] }, base);
    const best = plans.find((p) => Math.abs(p.direction) < 1e-6)!;
    expect(best.count).toBeLessThan(40);
    expect(best.count).toBeGreaterThanOrEqual(32);
    expect(best.trunks.length).toBeGreaterThan(0);
  });

  it('車いす使用者用マス（幅3.5m）を出入口の近くに配置する', () => {
    const b = rect(0, 0, 50, 18);
    const plans = generatePlans({ boundary: b, obstacles: [], entrances: [{ x: 0, y: 9 }] }, { ...base, wheelchairCount: 2 });
    const plan = plans[0];
    expect(plan.wheelchair).toBe(2);
    for (const s of plan.stalls.filter((s) => s.kind === 'wheelchair')) {
      const xs = s.corners.map((p) => p.x);
      const ys = s.corners.map((p) => p.y);
      const w = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      expect(w).toBeCloseTo(3.5, 6);
    }
  });

  it('斜め駐車（60°）のマスは平行四辺形で、車両 2.5m × 6.0m が収まる奥行になる', () => {
    const b = rect(0, 0, 60, 30);
    const plans = generatePlans({ boundary: b, obstacles: [], entrances: [] }, { ...base, angles: [60] });
    const plan = plans.find((p) => Math.abs(p.direction) < 1e-6)!;
    const q = plan.stalls[0].corners;
    const ys = q.map((p) => p.y);
    const t = Math.PI / 3;
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6 * Math.sin(t) + 2.5 * Math.cos(t), 6);
  });
});

describe('割付の質の改善', () => {
  // 車路が東西方向に3本並ぶ敷地（60m × 54m）。出入口は西辺の中ほど
  const site = { boundary: rect(0, 0, 60, 54), obstacles: [] as Pt[][], entrances: [{ x: 60, y: 27 }] };
  const eastWest = (plans: Plan[]) => plans.find((p) => Math.abs(p.direction) < 1e-6)!;

  it('周回車路を有効にすると行き止まりの警告が消える', () => {
    const p = { ...base, wheelchairCount: 0 };
    const off = eastWest(generatePlans({ ...site, entrances: [{ x: 30, y: 0 }] }, { ...p, loopAisles: false }));
    const on = eastWest(generatePlans({ ...site, entrances: [{ x: 30, y: 0 }] }, { ...p, loopAisles: true }));
    expect(off.warnings.some((w) => w.includes('行き止まり'))).toBe(true);
    expect(on.warnings.some((w) => w.includes('行き止まり'))).toBe(false);
    expect(on.aisles.length).toBeGreaterThan(off.aisles.length);
    expectValid(on, site.boundary);
  });

  it('斜め駐車では隣り合う車路の通行方向が逆で、マスの傾きが通行方向に合う', () => {
    const plan = eastWest(generatePlans(site, { ...base, angles: [60], loopAisles: true }));
    expect(plan.arrows.length).toBeGreaterThan(0);
    // 車路の y ごとに矢印の向き（x の符号）をまとめる
    const byY = new Map<number, number>();
    for (const a of plan.arrows) byY.set(Math.round(a.from.y * 10) / 10, Math.sign(a.to.x - a.from.x));
    const dirs = [...byY.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < dirs.length; i++) expect(dirs[i]).toBe(-dirs[i - 1]);
    // 各マス: 車路側（前面）の辺から奥側の辺へのずれが、面する車路の通行方向と同じ向き
    for (const s of plan.stalls.filter((s) => s.kind === 'normal').slice(0, 30)) {
      const [f0, , , b0] = s.corners;
      const shift = b0.x - f0.x;
      if (Math.abs(shift) < 1e-6) continue; // 余白に追加した直角・縦列マス
      const aisleY = [...byY.keys()].reduce((a, c) => (Math.abs(c - f0.y) < Math.abs(a - f0.y) ? c : a));
      expect(Math.sign(shift)).toBe(byY.get(aisleY));
    }
    expectValid(plan, site.boundary);
  });

  it('斜め駐車（60°）の案にも車いす使用者用マスを出入口近くに置く', () => {
    const plan = eastWest(generatePlans(site, { ...base, angles: [60], wheelchairCount: 1 }));
    expect(plan.wheelchair).toBe(1);
    const hc = plan.stalls.find((s) => s.kind === 'wheelchair')!;
    const xs = hc.corners.map((p) => p.x);
    const ys = hc.corners.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3.5, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6.0, 6);
    // 出入口（東辺 x=60）に近い側にある
    expect(Math.min(...xs)).toBeGreaterThan(40);
    expectValid(plan, site.boundary);
  });

  it('余白への追加で台数が減らず、重なりも出ない', () => {
    const b = [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 45 }, { x: 0, y: 38 }];
    const s = { boundary: b, obstacles: [rect(30, 15, 38, 22)], entrances: [{ x: 70, y: 20 }] };
    const all = { ...DEFAULT_PARAMS, wheelchairCount: 1 };
    const off = generatePlans(s, { ...all, infill: false });
    const on = generatePlans(s, { ...all, infill: true });
    expect(on[0].count).toBeGreaterThanOrEqual(off[0].count);
    for (const p of on) expectValid(p, b, s.obstacles);
  });
});
