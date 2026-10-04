import type { LatLng } from '../geo/projection';
import { GSI_LAYERS, type MapAdapter, type MarkerOptions, type ShapeStyle } from './adapter';

let loading: Promise<void> | null = null;

/** Google Maps JavaScript API を読み込む */
export function loadGoogleMaps(apiKey: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const cbName = '__parkspaceGmapsReady';
    (window as unknown as Record<string, unknown>)[cbName] = () => resolve();
    (window as unknown as Record<string, unknown>).gm_authFailure = () =>
      reject(new Error('Google Maps の APIキーが無効か、このサイトでの利用が許可されていません。'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&callback=${cbName}`;
    s.async = true;
    s.onerror = () => reject(new Error('Google Maps を読み込めませんでした。'));
    document.head.appendChild(s);
  });
  return loading;
}

function gsiMapType(url: string, name: string, maxZoom: number): google.maps.ImageMapType {
  return new google.maps.ImageMapType({
    getTileUrl: (c, z) => (z > maxZoom ? null : url.replace('{z}', String(z)).replace('{x}', String(c.x)).replace('{y}', String(c.y))),
    tileSize: new google.maps.Size(256, 256),
    maxZoom,
    name,
  });
}

function polyOptions(s: ShapeStyle) {
  return {
    strokeColor: s.stroke,
    strokeWeight: s.strokeWidth,
    fillColor: s.fill ?? s.stroke,
    fillOpacity: s.fill ? (s.fillOpacity ?? 0.3) : 0,
    clickable: false,
  };
}

export function createGoogleAdapter(el: HTMLElement, center: LatLng, zoom: number): MapAdapter {
  const map = new google.maps.Map(el, {
    center,
    zoom,
    mapTypeId: 'satellite',
    // 斜め写真（45°表示）だと位置がずれるため真上からの写真に固定する
    tilt: 0,
    rotateControl: false,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    disableDoubleClickZoom: true,
    clickableIcons: false,
  });
  map.mapTypes.set('gsi_photo', gsiMapType(GSI_LAYERS.photo.url, GSI_LAYERS.photo.label, GSI_LAYERS.photo.maxZoom));
  map.mapTypes.set('gsi_std', gsiMapType(GSI_LAYERS.std.url, GSI_LAYERS.std.label, GSI_LAYERS.std.maxZoom));

  return {
    kind: 'google',
    baseLayers: [
      { id: 'satellite', label: 'Google 航空写真' },
      { id: 'roadmap', label: 'Google 地図' },
      { id: 'gsi_photo', label: GSI_LAYERS.photo.label },
      { id: 'gsi_std', label: GSI_LAYERS.std.label },
    ],
    setBaseLayer(id) {
      map.setMapTypeId(id);
      map.setTilt(0);
    },
    onClick(cb) {
      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (e.latLng) cb({ lat: e.latLng.lat(), lng: e.latLng.lng() });
      });
    },
    addPolygon(path, style) {
      const shape = new google.maps.Polygon({ ...polyOptions(style), paths: path, map });
      return { setPath: (p) => shape.setPaths(p), remove: () => shape.setMap(null) };
    },
    addPolyline(path, style) {
      const shape = new google.maps.Polyline({
        path,
        map,
        strokeColor: style.stroke,
        strokeWeight: style.strokeWidth,
        clickable: false,
        strokeOpacity: style.dashed ? 0 : 1,
        icons: style.dashed
          ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: style.stroke, scale: style.strokeWidth }, offset: '0', repeat: '10px' }]
          : undefined,
      });
      return { setPath: (p) => shape.setPath(p), remove: () => shape.setMap(null) };
    },
    addMarker(p, opts: MarkerOptions) {
      const m = new google.maps.Marker({
        position: p,
        map,
        draggable: !!opts.draggable,
        title: opts.title,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: opts.size ?? 6,
          fillColor: opts.color ?? '#fff',
          fillOpacity: 1,
          strokeColor: '#222',
          strokeWeight: 2,
        },
      });
      const ll = (e: google.maps.MapMouseEvent) => ({ lat: e.latLng!.lat(), lng: e.latLng!.lng() });
      if (opts.onClick) m.addListener('click', () => opts.onClick!());
      if (opts.onDrag) m.addListener('drag', (e: google.maps.MapMouseEvent) => opts.onDrag!(ll(e)));
      if (opts.onDragEnd) m.addListener('dragend', (e: google.maps.MapMouseEvent) => opts.onDragEnd!(ll(e)));
      return { setPosition: (q) => m.setPosition(q), remove: () => m.setMap(null) };
    },
    setView(p, z) {
      map.setCenter(p);
      map.setZoom(z);
    },
    fitBounds(path) {
      if (!path.length) return;
      const b = new google.maps.LatLngBounds();
      path.forEach((p) => b.extend(p));
      map.fitBounds(b, 30);
    },
    getView() {
      const c = map.getCenter()!;
      return { center: { lat: c.lat(), lng: c.lng() }, zoom: map.getZoom() ?? zoom };
    },
    setCursor(c) {
      map.setOptions({ draggableCursor: c === 'default' ? null : c });
    },
  };
}
