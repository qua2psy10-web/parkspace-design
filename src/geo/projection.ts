import proj4 from 'proj4';

/** 緯度経度 */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * 平面上の点（m）。x = 東方向（測量のY）、y = 北方向（測量のX）。
 * CADの作図座標と同じ向きにしている。
 */
export interface Pt {
  x: number;
  y: number;
}

/** 平面直角座標系（JGD2011）I〜XIX系の原点 [緯度, 経度]（度） */
const ZONE_ORIGINS: [number, number][] = [
  [33, 129 + 30 / 60], // I
  [33, 131], // II
  [36, 132 + 10 / 60], // III
  [33, 133 + 30 / 60], // IV
  [36, 134 + 20 / 60], // V
  [36, 136], // VI
  [36, 137 + 10 / 60], // VII
  [36, 138 + 30 / 60], // VIII
  [36, 139 + 50 / 60], // IX
  [40, 140 + 50 / 60], // X
  [44, 140 + 15 / 60], // XI
  [44, 142 + 15 / 60], // XII
  [44, 144 + 15 / 60], // XIII
  [26, 142], // XIV
  [26, 127 + 30 / 60], // XV
  [26, 124], // XVI
  [26, 131], // XVII
  [20, 136], // XVIII
  [26, 154], // XIX
];

export const ZONE_LABELS = [
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX',
];

export interface Projection {
  zone: number;
  toPlane(p: LatLng): Pt;
  toLatLng(p: Pt): LatLng;
}

/** 系番号（1〜19）を指定して変換器を作る */
export function makeProjection(zone: number): Projection {
  const origin = ZONE_ORIGINS[zone - 1];
  if (!origin) throw new Error(`系番号が不正です: ${zone}`);
  const def =
    `+proj=tmerc +lat_0=${origin[0]} +lon_0=${origin[1]} +k=0.9999 ` +
    '+x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
  const conv = proj4('EPSG:4326', def);
  return {
    zone,
    toPlane(p) {
      const [x, y] = conv.forward([p.lng, p.lat]);
      return { x, y };
    },
    toLatLng(p) {
      const [lng, lat] = conv.inverse([p.x, p.y]);
      return { lat, lng };
    },
  };
}
