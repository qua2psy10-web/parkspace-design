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
