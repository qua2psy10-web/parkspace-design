import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LatLng } from '../geo/projection';
import { GSI_ATTRIBUTION, GSI_LAYERS, type MapAdapter, type MarkerOptions, type ShapeStyle } from './adapter';

const toL = (p: LatLng): L.LatLngExpression => [p.lat, p.lng];

function pathOptions(s: ShapeStyle): L.PathOptions {
  return {
    color: s.stroke,
    weight: s.strokeWidth,
    fillColor: s.fill ?? s.stroke,
    fillOpacity: s.fill ? (s.fillOpacity ?? 0.3) : 0,
    dashArray: s.dashed ? '6 4' : undefined,
    interactive: false,
  };
}

/** APIキーなしで使う地理院地図版 */
export function createLeafletAdapter(el: HTMLElement, center: LatLng, zoom: number): MapAdapter {
  const map = L.map(el, { zoomControl: true, maxZoom: 22 }).setView(toL(center), zoom);
  const layers: Record<string, L.TileLayer> = {
    gsi_photo: L.tileLayer(GSI_LAYERS.photo.url, {
      maxNativeZoom: GSI_LAYERS.photo.maxZoom,
      maxZoom: 22,
      attribution: GSI_ATTRIBUTION,
    }),
    gsi_std: L.tileLayer(GSI_LAYERS.std.url, {
      maxNativeZoom: GSI_LAYERS.std.maxZoom,
      maxZoom: 22,
      attribution: GSI_ATTRIBUTION,
    }),
  };
  let current = layers.gsi_photo.addTo(map);

  return {
    kind: 'leaflet',
    baseLayers: [
      { id: 'gsi_photo', label: GSI_LAYERS.photo.label },
      { id: 'gsi_std', label: GSI_LAYERS.std.label },
    ],
    setBaseLayer(id) {
      const next = layers[id];
      if (!next || next === current) return;
      map.removeLayer(current);
      current = next.addTo(map);
    },
    onClick(cb) {
      map.on('click', (e: L.LeafletMouseEvent) => cb({ lat: e.latlng.lat, lng: e.latlng.lng }));
    },
    addPolygon(path, style) {
      const shape = L.polygon(path.map(toL), pathOptions(style)).addTo(map);
      return {
        setPath: (p) => shape.setLatLngs(p.map(toL)),
        remove: () => shape.remove(),
      };
    },
    addPolyline(path, style) {
      const shape = L.polyline(path.map(toL), pathOptions(style)).addTo(map);
      return {
        setPath: (p) => shape.setLatLngs(p.map(toL)),
        remove: () => shape.remove(),
      };
    },
    addMarker(p, opts: MarkerOptions) {
      const size = opts.size ?? 6;
      const icon = L.divIcon({
        className: 'vertex-marker',
        html: `<div style="width:${size * 2}px;height:${size * 2}px;background:${opts.color ?? '#fff'};border:2px solid #222;border-radius:50%;box-sizing:border-box"></div>`,
        iconSize: [size * 2, size * 2],
        iconAnchor: [size, size],
      });
      const m = L.marker(toL(p), { icon, draggable: !!opts.draggable, title: opts.title, bubblingMouseEvents: false }).addTo(map);
      if (opts.onClick) m.on('click', () => opts.onClick!());
      const ll = () => ({ lat: m.getLatLng().lat, lng: m.getLatLng().lng });
      if (opts.onDrag) m.on('drag', () => opts.onDrag!(ll()));
      if (opts.onDragEnd) m.on('dragend', () => opts.onDragEnd!(ll()));
      return {
        setPosition: (q) => m.setLatLng(toL(q)),
        remove: () => m.remove(),
      };
    },
    setView(p, z) {
      map.setView(toL(p), z);
    },
    fitBounds(path) {
      if (path.length) map.fitBounds(L.latLngBounds(path.map(toL)), { padding: [30, 30] });
    },
    getView() {
      const c = map.getCenter();
      return { center: { lat: c.lat, lng: c.lng }, zoom: map.getZoom() };
    },
    setCursor(c) {
      el.style.cursor = c;
      map.getContainer().style.cursor = c;
    },
  };
}
