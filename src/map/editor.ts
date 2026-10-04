import type { LatLng, Projection, Pt } from '../geo/projection';
import { closestOnSegment } from '../geo/geometry';
import type { MapAdapter, MarkerHandle, Shape } from './adapter';

export type EditMode = 'idle' | 'boundary' | 'obstacle' | 'entrance' | 'area';

export type AreaKind = 'large' | 'bike' | 'bicycle';

export interface SiteState {
  boundary: LatLng[];
  obstacles: LatLng[][];
  entrances: LatLng[];
  /** 大型車・バイク・自転車のエリア（残りは普通車） */
  areas: { kind: AreaKind; ring: LatLng[] }[];
}

const COLORS = {
  boundary: '#ff3b30',
  obstacle: '#ff9500',
  entrance: '#af52de',
  drawing: '#ffd60a',
};

export const AREA_COLORS: Record<AreaKind, string> = {
  large: '#ff2d55',
  bike: '#30b0c7',
  bicycle: '#34c759',
};

/**
 * 敷地境界・障害物・出入口を地図上で描く・動かす。
 * 変更があるたびに onChange を呼ぶ。
 */
export class SiteEditor {
  mode: EditMode = 'idle';
  /** 次に描くエリアの種類 */
  areaKind: AreaKind = 'large';
  private drawing: LatLng[] = [];
  private drawingShape: Shape | null = null;
  private drawingMarkers: MarkerHandle[] = [];
  private siteShapes: Shape[] = [];
  private siteMarkers: MarkerHandle[] = [];

  constructor(
    private map: MapAdapter,
    public site: SiteState,
    private getProjection: () => Projection,
    private getEntranceWidth: () => number,
    private onChange: () => void,
    private onModeChange: (m: EditMode) => void,
  ) {
    map.onClick((p) => this.handleClick(p));
    this.render();
  }

  setMode(m: EditMode) {
    this.clearDrawing();
    this.mode = m;
    this.map.setCursor(m === 'idle' ? 'default' : 'crosshair');
    this.onModeChange(m);
  }

  /** 描画中の多角形を確定する */
  finish() {
    if (this.mode === 'boundary' || this.mode === 'obstacle' || this.mode === 'area') {
      if (this.drawing.length >= 3) {
        if (this.mode === 'boundary') {
          this.site.boundary = [...this.drawing];
          // 境界が変わると出入口の位置が合わなくなるため外す
          this.site.entrances = [];
        } else if (this.mode === 'area') {
          this.site.areas.push({ kind: this.areaKind, ring: [...this.drawing] });
        } else {
          this.site.obstacles.push([...this.drawing]);
        }
        this.setMode('idle');
        this.render();
        this.onChange();
        return;
      }
    }
    this.setMode('idle');
  }

  cancel() {
    this.setMode('idle');
  }

  removeObstacle(i: number) {
    this.site.obstacles.splice(i, 1);
    this.render();
    this.onChange();
  }

  removeArea(i: number) {
    this.site.areas.splice(i, 1);
    this.render();
    this.onChange();
  }

  removeEntrance(i: number) {
    this.site.entrances.splice(i, 1);
    this.render();
    this.onChange();
  }

  clearAll() {
    this.site.boundary = [];
    this.site.obstacles = [];
    this.site.entrances = [];
    this.site.areas = [];
    this.setMode('idle');
    this.render();
    this.onChange();
  }

  private handleClick(p: LatLng) {
    if (this.mode === 'boundary' || this.mode === 'obstacle' || this.mode === 'area') {
      this.drawing.push(p);
      this.renderDrawing();
    } else if (this.mode === 'entrance') {
      const snapped = this.snapToBoundary(p);
      if (snapped) {
        this.site.entrances.push(snapped);
        this.setMode('idle');
        this.render();
        this.onChange();
      }
    }
  }

  private renderDrawing() {
    this.drawingShape?.remove();
    this.drawingMarkers.forEach((m) => m.remove());
    this.drawingMarkers = [];
    this.drawingShape = this.map.addPolyline(this.drawing, { stroke: COLORS.drawing, strokeWidth: 2, dashed: true });
    this.drawing.forEach((p, i) => {
      this.drawingMarkers.push(
        this.map.addMarker(p, {
          color: i === 0 ? COLORS.drawing : '#fff',
          size: i === 0 ? 8 : 5,
          title: i === 0 ? 'クリックで閉じて確定' : undefined,
          onClick: i === 0 ? () => this.finish() : undefined,
        }),
      );
    });
  }

  private clearDrawing() {
    this.drawing = [];
    this.drawingShape?.remove();
    this.drawingShape = null;
    this.drawingMarkers.forEach((m) => m.remove());
    this.drawingMarkers = [];
  }

