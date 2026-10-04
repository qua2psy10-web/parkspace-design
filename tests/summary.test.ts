import { describe, expect, it } from 'vitest';
import { numberStalls, type SelectedArea } from '../src/layout/summary';
import type { Plan, Stall } from '../src/layout/generator';
import type { Pt } from '../src/geo/projection';

// 下の列: 前面 y=6（車路側が上）、上の列: 前面 y=12。車路方向は x（0°）
const lower = (x: number): Stall => ({ corners: [{ x, y: 6 }, { x: x + 2.5, y: 6 }, { x: x + 2.5, y: 0 }, { x, y: 0 }], kind: 'normal' });
const upper = (x: number): Stall => ({ corners: [{ x, y: 12 }, { x: x + 2.5, y: 12 }, { x: x + 2.5, y: 18 }, { x, y: 18 }], kind: 'normal' });
const rot = (p: Pt, deg: number): Pt => {
  const t = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(t) - p.y * Math.sin(t), y: p.x * Math.sin(t) + p.y * Math.cos(t) };
};
const area = (stalls: Stall[], direction = 0): SelectedArea => ({
  kind: 'normal',
  label: '普通車エリア',
  outer: [],
  holes: [],
  plan: { angle: 90, direction, count: stalls.length, wheelchair: 0, added: 0, stalls, aisles: [], trunks: [], arrows: [], warnings: [] } as Plan,
});
const idAt = (list: ReturnType<typeof numberStalls>, x: number, y: number) =>
  list.find((s) => Math.abs(s.center.x - x) < 1e-6 && Math.abs(s.center.y - y) < 1e-6)!.id;

describe('マス番号の並び順', () => {
  it('配列の順番がばらばらでも、列ごと・車路方向の順に番号を振る', () => {
    const shuffled = [upper(5), lower(2.5), upper(0), lower(5), lower(0), upper(2.5)];
    const list = numberStalls([area(shuffled)]);
    expect([0, 2.5, 5].map((x) => idAt(list, x + 1.25, 3))).toEqual(['1', '2', '3']);
    expect([0, 2.5, 5].map((x) => idAt(list, x + 1.25, 15))).toEqual(['4', '5', '6']);
  });

  it('手直しで最後に追加したマスも、置いた位置の番号になる', () => {
    // lower(2.5) を削除して、あとから同じ位置に追加した（配列の最後）
    const edited = [lower(0), lower(5), lower(7.5), lower(2.5)];
    const list = numberStalls([area(edited)]);
    expect([0, 2.5, 5, 7.5].map((x) => idAt(list, x + 1.25, 3))).toEqual(['1', '2', '3', '4']);
  });

  it('車路方向が 90° の案でも列ごと・車路方向の順', () => {
    const stalls = [upper(2.5), lower(0), upper(0), lower(2.5)].map((s) => ({ ...s, corners: s.corners.map((p) => rot(p, 90)) }));
    const list = numberStalls([area(stalls, 90)]);
    const c = (x: number, y: number) => rot({ x, y }, 90);
    const id = (x: number, y: number) => idAt(list, c(x, y).x, c(x, y).y);
    expect([id(1.25, 3), id(3.75, 3), id(1.25, 15), id(3.75, 15)]).toEqual(['1', '2', '3', '4']);
  });

  it('車いす用は HC の通し番号で、普通マスの番号は飛ばない', () => {
    const hc: Stall = { ...lower(2.5), kind: 'wheelchair' };
    const list = numberStalls([area([lower(5), hc, lower(0)])]);
    expect(idAt(list, 1.25, 3)).toBe('1');
    expect(idAt(list, 3.75, 3)).toBe('HC1');
    expect(idAt(list, 6.25, 3)).toBe('2');
  });
});
