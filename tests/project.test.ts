import { describe, expect, it } from 'vitest';
import { emptyProject, fileBaseName, parseProject, serializeProject } from '../src/project';
import { VEHICLE_DEFAULTS } from '../src/layout/standards';
import { outlineLength } from '../src/layout/summary';

describe('案件ファイル', () => {
  it('保存→読込で内容が一致する', () => {
    const p = emptyProject();
    p.name = '○○店駐車場';
    p.zone = 9;
    p.site.boundary = [{ lat: 36.3, lng: 139.98 }, { lat: 36.301, lng: 139.98 }, { lat: 36.301, lng: 139.981 }];
    p.site.entrances = [{ lat: 36.3005, lng: 139.98 }];
    p.site.areas = [{ kind: 'bicycle', ring: p.site.boundary.slice() }];
    p.params.large.stallLength = 12.0;
    p.view = { center: { lat: 36.3, lng: 139.98 }, zoom: 19 };
    const back = parseProject(JSON.parse(serializeProject(p)));
    expect(back).toEqual(p);
  });

  it('第1段階のブラウザ自動保存（形式名なし）も読める', () => {
    const legacy = {
      zone: 9,
      site: { boundary: [{ lat: 1, lng: 2 }, { lat: 1, lng: 3 }, { lat: 2, lng: 3 }], obstacles: [], entrances: [] },
      params: { ...VEHICLE_DEFAULTS.normal, stallWidth: 2.6 },
      baseLayer: 'gsi_photo',
    };
    const p = parseProject(legacy);
    expect(p.site.boundary.length).toBe(3);
    expect(p.site.areas).toEqual([]);
    expect(p.params.normal.stallWidth).toBe(2.6);
    expect(p.params.large.stallLength).toBe(13.0);
  });

  it('別の形式のファイルは読み込まない', () => {
    expect(() => parseProject({ format: 'other' })).toThrow();
    expect(() => parseProject([1, 2])).toThrow();
  });

  it('ファイル名に使えない文字を除く', () => {
    expect(fileBaseName(' A/B:C ')).toBe('A_B_C');
    expect(fileBaseName('')).toBe('parking');
  });
});

describe('区画外周延長', () => {
  it('2.5m×6.0m のマスが2つ並ぶと共有辺1本を除いて 2×(2×2.5+2×6.0) − 6.0 = 28.0m', () => {
    const q1 = [{ x: 0, y: 0 }, { x: 2.5, y: 0 }, { x: 2.5, y: 6 }, { x: 0, y: 6 }];
    const q2 = [{ x: 2.5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 6 }, { x: 2.5, y: 6 }];
    expect(outlineLength([q1, q2])).toBeCloseTo(28.0, 9);
  });
});