  /** 敷地まわりの図形を描き直す */
  render() {
    this.siteShapes.forEach((s) => s.remove());
    this.siteMarkers.forEach((m) => m.remove());
    this.siteShapes = [];
    this.siteMarkers = [];
    const { boundary, obstacles } = this.site;
    if (boundary.length >= 3) {
      const shape = this.map.addPolygon(boundary, { stroke: COLORS.boundary, strokeWidth: 2, fill: COLORS.boundary, fillOpacity: 0.05 });
      this.siteShapes.push(shape);
      this.addVertexMarkers(boundary, shape, COLORS.boundary);
    }
    this.site.areas.forEach((a) => {
      const color = AREA_COLORS[a.kind];
      const shape = this.map.addPolygon(a.ring, { stroke: color, strokeWidth: 2, fill: color, fillOpacity: 0.12, dashed: true });
      this.siteShapes.push(shape);
      this.addVertexMarkers(a.ring, shape, color);
    });
    obstacles.forEach((o) => {
      const shape = this.map.addPolygon(o, { stroke: COLORS.obstacle, strokeWidth: 2, fill: COLORS.obstacle, fillOpacity: 0.35 });
      this.siteShapes.push(shape);
      this.addVertexMarkers(o, shape, COLORS.obstacle);
    });
    this.site.entrances.forEach((e, i) => {
      const seg = this.entranceSegment(e);
      if (seg) this.siteShapes.push(this.map.addPolyline(seg, { stroke: COLORS.entrance, strokeWidth: 6 }));
      this.siteMarkers.push(
        this.map.addMarker(e, {
          color: COLORS.entrance,
          size: 7,
          draggable: true,
          title: `出入口 ${i + 1}（ドラッグで移動）`,
          onDragEnd: (p) => {
            const s = this.snapToBoundary(p, Infinity);
            if (s) this.site.entrances[i] = s;
            this.render();
            this.onChange();
          },
        }),
      );
    });
  }

  private addVertexMarkers(ring: LatLng[], shape: Shape, color: string) {
    ring.forEach((p, i) => {
      this.siteMarkers.push(
        this.map.addMarker(p, {
          color,
          size: 5,
          draggable: true,
          title: 'ドラッグで頂点を移動',
          onDrag: (q) => {
            ring[i] = q;
            shape.setPath(ring);
          },
          onDragEnd: (q) => {
            ring[i] = q;
            if (ring === this.site.boundary) {
              this.site.entrances = this.site.entrances
                .map((e) => this.snapToBoundary(e, Infinity))
                .filter((e): e is LatLng => !!e);
            }
            this.render();
            this.onChange();
          },
        }),
      );
    });
  }

  /** 境界線上の最も近い点に寄せる。maxDist（m）より遠ければ null */
  private snapToBoundary(p: LatLng, maxDist = 15): LatLng | null {
    const b = this.site.boundary;
    if (b.length < 3) return null;
    const pj = this.getProjection();
    const q = pj.toPlane(p);
    const pts = b.map((x) => pj.toPlane(x));
    let best: { d: number; pt: Pt } | null = null;
    for (let i = 0; i < pts.length; i++) {
      const { pt } = closestOnSegment(q, pts[i], pts[(i + 1) % pts.length]);
      const d = Math.hypot(pt.x - q.x, pt.y - q.y);
      if (!best || d < best.d) best = { d, pt };
    }
    if (!best || best.d > maxDist) return null;
    return pj.toLatLng(best.pt);
  }

  /** 出入口の幅を境界線に沿って表す線分（平面直角座標で計算） */
  entranceSegmentPlane(e: LatLng): { a: Pt; b: Pt } | null {
    const b = this.site.boundary;
    if (b.length < 3) return null;
    const pj = this.getProjection();
    const q = pj.toPlane(e);
    const pts = b.map((x) => pj.toPlane(x));
    let best: { d: number; a: Pt; b: Pt; pt: Pt } | null = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const c = pts[(i + 1) % pts.length];
      const { pt } = closestOnSegment(q, a, c);
      const d = Math.hypot(pt.x - q.x, pt.y - q.y);
      if (!best || d < best.d) best = { d, a, b: c, pt };
    }
    if (!best) return null;
    const len = Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y) || 1;
    const ux = (best.b.x - best.a.x) / len;
    const uy = (best.b.y - best.a.y) / len;
    const h = this.getEntranceWidth() / 2;
    return {
      a: { x: best.pt.x - ux * h, y: best.pt.y - uy * h },
      b: { x: best.pt.x + ux * h, y: best.pt.y + uy * h },
    };
  }

  private entranceSegment(e: LatLng): LatLng[] | null {
    const s = this.entranceSegmentPlane(e);
    if (!s) return null;
    const pj = this.getProjection();
    return [pj.toLatLng(s.a), pj.toLatLng(s.b)];
  }
}
