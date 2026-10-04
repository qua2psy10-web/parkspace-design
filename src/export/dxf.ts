import type { Pt } from '../geo/projection';
import type { Plan } from '../layout/generator';

/**
 * DXF（R12, AC1009）を書き出す。座標は平面直角座標（m）、
 * 作図の X = 東方向（測量のY）、Y = 北方向（測量のX）。
 * 文字は互換性のため英数字のみとする。
 */

const LAYERS: { name: string; color: number }[] = [
  { name: 'BOUNDARY', color: 1 }, // 敷地境界（赤）
  { name: 'OBSTACLE', color: 8 }, // 障害物（灰）
  { name: 'STALL', color: 7 }, // 駐車マス（白/黒）
  { name: 'STALL_HC', color: 5 }, // 車いす使用者用（青）
  { name: 'AISLE', color: 3 }, // 車路（緑）
  { name: 'TRUNK', color: 4 }, // 幹線車路（水色）
  { name: 'ENTRANCE', color: 6 }, // 出入口（紫）
  { name: 'TEXT', color: 2 }, // 文字（黄）
];

export interface DxfInput {
  boundary: Pt[];
  obstacles: Pt[][];
  entrances: { a: Pt; b: Pt }[];
  plan: Plan;
  zoneLabel: string;
}

const ANGLE_ASCII: Record<number, string> = { 90: '90DEG', 60: '60DEG', 45: '45DEG', 0: 'PARALLEL' };

export function buildDxf(input: DxfInput): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => {
    out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  };

  const all = [input.boundary, ...input.plan.stalls.map((s) => s.corners)].flat();
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);

  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$EXTMIN');
  g(10, Math.min(...xs));
  g(20, Math.min(...ys));
  g(9, '$EXTMAX');
  g(10, Math.max(...xs));
  g(20, Math.max(...ys));
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, LAYERS.length);
  for (const l of LAYERS) {
    g(0, 'LAYER');
    g(2, l.name);
    g(70, 0);
    g(62, l.color);
    g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');

  const poly = (layer: string, pts: Pt[], closed = true) => {
    g(0, 'POLYLINE');
    g(8, layer);
    g(66, 1);
    g(10, 0);
    g(20, 0);
    g(30, 0);
    g(70, closed ? 1 : 0);
    for (const p of pts) {
      g(0, 'VERTEX');
      g(8, layer);
      g(10, p.x);
      g(20, p.y);
      g(30, 0);
    }
    g(0, 'SEQEND');
    g(8, layer);
  };
  const text = (layer: string, p: Pt, h: number, s: string) => {
    g(0, 'TEXT');
    g(8, layer);
    g(10, p.x);
    g(20, p.y);
    g(30, 0);
    g(40, h);
    g(1, s);
    g(72, 1);
    g(73, 2);
    g(11, p.x);
    g(21, p.y);
    g(31, 0);
  };

  poly('BOUNDARY', input.boundary);
  for (const o of input.obstacles) poly('OBSTACLE', o);
  for (const r of input.plan.aisles) poly('AISLE', r);
  for (const r of input.plan.trunks) poly('TRUNK', r);
  for (const e of input.entrances) poly('ENTRANCE', [e.a, e.b], false);

  input.plan.stalls.forEach((s, i) => {
    const layer = s.kind === 'wheelchair' ? 'STALL_HC' : 'STALL';
    poly(layer, s.corners);
    const c = {
      x: s.corners.reduce((a, p) => a + p.x, 0) / s.corners.length,
      y: s.corners.reduce((a, p) => a + p.y, 0) / s.corners.length,
    };
    text('TEXT', c, 0.5, s.kind === 'wheelchair' ? `HC${i + 1}` : String(i + 1));
  });

  const title = {
    x: Math.min(...xs),
    y: Math.max(...ys) + 3,
  };
  const p = input.plan;
  g(0, 'TEXT');
  g(8, 'TEXT');
  g(10, title.x);
  g(20, title.y);
  g(30, 0);
  g(40, 1.5);
  g(1, `PARKING ${ANGLE_ASCII[p.angle]}  TOTAL ${p.count}  HC ${p.wheelchair}  JGD2011 ZONE ${input.zoneLabel}`);

  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(6);
}

