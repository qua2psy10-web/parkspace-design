import './style.css';
import { type LatLng, makeProjection, ZONE_LABELS } from './geo/projection';
import { signedArea } from './geo/geometry';
import type { MapAdapter, Shape } from './map/adapter';
import { createLeafletAdapter } from './map/leafletAdapter';
import { createGoogleAdapter, loadGoogleMaps } from './map/googleAdapter';
import { type EditMode, SiteEditor, type SiteState } from './map/editor';
import type { Plan, SiteInput } from './layout/generator';
import { ANGLE_LABELS, type AngleType, DEFAULT_PARAMS, type LayoutParams } from './layout/standards';
import { buildDxf } from './export/dxf';
import * as store from './storage';

const KEY_API = 'parkspace.apiKey';
const KEY_PROJECT = 'parkspace.project';

interface SavedProject {
  zone: number;
  site: SiteState;
  params: LayoutParams;
  view?: { center: LatLng; zoom: number };
  baseLayer?: string;
}

// 筑西市役所付近
const DEFAULT_CENTER: LatLng = { lat: 36.3069, lng: 139.9831 };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const saved = store.load<SavedProject>(KEY_PROJECT);
const state = {
  zone: saved?.zone ?? 9,
  params: { ...DEFAULT_PARAMS, ...saved?.params, aisle: { ...DEFAULT_PARAMS.aisle, ...saved?.params?.aisle } } as LayoutParams,
  plans: [] as Plan[],
  selected: -1,
};
const projection = () => makeProjection(state.zone);

async function createMap(): Promise<{ map: MapAdapter; message: string }> {
  const el = $('map');
  const center = saved?.view?.center ?? DEFAULT_CENTER;
  const zoom = saved?.view?.zoom ?? 18;
  const key = store.load<string>(KEY_API);
  if (key) {
    try {
      await loadGoogleMaps(key);
      return { map: createGoogleAdapter(el, center, zoom), message: 'Google Maps で表示中' };
    } catch (e) {
      el.innerHTML = '';
      return {
        map: createLeafletAdapter(el, center, zoom),
        message: `${e instanceof Error ? e.message : e} 地理院地図で表示しています。`,
      };
    }
  }
  return { map: createLeafletAdapter(el, center, zoom), message: 'APIキー未設定のため地理院地図で表示中' };
}

