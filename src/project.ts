import type { LatLng, Pt } from './geo/projection';
import type { Plan } from './layout/generator';
import type { SiteState } from './map/editor';
import { type LayoutParams, VEHICLE_KINDS, type VehicleKind, withDefaults } from './layout/standards';

export const PROJECT_FORMAT = 'parkspace-project';
export const PROJECT_VERSION = 2;

/** 保存する割付結果（エリアごとの採用案。座標は平面直角座標） */
export interface SavedResult {
  /** 結果を作ったときの座標系。今の座標系と違えば使わない */
  zone: number;
  /** 手直ししたか */
  edited: boolean;
  areas: { kind: VehicleKind; outer: Pt[]; holes: Pt[][]; plan: Plan | null }[];
}

/** 案件ファイル（.parking.json）の中身。ブラウザ内の自動保存も同じ形 */
export interface ProjectData {
  format: typeof PROJECT_FORMAT;
  version: number;
  name: string;
  zone: number;
  site: SiteState;
  params: Record<VehicleKind, LayoutParams>;
  view?: { center: LatLng; zoom: number };
  baseLayer?: string;
  /** 版2から: 割付結果（手直しを含む） */
  result?: SavedResult;
}

export function emptyProject(): ProjectData {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: '',
    zone: 9,
    site: { boundary: [], obstacles: [], entrances: [], areas: [] },
    params: defaultParams(),
  };
}

export function defaultParams(): Record<VehicleKind, LayoutParams> {
  return Object.fromEntries(VEHICLE_KINDS.map((k) => [k, withDefaults(k)])) as Record<VehicleKind, LayoutParams>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function latLng(v: unknown): LatLng | null {
  if (!isObj(v)) return null;
  const { lat, lng } = v;
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function ring(v: unknown): LatLng[] {
  if (!Array.isArray(v)) return [];
  const out = v.map(latLng);
  return out.every((p): p is LatLng => !!p) ? out : [];
}

/**
 * 読み込んだ JSON を案件データに直す。形式が違えば例外。
 * 第1段階のブラウザ自動保存（format なし、params が普通車だけ）も読める。
 */
export function parseProject(data: unknown): ProjectData {
  if (!isObj(data)) throw new Error('案件ファイルの形式が正しくありません。');
  const legacy = data.format === undefined && isObj(data.site);
  if (!legacy && data.format !== PROJECT_FORMAT) throw new Error('駐車場ブロック割の案件ファイルではありません。');
  if (typeof data.version === 'number' && data.version > PROJECT_VERSION) {
    throw new Error('新しい版のアプリで保存された案件ファイルです。ページを再読み込みしてください。');
  }
  const p = emptyProject();
  if (typeof data.name === 'string') p.name = data.name;
  if (typeof data.zone === 'number' && data.zone >= 1 && data.zone <= 19) p.zone = Math.round(data.zone);

  const site = isObj(data.site) ? data.site : {};
  p.site.boundary = ring(site.boundary);
  p.site.obstacles = Array.isArray(site.obstacles) ? site.obstacles.map(ring).filter((r) => r.length >= 3) : [];
  p.site.entrances = Array.isArray(site.entrances) ? site.entrances.map(latLng).filter((e): e is LatLng => !!e) : [];
  p.site.areas = Array.isArray(site.areas)
    ? site.areas
        .filter(isObj)
        .map((a) => ({ kind: a.kind, ring: ring(a.ring) }))
        .filter((a): a is SiteState['areas'][number] => (a.kind === 'large' || a.kind === 'bike' || a.kind === 'bicycle') && a.ring.length >= 3)
    : [];

  if (legacy) {
    if (isObj(data.params)) p.params.normal = withDefaults('normal', data.params as Partial<LayoutParams>);
  } else if (isObj(data.params)) {
    const params = data.params;
    for (const k of VEHICLE_KINDS) if (isObj(params[k])) p.params[k] = withDefaults(k, params[k] as Partial<LayoutParams>);
  }

  if (isObj(data.view)) {
    const center = latLng(data.view.center);
    const zoom = data.view.zoom;
    if (center && typeof zoom === 'number') p.view = { center, zoom };
  }
  if (typeof data.baseLayer === 'string') p.baseLayer = data.baseLayer;
  const result = parseResult(data.result);
  if (result && result.zone === p.zone) p.result = result;
  return p;
}

export function serializeProject(p: ProjectData): string {
  return JSON.stringify({ ...p, format: PROJECT_FORMAT, version: PROJECT_VERSION }, null, 2);
}

/** ファイル名に使えない文字を除いた案件名（空なら parking） */
export function fileBaseName(name: string): string {
  const s = name.trim().replace(/[\\/:*?"<>|\s]+/g, '_');
  return s || 'parking';
}

const isPt = (v: unknown): v is Pt => isObj(v) && typeof v.x === 'number' && typeof v.y === 'number';
const isRing = (v: unknown): v is Pt[] => Array.isArray(v) && v.every(isPt);

/** 割付結果の読込。形がおかしければ捨てる（条件から計算し直せるため） */
function parseResult(v: unknown): SavedResult | undefined {
  if (!isObj(v) || typeof v.zone !== 'number' || !Array.isArray(v.areas)) return undefined;
  const areas: SavedResult['areas'] = [];
  for (const a of v.areas) {
    if (!isObj(a) || !VEHICLE_KINDS.includes(a.kind as VehicleKind) || !isRing(a.outer)) return undefined;
    const holes = Array.isArray(a.holes) && a.holes.every(isRing) ? (a.holes as Pt[][]) : [];
    let plan: Plan | null = null;
    if (isObj(a.plan)) {
      const pl = a.plan;
      const stallsOk =
        Array.isArray(pl.stalls) && pl.stalls.every((s) => isObj(s) && isRing(s.corners) && (s.kind === 'normal' || s.kind === 'wheelchair'));
      if (!stallsOk || typeof pl.angle !== 'number' || typeof pl.direction !== 'number') return undefined;
      plan = {
        angle: pl.angle as Plan['angle'],
        direction: pl.direction,
        count: (pl.stalls as unknown[]).length,
        wheelchair: (pl.stalls as Plan['stalls']).filter((s) => s.kind === 'wheelchair').length,
        added: typeof pl.added === 'number' ? pl.added : 0,
        stalls: pl.stalls as Plan['stalls'],
        aisles: Array.isArray(pl.aisles) && pl.aisles.every(isRing) ? (pl.aisles as Pt[][]) : [],
        trunks: Array.isArray(pl.trunks) && pl.trunks.every(isRing) ? (pl.trunks as Pt[][]) : [],
        arrows: Array.isArray(pl.arrows) && pl.arrows.every((r) => isObj(r) && isPt(r.from) && isPt(r.to)) ? (pl.arrows as Plan['arrows']) : [],
        warnings: Array.isArray(pl.warnings) ? pl.warnings.filter((w): w is string => typeof w === 'string') : [],
      };
    }
    areas.push({ kind: a.kind as VehicleKind, outer: a.outer, holes, plan });
  }
  return { zone: v.zone, edited: v.edited === true, areas };
}
