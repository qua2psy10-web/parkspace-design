import type { LatLng, Pt } from '../geo/projection';
import { bbox } from '../geo/geometry';
import { arrowPolyline } from '../layout/arrow';
import { CLASS_LABELS, numberStalls, type SelectedArea, type StallClass, summarize } from '../layout/summary';
import { GSI_LAYERS } from '../map/adapter';
import {
  affineFrom3,
  type Box,
  fitsAt,
  lngLatToPixel,
  type Paper,
  pageLayout,
  photoZoom,
  pickScale,
  scaleBarLength,
} from './pdfLayout';

export interface PdfInput {
  name: string;
  date: Date;
  zoneLabel: string;
  boundary: Pt[];
  obstacles: Pt[][];
  entrances: { a: Pt; b: Pt }[];
  areas: SelectedArea[];
  paper: Paper;
  /** 縮尺の分母。'auto' なら自動 */
  scale: number | 'auto';
  photo: boolean;
  toLatLng: (p: Pt) => LatLng;
}

export interface PdfResult {
  data: ArrayBuffer;
  scale: number;
  fits: boolean;
  photo: 'off' | 'ok' | 'failed';
}

/** 図面の色（印刷で見分けやすい色） */
const COLOR = {
  frame: '#000000',
  boundary: '#d00000',
  obstacle: '#7a7a7a',
  area: '#555555',
  aisle: '#2e9d4f',
  trunk: '#2a86c8',
  entrance: '#8e3fbf',
  arrow: '#e08a00',
  text: '#000000',
};
const STALL_COLOR: Record<StallClass, string> = {
  normal: '#202020',
  wheelchair: '#0a5bd6',
  large: '#c2185b',
  bike: '#00838f',
  bicycle: '#2e7d32',
};
const PHOTO_CREDIT = '背景写真：地理院タイル（全国最新写真（シームレス））';