async function main() {
  const { map, message } = await createMap();
  $('mapStatus').textContent = message;

  // ---- 背景 ----
  const baseSel = $<HTMLSelectElement>('baseLayer');
  for (const b of map.baseLayers) baseSel.add(new Option(b.label, b.id));
  if (saved?.baseLayer && map.baseLayers.some((b) => b.id === saved.baseLayer)) {
    baseSel.value = saved.baseLayer;
    map.setBaseLayer(saved.baseLayer);
  }
  baseSel.onchange = () => {
    map.setBaseLayer(baseSel.value);
    persist();
  };

  // ---- 座標系 ----
  const zoneSel = $<HTMLSelectElement>('zone');
  ZONE_LABELS.forEach((l, i) => zoneSel.add(new Option(`${l} 系${i === 8 ? '（茨城県など）' : ''}`, String(i + 1))));
  zoneSel.value = String(state.zone);
  zoneSel.onchange = () => {
    state.zone = Number(zoneSel.value);
    invalidate();
    persist();
  };

  // ---- APIキー ----
  const keyInput = $<HTMLInputElement>('apiKey');
  keyInput.value = store.load<string>(KEY_API) ?? '';
  $('saveKey').onclick = () => {
    const v = keyInput.value.trim();
    if (!v) return;
    store.save(KEY_API, v);
    persist();
    location.reload();
  };
  $('clearKey').onclick = () => {
    store.remove(KEY_API);
    persist();
    location.reload();
  };

  // ---- 住所検索（国土地理院の住所検索） ----
  const searchInput = $<HTMLInputElement>('search');
  const doSearch = async () => {
    const q = searchInput.value.trim();
    if (!q) return;
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      map.setView({ lat: Number(m[1]), lng: Number(m[2]) }, 18);
      return;
    }
    try {
      const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
      const list = (await res.json()) as { geometry: { coordinates: [number, number] } }[];
      if (!list.length) {
        $('mapStatus').textContent = `「${q}」が見つかりませんでした`;
        return;
      }
      const [lng, lat] = list[0].geometry.coordinates;
      map.setView({ lat, lng }, 18);
    } catch {
      $('mapStatus').textContent = '住所検索に失敗しました。緯度,経度 での入力もできます。';
    }
  };
  $('searchBtn').onclick = doSearch;
  searchInput.onkeydown = (e) => {
    if (e.key === 'Enter') doSearch();
  };

  // ---- 敷地の編集 ----
  const site: SiteState = saved?.site ?? { boundary: [], obstacles: [], entrances: [] };
  const hints: Record<EditMode, string> = {
    idle: '',
    boundary: '地図上で敷地の角を順にクリック。最初の点をクリックするか「確定」で閉じます。',
    obstacle: '避けたい範囲（建物・植栽など）の角を順にクリック。「確定」で閉じます。',
    entrance: '敷地境界線の近くをクリックすると、境界線上に出入口を置きます。',
  };
  const editor = new SiteEditor(
    map,
    site,
    projection,
    () => state.params.entranceWidth,
    () => {
      invalidate();
      updateSiteInfo();
      persist();
    },
    (mode) => {
      document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
      $('drawHint').hidden = mode === 'idle';
      $('drawHintText').textContent = hints[mode];
      $<HTMLButtonElement>('finishBtn').hidden = mode === 'entrance';
    },
  );
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.onclick = () => {
      const mode = b.dataset.mode as EditMode;
      if ((mode === 'entrance' || mode === 'obstacle') && site.boundary.length < 3) {
        alert('先に「範囲を描く」で敷地を指定してください。');
        return;
      }
      if (mode === 'boundary' && site.boundary.length >= 3 && !confirm('今の範囲を消して描き直しますか？（出入口も消えます）')) return;
      editor.setMode(mode);
    };
  });
  $('finishBtn').onclick = () => editor.finish();
  $('cancelBtn').onclick = () => editor.cancel();
  $('clearSite').onclick = () => {
    if (confirm('敷地・障害物・出入口をすべて消去しますか？')) editor.clearAll();
  };
  if (site.boundary.length >= 3 && !saved?.view) map.fitBounds(site.boundary);

  function updateSiteInfo() {
    const pj = projection();
    if (site.boundary.length >= 3) {
      const area = Math.abs(signedArea(site.boundary.map((p) => pj.toPlane(p))));
      $('siteInfo').textContent = `敷地面積 約 ${area.toFixed(1)} ㎡（頂点 ${site.boundary.length}）`;
    } else {
      $('siteInfo').textContent = '敷地が未指定です。';
    }
    const ol = $('obstacleList');
    ol.innerHTML = '';
    site.obstacles.forEach((o, i) => {
      const area = Math.abs(signedArea(o.map((p) => pj.toPlane(p))));
      ol.append(listItem(`障害物 ${i + 1}（約 ${area.toFixed(1)} ㎡）`, () => editor.removeObstacle(i)));
    });
    const el = $('entranceList');
    el.innerHTML = '';
    site.entrances.forEach((_, i) => el.append(listItem(`出入口 ${i + 1}`, () => editor.removeEntrance(i))));
  }
  updateSiteInfo();

  // ---- 寸法条件 ----
  buildParamsForm(() => {
    invalidate();
    editor.render();
    persist();
  });

  // ---- 自動割付 ----
  let resultShapes: Shape[] = [];
  const clearResults = () => {
    resultShapes.forEach((s) => s.remove());
    resultShapes = [];
  };

  function invalidate() {
    if (!state.plans.length) return;
    state.plans = [];
    state.selected = -1;
    clearResults();
    renderResultTable();
    $('runStatus').textContent = '条件が変わりました。もう一度「自動割付を実行」してください。';
  }

  function drawPlan(plan: Plan) {
    clearResults();
    const pj = projection();
    const ll = (r: { x: number; y: number }[]) => r.map((p) => pj.toLatLng(p));
    for (const t of plan.trunks) resultShapes.push(map.addPolygon(ll(t), { stroke: '#5ac8fa', strokeWidth: 1, fill: '#5ac8fa', fillOpacity: 0.25 }));
    for (const a of plan.aisles) resultShapes.push(map.addPolygon(ll(a), { stroke: '#34c759', strokeWidth: 1, fill: '#34c759', fillOpacity: 0.15 }));
    for (const s of plan.stalls) {
      const hc = s.kind === 'wheelchair';
      resultShapes.push(
        map.addPolygon(ll(s.corners), {
          stroke: hc ? '#0a84ff' : '#ffffff',
          strokeWidth: hc ? 2 : 1.5,
          fill: hc ? '#0a84ff' : '#ffffff',
          fillOpacity: hc ? 0.45 : 0.15,
        }),
      );
    }
  }

  function renderResultTable() {
    const table = $<HTMLTableElement>('results');
    const tbody = table.querySelector('tbody')!;
    tbody.innerHTML = '';
    table.hidden = state.plans.length === 0;
    // 方式ごとの最大案を上に、続いて他の向きの案
    state.plans.slice(0, 12).forEach((p, i) => {
      const tr = document.createElement('tr');
      tr.className = i === state.selected ? 'selected' : '';
      tr.innerHTML = `<td>${ANGLE_LABELS[p.angle]}</td><td>${p.direction.toFixed(1)}°</td><td class="num">${p.count}</td><td class="num">${p.wheelchair}</td>`;
      tr.onclick = () => selectPlan(i);
      tbody.append(tr);
    });
    const w = $('warnings');
    w.innerHTML = '';
    const plan = state.plans[state.selected];
    plan?.warnings.forEach((m) => {
      const li = document.createElement('li');
      li.textContent = m;
      w.append(li);
    });
    $<HTMLButtonElement>('dxfBtn').disabled = !plan;
  }

  function selectPlan(i: number) {
    state.selected = i;
    drawPlan(state.plans[i]);
    renderResultTable();
  }

  const worker = new Worker(new URL('./layout/worker.ts', import.meta.url), { type: 'module' });
  const runBtn = $<HTMLButtonElement>('runBtn');
  runBtn.onclick = () => {
    if (site.boundary.length < 3) {
      alert('先に「範囲を描く」で敷地を指定してください。');
      return;
    }
    if (!state.params.angles.length) {
      alert('試算する駐車方式を1つ以上選んでください。');
      return;
    }
    const pj = projection();
    const input: SiteInput = {
      boundary: site.boundary.map((p) => pj.toPlane(p)),
      obstacles: site.obstacles.map((o) => o.map((p) => pj.toPlane(p))),
      entrances: site.entrances.map((p) => pj.toPlane(p)),
    };
    runBtn.disabled = true;
    $('runStatus').textContent = '計算中…';
    const started = performance.now();
    worker.onmessage = (e: MessageEvent<{ ok: true; plans: Plan[] } | { ok: false; error: string }>) => {
      runBtn.disabled = false;
      if (!e.data.ok) {
        $('runStatus').textContent = `計算に失敗しました: ${e.data.error}`;
        return;
      }
      state.plans = e.data.plans;
      const sec = ((performance.now() - started) / 1000).toFixed(1);
      if (!state.plans.length) {
        state.selected = -1;
        clearResults();
        renderResultTable();
        $('runStatus').textContent = `配置できるマスがありませんでした（${sec} 秒）。範囲や寸法条件を見直してください。`;
        return;
      }
      $('runStatus').textContent = `${state.plans.length} 案を試算しました（${sec} 秒）。行をクリックすると地図に表示します。`;
      selectPlan(0);
    };
    worker.postMessage({ site: input, params: state.params });
  };

  // ---- DXF ----
  $('dxfBtn').onclick = () => {
    const plan = state.plans[state.selected];
    if (!plan) return;
    const pj = projection();
    const dxf = buildDxf({
      boundary: site.boundary.map((p) => pj.toPlane(p)),
      obstacles: site.obstacles.map((o) => o.map((p) => pj.toPlane(p))),
      entrances: site.entrances.map((e) => editor.entranceSegmentPlane(e)).filter((s): s is NonNullable<typeof s> => !!s),
      plan,
      zoneLabel: ZONE_LABELS[state.zone - 1],
    });
    download(`${today()}_parking_block.dxf`, dxf, 'application/dxf');
  };

  function persist() {
    store.save(KEY_PROJECT, {
      zone: state.zone,
      site,
      params: state.params,
      view: map.getView(),
      baseLayer: baseSel.value,
    } satisfies SavedProject);
  }
  window.addEventListener('beforeunload', persist);
}

