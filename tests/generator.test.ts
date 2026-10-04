import { describe, expect, it } from 'vitest';
import polygonClipping from 'polygon-clipping';
import { generatePlans } from '../src/layout/generator';
import { DEFAULT_PARAMS, type LayoutParams } from '../src/layout/standards';
import { toPC } from '../src/geo/geometry';
import type { Pt } from '../src/geo/projection';

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const only90: LayoutParams = { ...DEFAULT_PARAMS, angles: [90], wheelchairCount: 0 };

function overlapArea(a: Pt[], b: Pt[]): number {
  const inter = polygonClipping.intersection([toPC(a)], [toPC(b)]);
  let s = 0;
  for (const poly of inter) for (const [i, ring] of poly.entries()) {
    let a2 = 0;
    for (let k = 0; k < ring.length - 1; k++) a2 += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
    s += (i === 0 ? 1 : -1) * Math.abs(a2 / 2);
  }
  return s;
}

describe('自動割付', () => {
  it('50m × 18m の長方形・直角駐車・出入口なし → 20台 × 2列 = 40台', () => {
    // 平面直角座標の大きな値でも誤差が出ないことも確認する
    const off = { x: -12345.6, y: 45678.9 };
    const b = rect(0, 0, 50, 18).map((p) => ({ x: p.x + off.x, y: p.y + off.y }));
    const plans = generatePlans({ boundary: b, obstacles: [], entrances: [] }, only90);
    expect(plans[0].count).toBe(40);
    expect(plans[0].direction).toBeCloseTo(0, 6);
  });

  it('傾いた長方形でも同じ台数になる', () => {
    const ang = (30 * Math.PI) / 180;
    const b = rect(0, 0, 50, 18).map((p) => ({
      x: p.x * Math.cos(ang) - p.y * Math.sin(ang),
      y: p.x * Math.sin(ang) + p.y * Math.cos(ang),
    }));
    const plans = generatePlans({ boundary: b, obstacles: [], entrances: [] }, only90);
    expect(plans[0].count).toBe(40);
  });

  it('マスは障害物・他のマスと重ならず、敷地内に収まる', () => {
    const b = rect(0, 0, 60, 40);
    const obstacle = rect(20, 10, 30, 25);
    const plans = generatePlans(
      { boundary: b, obstacles: [obstacle], entrances: [{ x: 45, y: 0 }] },
      DEFAULT_PARAMS,
    );
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans.slice(0, 4)) {
      const s = plan.stalls.map((st) => st.corners);
      for (const q of s) {
        expect(overlapArea(q, obstacle)).toBeLessThan(1e-6);
        // 敷地と重なる面積 = マス自体の面積（はみ出しなし）
        expect(overlapArea(q, b)).toBeCloseTo(overlapArea(q, q), 6);
        for (const t of plan.trunks) expect(overlapArea(q, t)).toBeLessThan(1e-6);
      }
      for (let i = 0; i < s.length; i++)
        for (let j = i + 1; j < s.length; j++) expect(overlapArea(s[i], s[j])).toBeLessThan(1e-6);
    }
  });

  it('出入口から幹線車路を通し、その分マスが減る', () => {
    const b = rect(0, 0, 50, 18);
    const withEntrance = generatePlans({ boundary: b, obstacles: [], entrances: [{ x: 25, y: 0 }] }, only90);
    const best = withEntrance.find((p) => Math.abs(p.direction) < 1e-6)!;
    // 幅6.0mの幹線車路が中央を縦断するので 2.5m マスが列あたり 3台程度減る
    expect(best.count).toBeLessThan(40);
    expect(best.count).toBeGreaterThanOrEqual(32);
    expect(best.trunks.length).toBeGreaterThan(0);
  });

  it('車いす使用者用マス（幅3.5m）を出入口の近くに配置する', () => {
    const b = rect(0, 0, 50, 18);
    const plans = generatePlans(
      { boundary: b, obstacles: [], entrances: [{ x: 0, y: 9 }] },
      { ...only90, wheelchairCount: 2 },
    );
    const plan = plans[0];
    expect(plan.wheelchair).toBe(2);
    const hc = plan.stalls.filter((s) => s.kind === 'wheelchair');
    for (const s of hc) {
      const xs = s.corners.map((p) => p.x);
      const ys = s.corners.map((p) => p.y);
      const w = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      expect(w).toBeCloseTo(3.5, 6);
    }
  });

  it('斜め駐車（60°）のマスは平行四辺形で、車両 2.5m × 6.0m が収まる奥行になる', () => {
    const b = rect(0, 0, 60, 30);
    const plans = generatePlans({ boundary: b, obstacles: [], entrances: [] }, { ...only90, angles: [60] });
    const q = plans[0].stalls[0].corners;
    const ys = q.map((p) => p.y);
    const xs = q.map((p) => p.x);
    const depth = Math.max(...ys) - Math.min(...ys);
    const t = Math.PI / 3;
    const isHoriz = Math.abs(plans[0].direction) < 1e-6;
    if (isHoriz) expect(depth).toBeCloseTo(6 * Math.sin(t) + 2.5 * Math.cos(t), 6);
    else expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(6 * Math.sin(t) + 2.5 * Math.cos(t), 6);
  });
});
