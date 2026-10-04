import { describe, expect, it } from 'vitest';
import { addStallAt, deleteStalls, type EditArea, findConflicts, moveStalls, rowOf } from '../src/edit/stallEditor';
import type { Stall } from '../src/layout/generator';
import type { Pt } from '../src/geo/projection';

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
// 下の列: 前面が y=6（車路側が上）、上の列: 前面が y=12（車路側が下）。車路は y=6〜12
const lower = (x: number): Stall => ({ corners: [{ x, y: 6 }, { x: x + 2.5, y: 6 }, { x: x + 2.5, y: 0 }, { x, y: 0 }], kind: 'normal' });
const upper = (x: number): Stall => ({ corners: [{ x, y: 12 }, { x: x + 2.5, y: 12 }, { x: x + 2.5, y: 18 }, { x, y: 18 }], kind: 'normal' });
const area: EditArea = { outer: rect(0, 0, 30, 18), holes: [], blockers: [rect(0, 6, 30, 12)] };
const stalls = (): Stall[] => [lower(0), lower(2.5), lower(5), upper(0), upper(2.5)];

describe('マスの手直し', () => {
  it('列の判定: 前面が同一直線上で同じ向きのマスだけを列とする', () => {
    expect(rowOf(stalls(), 1)).toEqual([0, 1, 2]);
    expect(rowOf(stalls(), 3)).toEqual([3, 4]);
  });

  it('削除', () => {
    const s = deleteStalls(stalls(), [0, 4]);
    expect(s.length).toBe(3);
    expect(s[0].corners[0].x).toBe(2.5);
  });

  it('追加: クリックした側の隣に同じ形のマスを置く', () => {
    const r = addStallAt(area, stalls(), { x: 8.6, y: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stall.corners[0]).toEqual({ x: 7.5, y: 6 });
  });

  it('追加: 列の途中の隙間をクリックすると、その隙間を埋める', () => {
    const r = addStallAt(area, [lower(0), lower(5)], { x: 3.6, y: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stall.corners[0].x).toBeCloseTo(2.5, 9);
  });

  it('追加: 指した位置が埋まっていれば、同じ向きの先の空きに置く', () => {
    // 手本 lower(0) から右へ1つ目（2.5）は埋まっているので 5.0 に置く
    const r = addStallAt(area, [lower(0), lower(2.5)], { x: 2.4, y: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stall.corners[0].x).toBeCloseTo(5, 9);
  });

  it('追加: エリアの外にはみ出す位置は拒否する', () => {
    const r = addStallAt({ ...area, outer: rect(0, 0, 9, 18) }, stalls(), { x: 8.8, y: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('はみ出');
  });

  it('移動: 列ごと動かし、重なり・はみ出しを検出する', () => {
    const ids = rowOf(stalls(), 0);
    const ok = moveStalls(area, stalls(), ids, { x: 1, y: 0 });
    expect(ok.stalls[0].corners[0].x).toBe(1);
    expect(ok.conflicts).toEqual([]);
    const bad = moveStalls(area, stalls(), ids, { x: 0, y: 1 }); // 車路にはみ出す
    expect(bad.conflicts.length).toBe(3);
    expect(findConflicts(area, bad.stalls).sort()).toEqual([0, 1, 2]);
  });
});