export async function buildPdf(input: PdfInput): Promise<PdfResult> {
  const { jsPDF, GState } = await import('jspdf');
  const L = pageLayout(input.paper);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: input.paper.toLowerCase() });

  // ---- 縮尺と座標変換（平面直角座標 m → 紙 mm） ----
  const stallList = numberStalls(input.areas);
  const bb = bbox([input.boundary, ...stallList.map((s) => s.corners)]);
  const wM = bb.xmax - bb.xmin;
  const hM = bb.ymax - bb.ymin;
  let scale: number;
  let fits: boolean;
  if (input.scale === 'auto') ({ scale, fits } = pickScale(wM, hM, input.paper));
  else {
    scale = input.scale;
    fits = fitsAt(wM, hM, input.paper, scale);
  }
  const mid = { x: (bb.xmin + bb.xmax) / 2, y: (bb.ymin + bb.ymax) / 2 };
  const D = L.drawing;
  const center = { x: D.x + D.w / 2, y: D.y + D.h / 2 };
  const k = 1000 / scale;
  const P = (p: Pt) => ({ x: center.x + (p.x - mid.x) * k, y: center.y - (p.y - mid.y) * k });
  const Pinv = (x: number, y: number): Pt => ({ x: mid.x + (x - center.x) / k, y: mid.y - (y - center.y) / k });

  // ---- 描画の道具 ----
  const setOpacity = (o: number) => doc.setGState(new GState({ opacity: o, 'stroke-opacity': 1 }));
  const path = (pts: { x: number; y: number }[], closed: boolean, style: 'S' | 'F' | 'FD') => {
    if (pts.length < 2) return;
    const segs = pts.slice(1).map((p, i) => [p.x - pts[i].x, p.y - pts[i].y]);
    doc.lines(segs, pts[0].x, pts[0].y, [1, 1], style, closed);
  };
  const shape = (
    ring: Pt[],
    o: { stroke: string; width: number; fill?: string; fillOpacity?: number; dash?: number[]; closed?: boolean },
  ) => {
    const pts = ring.map(P);
    doc.setLineWidth(o.width);
    doc.setDrawColor(o.stroke);
    doc.setLineDashPattern(o.dash ?? [], 0);
    if (o.fill) {
      doc.setFillColor(o.fill);
      setOpacity(o.fillOpacity ?? 1);
      path(pts, true, 'F');
      setOpacity(1);
    }
    path(pts, o.closed ?? true, 'S');
    doc.setLineDashPattern([], 0);
  };
  const jp = new JpText(doc);

  // ---- 背景写真 ----
  let photo: PdfResult['photo'] = 'off';
  if (input.photo) {
    try {
      const img = await renderPhoto(D, Pinv, input.toLatLng, scale, input.paper);
      doc.addImage(img, 'JPEG', D.x, D.y, D.w, D.h);
      photo = 'ok';
    } catch (e) {
      console.warn('背景写真を取得できませんでした', e);
      photo = 'failed';
    }
  }

  // ---- 図面本体（作図範囲で切り抜く） ----
  doc.saveGraphicsState();
  doc.rect(D.x, D.y, D.w, D.h, null);
  doc.clip();
  doc.discardPath();
  const onPhoto = photo === 'ok';
  for (const a of input.areas) {
    if (!a.plan) continue;
    for (const r of a.plan.trunks) shape(r, { stroke: COLOR.trunk, width: 0.1, fill: COLOR.trunk, fillOpacity: onPhoto ? 0.35 : 0.15 });
    for (const r of a.plan.aisles) shape(r, { stroke: COLOR.aisle, width: 0.1, fill: COLOR.aisle, fillOpacity: onPhoto ? 0.3 : 0.12 });
  }
  for (const o of input.obstacles) shape(o, { stroke: COLOR.obstacle, width: 0.25, fill: COLOR.obstacle, fillOpacity: 0.3 });
  for (const a of input.areas) {
    if (a.kind === 'normal') continue;
    for (const r of [a.outer, ...a.holes]) shape(r, { stroke: COLOR.area, width: 0.25, dash: [2, 1] });
  }
  for (const s of stallList) {
    const c = STALL_COLOR[s.cls];
    shape(s.corners, {
      stroke: onPhoto && s.cls === 'normal' ? '#ffffff' : c,
      width: 0.18,
      fill: s.cls === 'normal' ? undefined : c,
      fillOpacity: 0.25,
    });
  }
  for (const a of input.areas) {
    for (const ar of a.plan?.arrows ?? []) shape(arrowPolyline(ar), { stroke: COLOR.arrow, width: 0.35, closed: false });
  }
  shape(input.boundary, { stroke: COLOR.boundary, width: 0.5 });
  for (const e of input.entrances) shape([e.a, e.b], { stroke: COLOR.entrance, width: 1.2, closed: false });

  // マス番号（紙の上で小さすぎるときは省略）
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(onPhoto ? '#ffffff' : COLOR.text);
  for (const s of stallList) {
    const hMm = Math.min(s.width * k * 0.45, 2.5);
    if (hMm < 0.7) continue;
    const c = P(s.center);
    doc.setFontSize(hMm / 0.3528);
    doc.text(s.id, c.x, c.y, { align: 'center', baseline: 'middle' });
  }
  doc.restoreGraphicsState();

  // ---- 枠 ----
  doc.setDrawColor(COLOR.frame);
  doc.setLineWidth(0.5);
  doc.rect(L.frame.x, L.frame.y, L.frame.w, L.frame.h);
  doc.setLineWidth(0.3);
  doc.line(L.side.x, L.side.y, L.side.x, L.side.y + L.side.h);
  if (photo === 'ok') jp.draw(PHOTO_CREDIT, D.x + 1, D.y + D.h - 1, 2.2, { baseline: 'bottom', bg: '#ffffff' });

  // ---- 右欄 ----
  const S = L.side;
  const pad = 4;
  let y = S.y + pad;
  const x0 = S.x + pad;
  const w = S.w - 2 * pad;
  const unit = S.w / 95; // A3 を基準にした大きさの係数

  // 方位記号（上が座標北）
  const nx = x0 + 10 * unit;
  const ny = y + 4 * unit;
  doc.setFillColor('#000000');
  doc.setLineWidth(0.3);
  doc.triangle(nx, ny, nx - 3 * unit, ny + 12 * unit, nx, ny + 9 * unit, 'FD');
  doc.setFillColor('#ffffff');
  doc.triangle(nx, ny, nx + 3 * unit, ny + 12 * unit, nx, ny + 9 * unit, 'FD');
  doc.setTextColor('#000000');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10 * unit);
  doc.text('N', nx, ny - 1, { align: 'center', baseline: 'bottom' });
  jp.draw('上が座標北', nx + 6 * unit, ny + 6 * unit, 2.6 * unit, { baseline: 'middle' });

  // スケールバー
  const barM = scaleBarLength(scale);
  const barMm = barM * k;
  const bx = x0 + 32 * unit;
  const by = ny + 9 * unit;
  doc.setLineWidth(0.3);
  for (let i = 0; i < 4; i++) {
    doc.setFillColor(i % 2 ? '#ffffff' : '#000000');
    doc.rect(bx + (barMm / 4) * i, by, barMm / 4, 1.6 * unit, 'FD');
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7 * unit);
  doc.text('0', bx, by - 0.8, { align: 'center' });
  doc.text(`${barM}m`, bx + barMm, by - 0.8, { align: 'center' });
  y = ny + 18 * unit;

  // 凡例
  jp.draw('凡例', x0, y, 3.2 * unit, { bold: true });
  y += 5 * unit;
  const sum = summarize(input.areas);
  const classes = (['normal', 'wheelchair', 'large', 'bike', 'bicycle'] as StallClass[]).filter((c) => sum.counts[c] > 0);
  const legendRow = (draw: (lx: number, ly: number) => void, label: string) => {
    draw(x0, y);
    jp.draw(label, x0 + 12 * unit, y + 1.5 * unit, 2.8 * unit, { baseline: 'middle' });
    y += 5 * unit;
  };
  const box = (stroke: string, fill?: string, op = 0.25, dash?: number[]) => (lx: number, ly: number) => {
    doc.setLineWidth(0.25);
    doc.setDrawColor(stroke);
    doc.setLineDashPattern(dash ?? [], 0);
    if (fill) {
      doc.setFillColor(fill);
      setOpacity(op);
      doc.rect(lx, ly, 9 * unit, 3 * unit, 'F');
      setOpacity(1);
    }
    doc.rect(lx, ly, 9 * unit, 3 * unit, 'S');
    doc.setLineDashPattern([], 0);
  };
  for (const c of classes) legendRow(box(STALL_COLOR[c], c === 'normal' ? undefined : STALL_COLOR[c]), `駐車マス（${CLASS_LABELS[c]}）`);
  legendRow(box(COLOR.aisle, COLOR.aisle, 0.15), '車路');
  legendRow(box(COLOR.trunk, COLOR.trunk, 0.2), '幹線車路');
  if (input.areas.some((a) => a.plan?.arrows.length)) {
    legendRow((lx, ly) => {
      doc.setDrawColor(COLOR.arrow);
      doc.setLineWidth(0.35);
      const pts = arrowPolyline({ from: { x: lx, y: ly + 1.5 * unit }, to: { x: lx + 9 * unit, y: ly + 1.5 * unit } }, 1.5 * unit);
      // 紙の座標は y が下向きなので矢じりの向きはそのまま使える
      path(pts, false, 'S');
    }, '一方通行の向き');
  }
  legendRow((lx, ly) => {
    doc.setDrawColor(COLOR.boundary);
    doc.setLineWidth(0.5);
    doc.line(lx, ly + 1.5 * unit, lx + 9 * unit, ly + 1.5 * unit);
  }, '敷地境界');
  if (input.obstacles.length) legendRow(box(COLOR.obstacle, COLOR.obstacle, 0.3), '障害物');
  if (input.areas.some((a) => a.kind !== 'normal')) legendRow(box(COLOR.area, undefined, 0, [2, 1]), '車種エリアの境界');
  if (input.entrances.length) {
    legendRow((lx, ly) => {
      doc.setDrawColor(COLOR.entrance);
      doc.setLineWidth(1.2);
      doc.line(lx, ly + 1.5 * unit, lx + 9 * unit, ly + 1.5 * unit);
    }, '出入口');
  }

  // 台数表
  y += 3 * unit;
  jp.draw('駐車台数', x0, y, 3.2 * unit, { bold: true });
  y += 5 * unit;
  const rowH = 5 * unit;
  const colW = w * 0.62;
  const tableRow = (label: string, value: string, bold = false) => {
    doc.setLineWidth(0.2);
    doc.setDrawColor('#000000');
    doc.rect(x0, y, colW, rowH);
    doc.rect(x0 + colW, y, w - colW, rowH);
    jp.draw(label, x0 + 1.5, y + rowH / 2, 2.8 * unit, { baseline: 'middle', bold });
    jp.draw(value, x0 + w - 1.5, y + rowH / 2, 2.8 * unit, { baseline: 'middle', align: 'right', bold });
    y += rowH;
  };
  for (const c of classes) tableRow(CLASS_LABELS[c], `${sum.counts[c]} 台`);
  tableRow('合計', `${sum.total} 台`, true);

  // 表題欄（右欄の下）
  const date = input.date;
  const titleRows: [string, string][] = [
    ['件名', input.name || '（未入力）'],
    ['図名', '駐車場ブロック割図'],
    ['縮尺', `1/${scale}（${input.paper}）`],
    ['作成日', `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`],
    ['座標系', `JGD2011 平面直角座標系 ${input.zoneLabel}系`],
  ];
  const tRowH = 6.5 * unit;
  let ty = S.y + S.h - titleRows.length * tRowH;
  const labelW = 16 * unit;
  doc.setLineWidth(0.3);
  doc.line(S.x, ty, S.x + S.w, ty);
  for (const [label, value] of titleRows) {
    doc.setLineWidth(0.2);
    doc.line(S.x, ty + tRowH, S.x + S.w, ty + tRowH);
    doc.line(S.x + labelW, ty, S.x + labelW, ty + tRowH);
    jp.draw(label, S.x + 2, ty + tRowH / 2, 2.8 * unit, { baseline: 'middle' });
    jp.draw(value, S.x + labelW + 2, ty + tRowH / 2, (label === '件名' || label === '図名' ? 3.4 : 2.8) * unit, {
      baseline: 'middle',
      bold: label === '件名' || label === '図名',
      maxWidth: S.w - labelW - 4,
    });
    ty += tRowH;
  }

  return { data: doc.output('arraybuffer'), scale, fits, photo };
}

