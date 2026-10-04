/**
 * 駐車方式。数値は車路に対する駐車角度（度）、0 は縦列（平行）駐車。
 */
export type AngleType = 90 | 60 | 45 | 0;

export const ANGLE_LABELS: Record<AngleType, string> = {
  90: '直角（90°）',
  60: '斜め（60°）',
  45: '斜め（45°）',
  0: '縦列',
};

export interface LayoutParams {
  /** 普通乗用車の駐車マス 幅（m） */
  stallWidth: number;
  /** 普通乗用車の駐車マス 奥行（m） */
  stallLength: number;
  /** 縦列駐車マス 長さ（車路方向, m） */
  parallelLength: number;
  /** 縦列駐車マス 幅（m） */
  parallelWidth: number;
  /** 駐車方式ごとの車路幅（m） */
  aisle: Record<AngleType, number>;
  /** 出入口からの幹線車路の幅（対面通行, m） */
  trunkWidth: number;
  /** 出入口の幅（m） */
  entranceWidth: number;
  /** 車いす使用者用マスの台数 */
  wheelchairCount: number;
  /** 車いす使用者用マスの幅（m） */
  wheelchairWidth: number;
  /** 敷地境界・障害物からマスまでの離れ（m） */
  setback: number;
  /** 試算する駐車方式 */
  angles: AngleType[];
  /** 車路の両端を連絡車路でつなぎ、行き止まりをなくす */
  loopAisles: boolean;
  /** 幹線車路・連絡車路・車路沿いの余白にマスを追加する */
  infill: boolean;
}

/**
 * 初期値。
 * - マス寸法: 駐車場設計・施工指針（日本道路協会）の普通乗用車 2.5m × 6.0m
 * - 車いす使用者用: 幅 3.5m（高齢者、障害者等の移動等の円滑化の促進に関する法律の建築物移動等円滑化基準）
 * - 車路幅: 直角駐車は対面通行 6.0m、斜め駐車・縦列は一方通行を想定した値
 * 角度別の車路幅と縦列マス寸法は、案件ごとに指針の表・発注者基準と照合して画面で修正すること。
 */
export const DEFAULT_PARAMS: LayoutParams = {
  stallWidth: 2.5,
  stallLength: 6.0,
  parallelLength: 7.0,
  parallelWidth: 2.5,
  aisle: { 90: 6.0, 60: 4.5, 45: 3.5, 0: 3.5 },
  trunkWidth: 6.0,
  entranceWidth: 6.0,
  wheelchairCount: 1,
  wheelchairWidth: 3.5,
  setback: 0,
  angles: [90, 60, 45, 0],
  loopAisles: true,
  infill: true,
};

/** 駐車方式ごとのマス形状（車路方向のピッチと、車路に直角な奥行） */
export interface StallShape {
  /** 車路方向のピッチ（m） */
  pitch: number;
  /** 車路に直角な方向の奥行（m） */
  depth: number;
  /** 奥側の辺が車路方向にずれる量（斜め駐車の平行四辺形, m） */
  shift: number;
}

/**
 * 幅 W・奥行 L の車両長方形を角度 θ で並べるときの平行四辺形マス。
 * ピッチ = W / sinθ、奥行 = L·sinθ + W·cosθ（車両長方形が平行四辺形に収まる）
 */
export function stallShape(angle: AngleType, p: LayoutParams, width = p.stallWidth): StallShape {
  if (angle === 0) {
    return { pitch: p.parallelLength, depth: p.parallelWidth, shift: 0 };
  }
  if (angle === 90) {
    return { pitch: width, depth: p.stallLength, shift: 0 };
  }
  const t = (angle * Math.PI) / 180;
  const depth = p.stallLength * Math.sin(t) + width * Math.cos(t);
  const side = depth / Math.sin(t);
  return { pitch: width / Math.sin(t), depth, shift: side * Math.cos(t) };
}

/** 車種 */
export type VehicleKind = 'normal' | 'large' | 'bike' | 'bicycle';

export const VEHICLE_KINDS: VehicleKind[] = ['normal', 'large', 'bike', 'bicycle'];

export const VEHICLE_LABELS: Record<VehicleKind, string> = {
  normal: '普通車',
  large: '大型車',
  bike: 'バイク',
  bicycle: '自転車',
};

/**
 * 車種別の初期値。
 * - 大型車: マス 3.3m × 13.0m（駐車場設計・施工指針の大型バス・普通貨物車）
 * - バイク: マス 1.0m × 2.3m（同指針の自動二輪車）
 * - 自転車: マス 0.6m × 1.9m
 * 大型車の角度別車路幅、二輪の通路幅・幹線車路幅は一般的な目安の値。案件の基準と照合して画面で修正すること。
 */
export const VEHICLE_DEFAULTS: Record<VehicleKind, LayoutParams> = {
  normal: DEFAULT_PARAMS,
  large: {
    ...DEFAULT_PARAMS,
    stallWidth: 3.3,
    stallLength: 13.0,
    parallelLength: 17.0,
    parallelWidth: 3.3,
    aisle: { 90: 13.0, 60: 10.0, 45: 8.0, 0: 5.0 },
    trunkWidth: 8.0,
    entranceWidth: 8.0,
    wheelchairCount: 0,
    angles: [90, 60, 45],
  },
  bike: {
    ...DEFAULT_PARAMS,
    stallWidth: 1.0,
    stallLength: 2.3,
    parallelLength: 2.3,
    parallelWidth: 1.0,
    aisle: { 90: 2.5, 60: 2.0, 45: 2.0, 0: 2.0 },
    trunkWidth: 3.0,
    entranceWidth: 3.0,
    wheelchairCount: 0,
    angles: [90],
  },
  bicycle: {
    ...DEFAULT_PARAMS,
    stallWidth: 0.6,
    stallLength: 1.9,
    parallelLength: 1.9,
    parallelWidth: 0.6,
    aisle: { 90: 1.5, 60: 1.5, 45: 1.5, 0: 1.5 },
    trunkWidth: 2.0,
    entranceWidth: 2.0,
    wheelchairCount: 0,
    angles: [90],
  },
};

/** 保存データなどから読んだパラメータを初期値で補う */
export function withDefaults(kind: VehicleKind, p?: Partial<LayoutParams>): LayoutParams {
  const d = VEHICLE_DEFAULTS[kind];
  return { ...structuredClone(d), ...p, aisle: { ...d.aisle, ...p?.aisle } };
}
