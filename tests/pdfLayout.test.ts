import { describe, expect, it } from 'vitest';
import { affineFrom3, applyAffine, lngLatToPixel, pageLayout, pickScale, scaleBarLength } from '../src/export/pdfLayout';

describe('PDF の割付', () => {
  it('A3 横で 120m × 60m の敷地は 1/500 になる', () => {
    expect(pickScale(120, 60, 'A3')).toEqual({ scale: 500, fits: true });
  });

  it('A1 なら同じ敷地をより大きい縮尺（1/200、作図幅 約671mm に 600mm）で描ける', () => {
    expect(pickScale(120, 60, 'A1').scale).toBe(200);
  });

  it('どの縮尺にも収まらないときは最小の縮尺で fits = false', () => {
    expect(pickScale(5000, 3000, 'A4')).toEqual({ scale: 2500, fits: false });
  });

  it('作図範囲は図枠の内側で右欄と重ならない', () => {
    const L = pageLayout('A3');
    expect(L.drawing.x + L.drawing.w).toBeLessThan(L.side.x);
    expect(L.drawing.y + L.drawing.h).toBeLessThan(L.frame.y + L.frame.h);
  });

  it('スケールバーは紙の上で 30mm 以上', () => {
    expect(scaleBarLength(500)).toBe(20); // 20m → 40mm
    expect((scaleBarLength(1000) * 1000) / 1000).toBeGreaterThanOrEqual(30);
  });
});

describe('背景写真の位置合わせ', () => {
  it('3点の対応から作ったアフィン変換が、3点とも正しく写す', () => {
    const src = [{ x: 0, y: 0 }, { x: 100, y: 5 }, { x: -3, y: 80 }] as const;
    const dst = [{ x: 10, y: 20 }, { x: 210, y: 30 }, { x: 4, y: 180 }] as const;
    const m = affineFrom3([...src] as never, [...dst] as never);
    src.forEach((p, i) => {
      const q = applyAffine(m, p);
      expect(q.x).toBeCloseTo(dst[i].x, 9);
      expect(q.y).toBeCloseTo(dst[i].y, 9);
    });
  });

  it('Web メルカトルの画素座標: ズーム0で経度0・緯度0は (128, 128)', () => {
    const p = lngLatToPixel(0, 0, 0);
    expect(p.x).toBeCloseTo(128, 9);
    expect(p.y).toBeCloseTo(128, 9);
  });
});