type Doc = InstanceType<typeof import('jspdf').jsPDF>;

/**
 * 日本語の文字を画像にして貼る（日本語フォントを PDF に埋め込むと数MB になるため）。
 * 同じ文字列・大きさの画像は使い回す。
 */
class JpText {
  private cache = new Map<string, { url: string; w: number; h: number }>();
  /** 1mm あたりの画素数（約 300dpi） */
  private readonly ppm = 12;
  constructor(private doc: Doc) {}

  draw(
    text: string,
    x: number,
    y: number,
    sizeMm: number,
    o: { align?: 'left' | 'right'; baseline?: 'top' | 'middle' | 'bottom'; bold?: boolean; bg?: string; maxWidth?: number } = {},
  ) {
    const img = this.image(text, sizeMm, !!o.bold, o.bg);
    let w = img.w;
    let h = img.h;
    if (o.maxWidth && w > o.maxWidth) {
      h = (h * o.maxWidth) / w;
      w = o.maxWidth;
    }
    const left = o.align === 'right' ? x - w : x;
    const top = o.baseline === 'middle' ? y - h / 2 : o.baseline === 'bottom' ? y - h : y;
    this.doc.addImage(img.url, 'PNG', left, top, w, h, `jp:${text}:${sizeMm}:${o.bold}:${o.bg}`);
  }

