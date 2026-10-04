import type { LatLng } from '../geo/projection';

export interface ShapeStyle {
  stroke: string;
  strokeWidth: number;
  fill?: string;
  fillOpacity?: number;
  dashed?: boolean;
}

export interface Shape {
  setPath(path: LatLng[]): void;
  setStyle(style: ShapeStyle): void;
  remove(): void;
}

export interface MarkerOptions {
  draggable?: boolean;
  color?: string;
  /** 半径（px） */
  size?: number;
  title?: string;
  onClick?: () => void;
  onDrag?: (p: LatLng) => void;
  onDragEnd?: (p: LatLng) => void;
}

export interface MarkerHandle {
  setPosition(p: LatLng): void;
  remove(): void;
}

export interface BaseLayer {
  id: string;
  label: string;
}

/** Google Maps と Leaflet（地理院地図）の共通窓口 */
export interface MapAdapter {
  readonly kind: 'google' | 'leaflet';
  readonly baseLayers: BaseLayer[];
  setBaseLayer(id: string): void;
  onClick(cb: (p: LatLng) => void): void;
  /** onClick を渡すと図形のクリックを受け取る（地図のクリックにはならない） */
  addPolygon(path: LatLng[], style: ShapeStyle, onClick?: () => void): Shape;
  addPolyline(path: LatLng[], style: ShapeStyle): Shape;
  addMarker(p: LatLng, opts: MarkerOptions): MarkerHandle;
  setView(p: LatLng, zoom: number): void;
  fitBounds(path: LatLng[]): void;
  getView(): { center: LatLng; zoom: number };
  setCursor(c: string): void;
}

/** 地理院タイル（出典表示が必要） */
export const GSI_LAYERS = {
  photo: {
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    maxZoom: 18,
    label: '地理院 写真',
  },
  std: {
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    maxZoom: 18,
    label: '地理院 標準地図',
  },
} as const;

export const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