function listItem(label: string, onDelete: () => void): HTMLLIElement {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = label;
  const btn = document.createElement('button');
  btn.className = 'link';
  btn.textContent = '削除';
  btn.onclick = onDelete;
  li.append(span, btn);
  return li;
}

type NumKey = 'stallWidth' | 'stallLength' | 'parallelLength' | 'parallelWidth' | 'trunkWidth' | 'entranceWidth' | 'wheelchairCount' | 'wheelchairWidth' | 'setback';

function buildParamsForm(onChange: () => void) {
  const fields: { label: string; get: () => number; set: (v: number) => void; step: number; min: number }[] = [
    ...(
      [
        ['マス幅（m）', 'stallWidth', 0.05],
        ['マス奥行（m）', 'stallLength', 0.05],
      ] as [string, NumKey, number][]
    ).map(([label, k, step]) => numField(label, k, step)),
    ...([90, 60, 45, 0] as AngleType[]).map((a) => ({
      label: `車路幅 ${ANGLE_LABELS[a]}（m）`,
      get: () => state.params.aisle[a],
      set: (v: number) => (state.params.aisle[a] = v),
      step: 0.05,
      min: 0.5,
    })),
    ...(
      [
        ['縦列マス 長さ（m）', 'parallelLength', 0.05],
        ['縦列マス 幅（m）', 'parallelWidth', 0.05],
        ['幹線車路幅（m）', 'trunkWidth', 0.05],
        ['出入口幅（m）', 'entranceWidth', 0.05],
        ['車いす用 台数', 'wheelchairCount', 1],
        ['車いす用 マス幅（m）', 'wheelchairWidth', 0.05],
        ['境界・障害物からの離れ（m）', 'setback', 0.05],
      ] as [string, NumKey, number][]
    ).map(([label, k, step]) => numField(label, k, step)),
  ];

  function numField(label: string, k: NumKey, step: number) {
    return {
      label,
      get: () => state.params[k],
      set: (v: number) => (state.params[k] = v),
      step,
      min: k === 'wheelchairCount' || k === 'setback' ? 0 : 0.5,
    };
  }

  const box = $('params');
  box.innerHTML = '';
  for (const f of fields) {
    const label = document.createElement('label');
    label.textContent = f.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(f.step);
    input.min = String(f.min);
    input.value = String(f.get());
    input.onchange = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < f.min) {
        input.value = String(f.get());
        return;
      }
      f.set(v);
      onChange();
    };
    box.append(label, input);
  }

  const angles = $('angles');
  angles.innerHTML = '';
  for (const a of [90, 60, 45, 0] as AngleType[]) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.params.angles.includes(a);
    cb.onchange = () => {
      state.params.angles = ([90, 60, 45, 0] as AngleType[]).filter((x) => (x === a ? cb.checked : state.params.angles.includes(x)));
      onChange();
    };
    label.append(cb, ` ${ANGLE_LABELS[a]}`);
    angles.append(label);
  }

  $('resetParams').onclick = () => {
    state.params = structuredClone(DEFAULT_PARAMS);
    buildParamsForm(onChange);
    onChange();
  };
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

main();
