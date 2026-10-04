import { describe, expect, it } from 'vitest';
import { makeProjection } from '../src/geo/projection';

describe('平面直角座標変換', () => {
  it('IX系の原点は (0, 0) になる', () => {
    const pj = makeProjection(9);
    const p = pj.toPlane({ lat: 36, lng: 139 + 50 / 60 });
    expect(Math.abs(p.x)).toBeLessThan(1e-6);
    expect(Math.abs(p.y)).toBeLessThan(1e-6);
  });

  it('原点から真北へ緯度1分 ≒ 1849m（GRS80, 縮尺係数0.9999）', () => {
    const pj = makeProjection(9);
    const p = pj.toPlane({ lat: 36 + 1 / 60, lng: 139 + 50 / 60 });
    expect(Math.abs(p.x)).toBeLessThan(1e-3);
    expect(p.y).toBeGreaterThan(1848.5);
    expect(p.y).toBeLessThan(1849.5);
  });

  it('往復変換で元に戻る（筑西市付近）', () => {
    const pj = makeProjection(9);
    const ll = { lat: 36.3069, lng: 139.9831 };
    const back = pj.toLatLng(pj.toPlane(ll));
    expect(Math.abs(back.lat - ll.lat)).toBeLessThan(1e-9);
    expect(Math.abs(back.lng - ll.lng)).toBeLessThan(1e-9);
  });
});