  private image(text: string, sizeMm: number, bold: boolean, bg?: string) {
    const key = `${text}|${sizeMm}|${bold}|${bg}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const px = sizeMm * this.ppm;
    const font = `${bold ? 'bold ' : ''}${px}px "Hiragino Sans", "Yu Gothic", "Meiryo", "Noto Sans JP", sans-serif`;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = font;
    const padPx = bg ? px * 0.25 : 1;
    c.width = Math.ceil(ctx.measureText(text).width + padPx * 2);
    c.height = Math.ceil(px * 1.3 + padPx * 2);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.globalAlpha = 1;
    }
    ctx.font = font;
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, padPx, c.height / 2);
    const out = { url: c.toDataURL('image/png'), w: c.width / this.ppm, h: c.height / this.ppm };
    this.cache.set(key, out);
    return out;
  }
}

/** 作図範囲 D に合わせた地理院写真の画像（JPEG の data URL）を作る */
async function renderPhoto(
  D: Box,
  Pinv: (x: number, y: number) => Pt,
  toLatLng: (p: Pt) => LatLng,
  scale: number,
  paper: Paper,
): Promise<string> {
  const corners = [Pinv(D.x, D.y), Pinv(D.x + D.w, D.y), Pinv(D.x, D.y + D.h), Pinv(D.x + D.w, D.y + D.h)].map(toLatLng);
  const lat = corners.reduce((s, c) => s + c.lat, 0) / corners.length;
  let z = photoZoom(scale, lat);
  let range: { x0: number; x1: number; y0: number; y1: number };
  // タイルが多すぎるときはズームを下げる
  for (;;) {
    const px = corners.map((c) => lngLatToPixel(c.lng, c.lat, z));
    range = {
      x0: Math.floor(Math.min(...px.map((p) => p.x)) / 256),
      x1: Math.floor(Math.max(...px.map((p) => p.x)) / 256),
      y0: Math.floor(Math.min(...px.map((p) => p.y)) / 256),
      y1: Math.floor(Math.max(...px.map((p) => p.y)) / 256),
    };
    if ((range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) <= 120 || z <= 10) break;
    z--;
  }
  const merc = document.createElement('canvas');
  merc.width = (range.x1 - range.x0 + 1) * 256;
  merc.height = (range.y1 - range.y0 + 1) * 256;
  const mctx = merc.getContext('2d')!;
  const jobs: Promise<void>[] = [];
  for (let tx = range.x0; tx <= range.x1; tx++) {
    for (let ty = range.y0; ty <= range.y1; ty++) {
      const url = GSI_LAYERS.photo.url.replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
      jobs.push(
        loadImage(url).then((img) => {
          mctx.drawImage(img, (tx - range.x0) * 256, (ty - range.y0) * 256);
        }),
      );
    }
  }
  await Promise.all(jobs);

  // 作図範囲の3隅で、メルカトル画素 → 出力画像の画素 の対応を取って貼り込む
  const ppm = paper === 'A1' ? 4 : 6;
  const out = document.createElement('canvas');
  out.width = Math.round(D.w * ppm);
  out.height = Math.round(D.h * ppm);
  const octx = out.getContext('2d')!;
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, out.width, out.height);
  const mp = (c: LatLng) => {
    const p = lngLatToPixel(c.lng, c.lat, z);
    return { x: p.x - range.x0 * 256, y: p.y - range.y0 * 256 };
  };
  const m = affineFrom3([mp(corners[0]), mp(corners[1]), mp(corners[2])], [
    { x: 0, y: 0 },
    { x: out.width, y: 0 },
    { x: 0, y: out.height },
  ]);
  octx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  octx.drawImage(merc, 0, 0);
  return out.toDataURL('image/jpeg', 0.85);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`タイルを読み込めませんでした: ${url}`));
    img.src = url;
  });
}
