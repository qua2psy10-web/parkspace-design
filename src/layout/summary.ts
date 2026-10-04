import type { Pt } from '../geo/projection';
import { signedArea } from '../geo/geometry';
import type { Plan } from './generator';
import { ANGLE_LABELS, VEHICLE_LABELS, type VehicleKind } from './standards';

/** 出力に使う、エリアごとの採用案 */
export interface SelectedArea {
  kind: VehicleKind;
  label: string;
  outer: Pt[];
  holes: Pt[][];
  plan: Plan | null;
}

export type StallClass = VehicleKind | 'wheelchair';

export const CLASS_LABELS: Record<StallClass, string> = {
  normal: '普通車',
  wheelchair: '車いす使用者用',
  large: '大型車',
  bike: 'バイク',
  bicycle: '自転車',
};

/** マス番号の接頭辞（DXF の文字は英数字のみのため） */
const PREFIX: Record<StallClass, string> = { normal: '', wheelchair: 'HC', large: 'L', bike: 'M', bicycle: 'C' };

export interface NumberedStall {
  id: string;
  cls: StallClass;
  area: string;
  corners: Pt[];
  center: Pt;
  /** 車の幅方向の寸法（m） */
  width: number;
  /** 車の長さ方向の寸法（m） */
  length: number;
}

/** エリアごとの表示名（普通車エリア 1、大型車エリア 1 …） */
export function areaLabels(kinds: VehicleKind[]): string[] {
  const n: Partial<Record<VehicleKind, number>> = {};
  const total: Partial<Record<VehicleKind, number>> = {};
  kinds.forEach((k) => (total[k] = (total[k] ?? 0) + 1));
  return kinds.map((k) => {
    n[k] = (n[k] ?? 0) + 1;
    return total[k]! > 1 ? `${VEHICLE_LABELS[k]}エリア ${n[k]}` : `${VEHICLE_LABELS[k]}エリア`;
  });
}

/** 全エリアのマスに、種類ごとの通し番号をつける */
export function numberStalls(areas: SelectedArea[]): NumberedStall[] {
  const counter: Partial<Record<StallClass, number>> = {};
  const out: NumberedStall[] = [];
  for (const a of areas) {
    for (const s of a.plan?.stalls ?? []) {
      const cls: StallClass = s.kind === 'wheelchair' ? 'wheelchair' : a.kind;
      counter[cls] = (counter[cls] ?? 0) + 1;
      const q = s.corners;
      const side = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
      const front = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
      const ar = Math.abs(signedArea(q));
      // 長さは車の向き（前面から奥への辺）、幅は面積 ÷ 長さ（斜めマスでも車の幅になる）
      const length = side;
      const width = side > 0 ? ar / side : front;
      out.push({
        id: `${PREFIX[cls]}${counter[cls]}`,
        cls,
        area: a.label,
        corners: q,
        center: { x: q.reduce((t, p) => t + p.x, 0) / q.length, y: q.reduce((t, p) => t + p.y, 0) / q.length },
        width,
        length,
      });
    }
  }
  return out;
}

/** マスの外周延長（隣り合うマスで共有する辺は1回だけ数える, m） */
export function outlineLength(stalls: Pt[][]): number {
  const key = (p: Pt) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
  const seen = new Set<string>();
  let total = 0;
  for (const q of stalls) {
    for (let i = 0; i < q.length; i++) {
      const a = q[i];
      const b = q[(i + 1) % q.length];
      const ka = key(a);
      const kb = key(b);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(k)) continue;
      seen.add(k);
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return total;
}

export interface Summary {
  counts: Record<StallClass, number>;
  total: number;
  outline: Record<StallClass, number>;
  areas: { label: string; kind: VehicleKind; area: number; method: string; direction: string; count: number }[];
}

export function summarize(areas: SelectedArea[]): Summary {
  const stalls = numberStalls(areas);
  const counts: Record<StallClass, number> = { normal: 0, wheelchair: 0, large: 0, bike: 0, bicycle: 0 };
  const byCls: Record<StallClass, Pt[][]> = { normal: [], wheelchair: [], large: [], bike: [], bicycle: [] };
  for (const s of stalls) {
    counts[s.cls]++;
    byCls[s.cls].push(s.corners);
  }
  const outline = Object.fromEntries(
    (Object.keys(byCls) as StallClass[]).map((k) => [k, outlineLength(byCls[k])]),
  ) as Record<StallClass, number>;
  return {
    counts,
    total: stalls.length,
    outline,
    areas: areas.map((a) => ({
      label: a.label,
      kind: a.kind,
      area: Math.abs(signedArea(a.outer)) - a.holes.reduce((t, h) => t + Math.abs(signedArea(h)), 0),
      method: a.plan ? ANGLE_LABELS[a.plan.angle] : '—',
      direction: a.plan ? `${a.plan.direction.toFixed(1)}°` : '—',
      count: a.plan?.count ?? 0,
    })),
  };
}
