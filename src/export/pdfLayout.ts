/**
 * PDF 図面の割付（用紙・縮尺・作図枠）と、背景写真の位置合わせ計算。
 * ブラウザに依存しない計算だけを置く。
 */

export type Paper = 'A4' | 'A3' | 'A1';

/** 用紙（横置き）の大きさ（mm） */
export const PAPER_SIZE: Record<Paper, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A1: { w: 841, h: 594 },
};

/** 選べる縮尺の分母 */
export const SCALES = [100, 200, 250, 300, 500, 600, 1000, 1500, 2000, 2500];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageLayout {
  paper: Paper;
  page: { w: number; h: number };
  /** 図枠 */
  frame: Box;
  /** 作図範囲（図面本体） */
  drawing: Box;
  /** 右側の欄（凡例・台数表・表題欄） */
  side: Box;
}

/** 用紙の外周余白・右欄の幅（mm） */
const MARGIN: Record<Paper, number> = { A4: 8, A3: 10, A1: 15 };
const SIDE_W: Record<Paper, number> = { A4: 70, A3: 95, A1: 130 };
/** 作図範囲の内側余白（mm） */
const PAD = 5;

export function pageLayout(paper: Paper): PageLayout {
  const page = PAPER_SIZE[paper];
  const m = MARGIN[paper];
  const frame = { x: m, y: m, w: page.w - 2 * m, h: page.h - 2 * m };
  const side = { x: frame.x + frame.w - SIDE_W[paper], y: frame.y, w: SIDE_W[paper], h: frame.h };
  const drawing = { x: frame.x + PAD, y: frame.y + PAD, w: side.x - frame.x - 2 * PAD, h: frame.h - 2 * PAD };
  return { paper, page, frame, drawing, side };
}

/**
 * 敷地の大きさ（m）が作図範囲に収まる、いちばん大きい縮尺（分母が最小）を選ぶ。
 * どれにも収まらなければ最小の縮尺（分母が最大）を返し、fits = false。
 */
export function pickScale(widthM: number, heightM: number, paper: Paper): { scale: number; fits: boolean } {
  const { drawing } = pageLayout(paper);
  for (const s of SCALES) {
    if ((widthM * 1000) / s <= drawing.w && (heightM * 1000) / s <= drawing.h) return { scale: s, fits: true };
  }
  return { scale: SCALES[SCALES.length - 1], fits: false };
}

export function fitsAt(widthM: number, heightM: number, paper: Paper, scale: number): boolean {
  const { drawing } = pageLayout(paper);
  return (widthM * 1000) / scale <= drawing.w && (heightM * 1000) / scale <= drawing.h;
}

/** スケールバーの長さ（m）。紙の上で 30〜60mm 程度になるきりのよい値 */
export function scaleBarLength(scale: number): number {
  const candidates = [5, 10, 20, 25, 50, 100, 200, 250, 500];
  for (const c of candidates) if ((c * 1000) / scale >= 30) return c;
  return candidates[candidates.length - 1];
}

/** 2次元アフィン変換 x' = a x + c y + e, y' = b x + d y + f（canvas の setTransform と同じ並び） */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

type XY = { x: number; y: number };

/** 3組の対応点から、src を dst に写すアフィン変換を求める */
export function affineFrom3(src: [XY, XY, XY], dst: [XY, XY, XY]): Affine {
  const [p0, p1, p2] = src;
  const det = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
  if (Math.abs(det) < 1e-12) throw new Error('位置合わせの基準点が一直線上にあります。');
  const solve = (v0: number, v1: number, v2: number) => {
    // v = α x + β y + γ を3点で解く
    const alpha = ((v1 - v0) * (p2.y - p0.y) - (v2 - v0) * (p1.y - p0.y)) / det;
    const beta = ((p1.x - p0.x) * (v2 - v0) - (p2.x - p0.x) * (v1 - v0)) / det;
    const gamma = v0 - alpha * p0.x - beta * p0.y;
    return { alpha, beta, gamma };
  };
  const X = solve(dst[0].x, dst[1].x, dst[2].x);
  const Y = solve(dst[0].y, dst[1].y, dst[2].y);
  return { a: X.alpha, c: X.beta, e: X.gamma, b: Y.alpha, d: Y.beta, f: Y.gamma };
}

export function applyAffine(m: Affine, p: XY): XY {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** 緯度経度 → Web メルカトルのタイル座標系の画素（ズーム z, 256px タイル） */
export function lngLatToPixel(lng: number, lat: number, z: number): XY {
  const n = 256 * 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
}

/**
 * 背景写真のタイルのズーム。紙の上で 1 画素が約 0.2mm になる解像度を目安に、
 * 地理院の写真タイルの上限（18）を超えないようにする。
 */
export function photoZoom(scale: number, lat: number): number {
  const metersPerPixel = (0.2 / 1000) * scale;
  const z = Math.ceil(Math.log2((156543.034 * Math.cos((lat * Math.PI) / 180)) / metersPerPixel));
  return Math.max(10, Math.min(18, z));
}
