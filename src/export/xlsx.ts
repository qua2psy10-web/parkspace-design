import type { Row } from 'exceljs';
import { CLASS_LABELS, numberStalls, type SelectedArea, type StallClass, summarize } from '../layout/summary';
import { VEHICLE_LABELS } from '../layout/standards';

export interface XlsxInput {
  name: string;
  date: Date;
  zoneLabel: string;
  areas: SelectedArea[];
}

const CLASSES: StallClass[] = ['normal', 'wheelchair', 'large', 'bike', 'bicycle'];

/** 台数集計表（「集計」「マス一覧」の2シート）を作る */
export async function buildXlsx(input: XlsxInput): Promise<ArrayBuffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = '駐車場ブロック割';
  wb.created = input.date;
  const sum = summarize(input.areas);
  const bold = { bold: true } as const;
  const head = (row: Row) => {
    row.font = bold;
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } };
  };

  // ---- 集計 ----
  const ws = wb.addWorksheet('集計');
  ws.columns = [{ width: 22 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 12 }];
  ws.addRow(['駐車場ブロック割 台数集計表']).font = { bold: true, size: 14 };
  ws.addRow(['案件名', input.name || '（未入力）']);
  ws.addRow(['作成日', input.date]).getCell(2).numFmt = 'yyyy/mm/dd';
  ws.addRow(['座標系', `平面直角座標系（JGD2011） ${input.zoneLabel} 系`]);
  ws.addRow([]);

  head(ws.addRow(['車種', '台数（台）', '区画外周延長（m）']));
  for (const c of CLASSES) {
    const r = ws.addRow([CLASS_LABELS[c], sum.counts[c], round2(sum.outline[c])]);
    r.getCell(3).numFmt = '0.00';
  }
  const tot = ws.addRow(['合計', sum.total, round2(CLASSES.reduce((t, c) => t + sum.outline[c], 0))]);
  tot.font = bold;
  tot.getCell(3).numFmt = '0.00';
  ws.addRow(['※区画外周延長はマスの外周の長さの合計で、隣り合うマスが共有する辺は1回だけ数えています。']).font = { size: 9, color: { argb: 'FF666666' } };
  ws.addRow([]);

  head(ws.addRow(['エリア', '車種', '面積（㎡）', '駐車方式', '車路方向', '台数（台）']));
  for (const a of sum.areas) {
    const r = ws.addRow([a.label, VEHICLE_LABELS[a.kind], round2(a.area), a.method, a.direction, a.count]);
    r.getCell(3).numFmt = '#,##0.00';
  }

  // ---- マス一覧 ----
  const ls = wb.addWorksheet('マス一覧');
  ls.columns = [
    { header: '番号', width: 8 },
    { header: '種類', width: 16 },
    { header: 'エリア', width: 18 },
    { header: '中心 X（東, m）', width: 16 },
    { header: '中心 Y（北, m）', width: 16 },
    { header: '幅（m）', width: 10 },
    { header: '長さ（m）', width: 10 },
  ];
  head(ls.getRow(1));
  for (const s of numberStalls(input.areas)) {
    const r = ls.addRow([s.id, CLASS_LABELS[s.cls], s.area, round3(s.center.x), round3(s.center.y), round3(s.width), round3(s.length)]);
    for (const i of [4, 5]) r.getCell(i).numFmt = '0.000';
    for (const i of [6, 7]) r.getCell(i).numFmt = '0.00';
  }
  ls.views = [{ state: 'frozen', ySplit: 1 }];

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
