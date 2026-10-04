import './style.css';
import { type LatLng, makeProjection, ZONE_LABELS } from './geo/projection';
import { signedArea } from './geo/geometry';
import type { MapAdapter, Shape } from './map/adapter';
import { createLeafletAdapter } from './map/leafletAdapter';
import { createGoogleAdapter, loadGoogleMaps } from './map/googleAdapter';
import { AREA_COLORS, type AreaKind, type EditMode, SiteEditor } from './map/editor';
import type { AreaResult, AreasInput } from './layout/areas';
import {
  ANGLE_LABELS,
  type AngleType,
  type LayoutParams,
  VEHICLE_KINDS,
  VEHICLE_LABELS,
  type VehicleKind,
  withDefaults,
} from './layout/standards';
import { areaLabels, CLASS_LABELS, type SelectedArea, type StallClass, summarize } from './layout/summary';
import { buildDxf } from './export/dxf';
import type { Paper } from './export/pdfLayout';
import type { Stall } from './layout/generator';
import { addStallAt, backDir, deleteStalls, type EditArea, findConflicts, moveStalls, rowDir, rowOf } from './edit/stallEditor';
import { pointStatus, ringsToEdges } from './geo/geometry';
import { arrowPolyline } from './layout/arrow';
import { emptyProject, fileBaseName, parseProject, type ProjectData, serializeProject } from './project';
import * as store from './storage';

const KEY_API = 'parkspace.apiKey';
const KEY_PROJECT = 'parkspace.project';

// 筑西市役所付近
const DEFAULT_CENTER: LatLng = { lat: 36.3069, lng: 139.9831 };

/** 地図上のマスの色 */
const STALL_COLORS: Record<StallClass, string> = {
  normal: '#ffffff',
  wheelchair: '#0a84ff',
  large: AREA_COLORS.large,
  bike: AREA_COLORS.bike,
  bicycle: AREA_COLORS.bicycle,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function loadSaved(): ProjectData {
  const raw = store.load<unknown>(KEY_PROJECT);
  if (!raw) return emptyProject();
  try {
    return parseProject(raw);
  } catch {
    return emptyProject();
  }
}

const project = loadSaved();
const state = {
  results: [] as AreaResult[],
  /** エリアごとに選んだ案の番号 */
  selected: [] as number[],
  tab: 'normal' as VehicleKind,
  /** 手直ししたか */
  edited: false,
  /** 手直しの操作中か */
  editing: false,
  /** 選んでいるマス（エリア番号とマス番号） */
  sel: { area: -1, ids: new Set<number>() },
  /** 問題のある（重なり・はみ出し）マス。エリア番号 → マス番号 */
  conflicts: new Map<number, Set<number>>(),
  /** 元に戻す用の履歴 */
  history: [] as { area: number; stalls: Stall[] }[],
};
const projection = () => makeProjection(project.zone);

async function createMap(): Promise<{ map: MapAdapter; message: string }> {
  const el = $('map');
  const center = project.view?.center ?? DEFAULT_CENTER;
  const zoom = project.view?.zoom ?? 18;
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
  const site = project.site;

  // ---- 背景 ----
  const baseSel = $<HTMLSelectElement>('baseLayer');
  for (const b of map.baseLayers) baseSel.add(new Option(b.label, b.id));
  if (project.baseLayer && map.baseLayers.some((b) => b.id === project.baseLayer)) {
    baseSel.value = project.baseLayer;
    map.setBaseLayer(project.baseLayer);
  }
  baseSel.onchange = () => {
    map.setBaseLayer(baseSel.value);
    persist();
  };

  // ---- 座標系 ----
  const zoneSel = $<HTMLSelectElement>('zone');
  ZONE_LABELS.forEach((l, i) => zoneSel.add(new Option(`${l} 系${i === 8 ? '（茨城県など）' : ''}`, String(i + 1))));
  zoneSel.value = String(project.zone);
  zoneSel.onchange = () => {
    project.zone = Number(zoneSel.value);
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
  const hints: Record<EditMode, string> = {
    idle: '',
    boundary: '地図上で敷地の角を順にクリック。最初の点をクリックするか「確定」で閉じます。',
    obstacle: '避けたい範囲（建物・植栽など）の角を順にクリック。「確定」で閉じます。',
    entrance: '敷地境界線の近くをクリックすると、境界線上に出入口を置きます。',
    area: 'エリアの角を順にクリック。「確定」で閉じます。敷地からはみ出した部分は使いません。',
  };
  const areaKindSel = $<HTMLSelectElement>('areaKind');
  const editor = new SiteEditor(
    map,
    site,
    projection,
    () => project.params.normal.entranceWidth,
    () => {
      invalidate();
      updateSiteInfo();
      persist();
    },
    (mode) => {
      document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
      $('drawHint').hidden = mode === 'idle';
      $('drawHintText').textContent =
        mode === 'area' ? `${VEHICLE_LABELS[editor.areaKind]}の${hints.area}` : hints[mode];
      $<HTMLButtonElement>('finishBtn').hidden = mode === 'entrance';
    },
  );
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.onclick = () => {
      const mode = b.dataset.mode as EditMode;
      if (mode !== 'boundary' && site.boundary.length < 3) {
        alert('先に「範囲を描く」で敷地を指定してください。');
        return;
      }
      if (mode === 'boundary' && site.boundary.length >= 3 && !confirm('今の範囲を消して描き直しますか？（出入口も消えます）')) return;
      if (mode === 'area') editor.areaKind = areaKindSel.value as AreaKind;
      editor.setMode(mode);
    };
  });
  $('finishBtn').onclick = () => editor.finish();
  $('cancelBtn').onclick = () => editor.cancel();
  $('clearSite').onclick = () => {
    if (confirm('敷地・障害物・出入口・エリアをすべて消去しますか？')) editor.clearAll();
  };
  if (site.boundary.length >= 3 && !project.view) map.fitBounds(site.boundary);

  function updateSiteInfo() {
    const pj = projection();
    const areaOf = (r: LatLng[]) => Math.abs(signedArea(r.map((p) => pj.toPlane(p))));
    $('siteInfo').textContent =
      site.boundary.length >= 3
        ? `敷地面積 約 ${areaOf(site.boundary).toFixed(1)} ㎡（頂点 ${site.boundary.length}）`
        : '敷地が未指定です。';
    const ol = $('obstacleList');
    ol.innerHTML = '';
    site.obstacles.forEach((o, i) => ol.append(listItem(`障害物 ${i + 1}（約 ${areaOf(o).toFixed(1)} ㎡）`, () => editor.removeObstacle(i))));
    const el = $('entranceList');
    el.innerHTML = '';
    site.entrances.forEach((_, i) => el.append(listItem(`出入口 ${i + 1}`, () => editor.removeEntrance(i))));
    const al = $('areaList');
    al.innerHTML = '';
    const labels = areaLabels(site.areas.map((a) => a.kind));
    site.areas.forEach((a, i) => {
      const li = listItem(`${labels[i]}（約 ${areaOf(a.ring).toFixed(1)} ㎡）`, () => editor.removeArea(i));
      li.prepend(swatch(AREA_COLORS[a.kind]));
      al.append(li);
    });
  }
  updateSiteInfo();

  // ---- 寸法条件（車種ごと） ----
  const onParamsChange = () => {
    invalidate();
    editor.render();
    persist();
  };
  function renderTabs() {
    const tabs = $('kindTabs');
    tabs.innerHTML = '';
    for (const k of VEHICLE_KINDS) {
      const b = document.createElement('button');
      b.textContent = VEHICLE_LABELS[k];
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(k === state.tab));
      b.onclick = () => {
        state.tab = k;
        renderTabs();
      };
      tabs.append(b);
    }
    $('paramsNote').textContent =
      state.tab === 'normal'
        ? '初期値は駐車場設計・施工指針の普通乗用車 2.5m×6.0m など。角度別の車路幅は案件の基準に合わせて修正してください。'
        : `${VEHICLE_LABELS[state.tab]}エリアに使う寸法です。マス寸法以外の初期値は目安なので、案件の基準と照合してください。`;
    buildParamsForm(state.tab, project.params, onParamsChange);
  }
  renderTabs();

  // ---- 自動割付 ----
  let resultShapes: Shape[] = [];
  const clearResults = () => {
    resultShapes.forEach((s) => s.remove());
    resultShapes = [];
  };

  function selectedAreas(): SelectedArea[] {
    const labels = areaLabels(state.results.map((r) => r.kind));
    return state.results.map((r, i) => ({
      kind: r.kind,
      label: labels[i],
      outer: r.outer,
      holes: r.holes,
      plan: r.plans[state.selected[i]] ?? null,
    }));
  }

  function invalidate() {
    if (!state.results.length) return;
    const wasEdited = state.edited;
    state.results = [];
    state.selected = [];
    resetEdit();
    clearResults();
    renderResults();
    $('runStatus').textContent = wasEdited
      ? '条件が変わったため、手直しした割付は消えました。もう一度「自動割付を実行」してください。'
      : '条件が変わりました。もう一度「自動割付を実行」してください。';
    persist();
  }

  function resetEdit() {
    state.edited = false;
    state.editing = false;
    state.sel = { area: -1, ids: new Set() };
    state.conflicts.clear();
    state.history = [];
    updateEditPanel();
  }

  /** 地図上のマスの図形（エリア番号 → マス番号 → 図形） */
  let stallShapes: Shape[][] = [];

  function stallStyle(cls: StallClass, selected: boolean, conflict: boolean) {
    if (conflict) return { stroke: '#ff3b30', strokeWidth: 2.5, fill: '#ff3b30', fillOpacity: 0.45 };
    if (selected) return { stroke: '#ffd60a', strokeWidth: 3, fill: '#ffd60a', fillOpacity: 0.5 };
    const strong = cls !== 'normal';
    return { stroke: STALL_COLORS[cls], strokeWidth: strong ? 2 : 1.5, fill: STALL_COLORS[cls], fillOpacity: strong ? 0.4 : 0.15 };
  }

  function drawAll() {
    clearResults();
    stallShapes = [];
    const pj = projection();
    const ll = (r: { x: number; y: number }[]) => r.map((p) => pj.toLatLng(p));
    selectedAreas().forEach((a, ai) => {
      stallShapes[ai] = [];
      const plan = a.plan;
      if (!plan) return;
      for (const t of plan.trunks) resultShapes.push(map.addPolygon(ll(t), { stroke: '#5ac8fa', strokeWidth: 1, fill: '#5ac8fa', fillOpacity: 0.25 }));
      for (const r of plan.aisles) resultShapes.push(map.addPolygon(ll(r), { stroke: '#34c759', strokeWidth: 1, fill: '#34c759', fillOpacity: 0.15 }));
      plan.stalls.forEach((s, si) => {
        const cls: StallClass = s.kind === 'wheelchair' ? 'wheelchair' : a.kind;
        const selected = state.sel.area === ai && state.sel.ids.has(si);
        const conflict = state.conflicts.get(ai)?.has(si) ?? false;
        const shape = map.addPolygon(ll(s.corners), stallStyle(cls, selected, conflict), state.editing ? () => toggleSelect(ai, si) : undefined);
        stallShapes[ai][si] = shape;
        resultShapes.push(shape);
      });
      for (const ar of plan.arrows) resultShapes.push(map.addPolyline(ll(arrowPolyline(ar)), { stroke: '#ffcc00', strokeWidth: 3 }));
    });
  }

  /** 選択・問題表示だけを塗り直す（図形は作り直さない） */
  function restyle(ai: number) {
    const a = selectedAreas()[ai];
    a?.plan?.stalls.forEach((s, si) => {
      const cls: StallClass = s.kind === 'wheelchair' ? 'wheelchair' : a.kind;
      stallShapes[ai]?.[si]?.setStyle(stallStyle(cls, state.sel.area === ai && state.sel.ids.has(si), state.conflicts.get(ai)?.has(si) ?? false));
    });
  }

  // ---- マスの手直し ----
  function editArea(ai: number): EditArea {
    const a = selectedAreas()[ai];
    return { outer: a.outer, holes: a.holes, blockers: [...(a.plan?.aisles ?? []), ...(a.plan?.trunks ?? [])] };
  }

  function currentPlan(ai: number) {
    return state.results[ai]?.plans[state.selected[ai]] ?? null;
  }

  function toggleSelect(ai: number, si: number) {
    const prev = state.sel.area;
    if (state.sel.area !== ai) state.sel = { area: ai, ids: new Set() };
    if (state.sel.ids.has(si)) state.sel.ids.delete(si);
    else state.sel.ids.add(si);
    if (prev >= 0 && prev !== ai) restyle(prev);
    restyle(ai);
    updateEditPanel();
  }

  /** stalls を書き換えたあとの後始末（履歴・台数・表示・保存） */
  function commit(ai: number, before: Stall[], stalls: Stall[], message: string) {
    const plan = currentPlan(ai);
    if (!plan) return;
    state.history.push({ area: ai, stalls: before });
    if (state.history.length > 50) state.history.shift();
    applyStalls(ai, stalls);
    $('editStatus').textContent = message;
  }

  function applyStalls(ai: number, stalls: Stall[]) {
    const plan = currentPlan(ai);
    if (!plan) return;
    plan.stalls = stalls;
    plan.count = stalls.length;
    plan.wheelchair = stalls.filter((s) => s.kind === 'wheelchair').length;
    state.edited = true;
    const c = findConflicts(editArea(ai), stalls);
    if (c.length) state.conflicts.set(ai, new Set(c));
    else state.conflicts.delete(ai);
    drawAll();
    renderResults();
    updateEditPanel();
    persist();
  }

  function updateEditPanel() {
    const has = state.results.some((r, i) => r.plans[state.selected[i]]);
    $('editBtn').hidden = !has || state.editing;
    $('editPanel').hidden = !state.editing;
    const any = state.sel.ids.size > 0;
    $<HTMLButtonElement>('editDelete').disabled = !any;
    $<HTMLButtonElement>('editRow').disabled = state.sel.ids.size !== 1;
    document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) => (b.disabled = !any));
    $<HTMLButtonElement>('editUndo').disabled = !state.history.length;
  }

  $('editBtn').onclick = () => {
    editor.setMode('idle');
    state.editing = true;
    state.sel = { area: -1, ids: new Set() };
    $('editStatus').textContent = '';
    drawAll();
    updateEditPanel();
  };
  $('editDone').onclick = () => {
    state.editing = false;
    state.sel = { area: -1, ids: new Set() };
    drawAll();
    updateEditPanel();
  };
  $('editDelete').onclick = () => {
    const ai = state.sel.area;
    const plan = currentPlan(ai);
    if (!plan || !state.sel.ids.size) return;
    const n = state.sel.ids.size;
    const before = plan.stalls;
    const after = deleteStalls(plan.stalls, state.sel.ids);
    state.sel = { area: -1, ids: new Set() };
    commit(ai, before, after, `${n} 台削除しました。`);
  };
  $('editRow').onclick = () => {
    const ai = state.sel.area;
    const plan = currentPlan(ai);
    const first = [...state.sel.ids][0];
    if (!plan || first === undefined) return;
    state.sel.ids = new Set(rowOf(plan.stalls, first));
    restyle(ai);
    updateEditPanel();
    $('editStatus').textContent = `列の ${state.sel.ids.size} 台を選びました。`;
  };
  document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) => {
    b.onclick = () => {
      const ai = state.sel.area;
      const plan = currentPlan(ai);
      const first = [...state.sel.ids][0];
      if (!plan || first === undefined) return;
      const step = Number($<HTMLSelectElement>('editStep').value);
      const u = rowDir(plan.stalls[first]);
      const bk = backDir(plan.stalls[first]);
      const v = { left: { x: -u.x, y: -u.y }, right: u, back: bk, front: { x: -bk.x, y: -bk.y } }[b.dataset.move as 'left' | 'right' | 'back' | 'front'];
      const before = plan.stalls;
      const res = moveStalls(editArea(ai), plan.stalls, state.sel.ids, { x: v.x * step, y: v.y * step });
      commit(
        ai,
        before,
        res.stalls,
        res.conflicts.length ? `${res.conflicts.length} 台が他のマス・車路と重なるか、エリアからはみ出しています（赤）。` : `${step} m 動かしました。`,
      );
    };
  });
  $('editUndo').onclick = () => {
    const h = state.history.pop();
    if (!h) return;
    state.sel = { area: -1, ids: new Set() };
    applyStalls(h.area, h.stalls);
    $('editStatus').textContent = '1つ前に戻しました。';
  };
  map.onClick((ll) => {
    if (!state.editing) return;
    const p = projection().toPlane(ll);
    const ai = selectedAreas().findIndex((a) => a.plan && pointStatus(p, ringsToEdges([a.outer, ...a.holes])) === 'in');
    if (ai < 0) {
      $('editStatus').textContent = '割付したエリアの中をクリックしてください。';
      return;
    }
    const plan = currentPlan(ai)!;
    const r = addStallAt(editArea(ai), plan.stalls, p);
    if (!r.ok) {
      $('editStatus').textContent = `追加できません: ${r.reason}`;
      return;
    }
    commit(ai, plan.stalls, [...plan.stalls, r.stall], 'マスを1台追加しました。');
  });

  function renderResults() {
    const box = $('results');
    box.innerHTML = '';
    const areas = selectedAreas();
    const has = areas.some((a) => a.plan);
    $<HTMLButtonElement>('dxfBtn').disabled = !has;
    $<HTMLButtonElement>('xlsxBtn').disabled = !has;
    $<HTMLButtonElement>('pdfBtn').disabled = !has;
    updateEditPanel();
    const totals = $('totals');
    totals.hidden = !has;
    if (has) {
      const sum = summarize(areas);
      const parts = (['normal', 'wheelchair', 'large', 'bike', 'bicycle'] as StallClass[])
        .filter((c) => sum.counts[c] > 0)
        .map((c) => `${CLASS_LABELS[c]} ${sum.counts[c]}`);
      totals.textContent = `合計 ${sum.total} 台（${parts.join('・')}）${state.edited ? '　※手直しあり' : ''}`;
    }
    state.results.forEach((r, i) => {
      const sec = document.createElement('div');
      sec.className = 'area-result';
      const h = document.createElement('h3');
      if (r.kind !== 'normal') h.append(swatch(AREA_COLORS[r.kind]));
      h.append(`${areas[i].label}（${areas[i].plan?.count ?? 0} 台）`);
      sec.append(h);
      if (!r.plans.length) {
        sec.append(note('配置できるマスがありませんでした。範囲や寸法条件を見直してください。'));
      } else {
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>方式</th><th>車路方向</th><th class="num">台数</th><th class="num">車いす</th></tr></thead>';
        const tbody = document.createElement('tbody');
        r.plans.slice(0, 8).forEach((p, j) => {
          const tr = document.createElement('tr');
          tr.className = j === state.selected[i] ? 'selected' : '';
          tr.innerHTML = `<td>${ANGLE_LABELS[p.angle]}</td><td>${p.direction.toFixed(1)}°</td><td class="num">${p.count}${p.added ? `<small>（余白+${p.added}）</small>` : ''}</td><td class="num">${p.wheelchair}</td>`;
          tr.onclick = () => {
            if (j === state.selected[i]) return;
            if (state.edited && !confirm('案を切り替えると、手直しした内容は消えます。よろしいですか？')) return;
            state.selected[i] = j;
            resetEdit();
            drawAll();
            renderResults();
            persist();
          };
          tbody.append(tr);
        });
        table.append(tbody);
        sec.append(table);
      }
      const warns = [...r.warnings, ...(areas[i].plan?.warnings ?? [])];
      if (warns.length) {
        const ul = document.createElement('ul');
        ul.className = 'warnings';
        for (const w of warns) {
          const li = document.createElement('li');
          li.textContent = w;
          ul.append(li);
        }
        sec.append(ul);
      }
      box.append(sec);
    });
  }

  const worker = new Worker(new URL('./layout/worker.ts', import.meta.url), { type: 'module' });
  const runBtn = $<HTMLButtonElement>('runBtn');
  runBtn.onclick = () => {
    if (site.boundary.length < 3) {
      alert('先に「範囲を描く」で敷地を指定してください。');
      return;
    }
    if (state.edited && !confirm('割付をやり直すと、手直しした内容は消えます。よろしいですか？')) return;
    const usedKinds = new Set<VehicleKind>(['normal', ...site.areas.map((a) => a.kind)]);
    const noAngle = [...usedKinds].filter((k) => !project.params[k].angles.length);
    if (noAngle.length) {
      alert(`${noAngle.map((k) => VEHICLE_LABELS[k]).join('・')}の駐車方式を1つ以上選んでください。`);
      return;
    }
    const pj = projection();
    const input: AreasInput = {
      boundary: site.boundary.map((p) => pj.toPlane(p)),
      obstacles: site.obstacles.map((o) => o.map((p) => pj.toPlane(p))),
      entrances: site.entrances.map((p) => pj.toPlane(p)),
      areas: site.areas.map((a) => ({ kind: a.kind, ring: a.ring.map((p) => pj.toPlane(p)) })),
      params: project.params,
    };
    runBtn.disabled = true;
    $('runStatus').textContent = '計算中…';
    const started = performance.now();
    worker.onmessage = (e: MessageEvent<{ ok: true; results: AreaResult[] } | { ok: false; error: string }>) => {
      runBtn.disabled = false;
      if (!e.data.ok) {
        $('runStatus').textContent = `計算に失敗しました: ${e.data.error}`;
        return;
      }
      state.results = e.data.results;
      state.selected = state.results.map((r) => (r.plans.length ? 0 : -1));
      resetEdit();
      const sec = ((performance.now() - started) / 1000).toFixed(1);
      $('runStatus').textContent = `${state.results.length} エリアを試算しました（${sec} 秒）。エリアごとに行をクリックすると案を切り替えます。`;
      drawAll();
      renderResults();
      persist();
    };
    worker.postMessage(input);
  };

  // 保存してあった割付結果（手直しを含む）を表示する
  if (project.result && project.result.zone === project.zone) {
    state.results = project.result.areas.map((a, i) => ({
      kind: a.kind,
      source: i,
      outer: a.outer,
      holes: a.holes,
      entrances: [],
      plans: a.plan ? [a.plan] : [],
      warnings: [],
    }));
    state.selected = state.results.map((r) => (r.plans.length ? 0 : -1));
    state.edited = project.result.edited;
    $('runStatus').textContent = state.edited ? '保存した割付（手直しあり）を表示しています。' : '保存した割付を表示しています。';
    drawAll();
    renderResults();
  }

  // ---- 保存・出力 ----
  const nameInput = $<HTMLInputElement>('projectName');
  nameInput.value = project.name;
  nameInput.onchange = () => {
    project.name = nameInput.value.trim();
    persist();
  };
  const base = () => `${today()}_${fileBaseName(project.name)}`;
  const planeInputs = () => {
    const pj = projection();
    return {
      boundary: site.boundary.map((p) => pj.toPlane(p)),
      obstacles: site.obstacles.map((o) => o.map((p) => pj.toPlane(p))),
      entrances: site.entrances.map((e) => editor.entranceSegmentPlane(e)).filter((s): s is NonNullable<typeof s> => !!s),
    };
  };

  $('dxfBtn').onclick = () => {
    const dxf = buildDxf({ ...planeInputs(), areas: selectedAreas(), zoneLabel: ZONE_LABELS[project.zone - 1] });
    download(`${base()}_block.dxf`, new Blob([dxf], { type: 'application/dxf' }));
  };

  $('xlsxBtn').onclick = async () => {
    const btn = $<HTMLButtonElement>('xlsxBtn');
    btn.disabled = true;
    try {
      const { buildXlsx } = await import('./export/xlsx');
      const buf = await buildXlsx({ name: project.name, date: new Date(), zoneLabel: ZONE_LABELS[project.zone - 1], areas: selectedAreas() });
      download(`${base()}_count.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) {
      alert(`Excel の作成に失敗しました: ${e instanceof Error ? e.message : e}`);
    } finally {
      btn.disabled = false;
    }
  };

  $('pdfBtn').onclick = async () => {
    const btn = $<HTMLButtonElement>('pdfBtn');
    const status = $('pdfStatus');
    btn.disabled = true;
    const photo = $<HTMLSelectElement>('pdfPhoto').value === 'photo';
    status.textContent = photo ? '背景写真を取得して PDF を作っています…' : 'PDF を作っています…';
    try {
      const { buildPdf } = await import('./export/pdf');
      const scaleSel = $<HTMLSelectElement>('pdfScale').value;
      const pj = projection();
      const res = await buildPdf({
        ...planeInputs(),
        name: project.name,
        date: new Date(),
        zoneLabel: ZONE_LABELS[project.zone - 1],
        areas: selectedAreas(),
        paper: $<HTMLSelectElement>('pdfPaper').value as Paper,
        scale: scaleSel === 'auto' ? 'auto' : Number(scaleSel),
        photo,
        toLatLng: (p) => pj.toLatLng(p),
      });
      download(`${base()}_plan.pdf`, new Blob([res.data], { type: 'application/pdf' }));
      const notes = [`縮尺 1/${res.scale} で保存しました。`];
      if (!res.fits) notes.push('敷地が作図範囲に収まっていません。用紙を大きくするか縮尺を小さくしてください。');
      if (res.photo === 'failed') notes.push('背景写真を取得できなかったため、線画のみで保存しました。');
      status.textContent = notes.join('');
    } catch (e) {
      status.textContent = `PDF の作成に失敗しました: ${e instanceof Error ? e.message : e}`;
    } finally {
      btn.disabled = false;
    }
  };

  $('saveProject').onclick = () => {
    syncProject();
    download(`${base()}.parking.json`, new Blob([serializeProject(project)], { type: 'application/json' }));
  };

  const fileInput = $<HTMLInputElement>('projectFile');
  $('openProject').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const loaded = parseProject(JSON.parse(await file.text()));
      if (site.boundary.length >= 3 && !confirm(`「${loaded.name || file.name}」を開きます。今の敷地と条件は置き換わります。よろしいですか？`)) return;
      // 地図・編集状態を作り直すため、保存してから読み込み直す
      store.save(KEY_PROJECT, loaded);
      location.reload();
    } catch (e) {
      alert(`案件ファイルを読み込めませんでした: ${e instanceof Error ? e.message : e}`);
    }
  };

  function syncProject() {
    project.view = map.getView();
    project.baseLayer = baseSel.value;
    project.name = nameInput.value.trim();
    project.result = state.results.length
      ? {
          zone: project.zone,
          edited: state.edited,
          areas: selectedAreas().map((a) => ({ kind: a.kind, outer: a.outer, holes: a.holes, plan: a.plan })),
        }
      : undefined;
  }

  function persist() {
    syncProject();
    store.save(KEY_PROJECT, project);
  }
  window.addEventListener('beforeunload', persist);
}

function swatch(color: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'swatch';
  s.style.background = color;
  return s;
}

function note(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  return p;
}

function listItem(label: string, onDelete: () => void): HTMLLIElement {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = label;
  span.style.flex = '1';
  const btn = document.createElement('button');
  btn.className = 'link';
  btn.textContent = '削除';
  btn.onclick = onDelete;
  li.append(span, btn);
  li.style.gap = '6px';
  return li;
}

type NumKey = 'stallWidth' | 'stallLength' | 'parallelLength' | 'parallelWidth' | 'trunkWidth' | 'entranceWidth' | 'wheelchairCount' | 'wheelchairWidth' | 'setback';

/** 車種 kind の寸法入力欄を作る */
function buildParamsForm(kind: VehicleKind, all: Record<VehicleKind, LayoutParams>, onChange: () => void) {
  const params = () => all[kind];
  const numField = (label: string, k: NumKey, step: number) => ({
    label,
    get: () => params()[k],
    set: (v: number) => (params()[k] = v),
    step,
    min: k === 'wheelchairCount' || k === 'setback' ? 0 : 0.1,
  });
  const extra: [string, NumKey, number][] = [
    ['縦列マス 長さ（m）', 'parallelLength', 0.05],
    ['縦列マス 幅（m）', 'parallelWidth', 0.05],
    ['幹線車路幅（m）', 'trunkWidth', 0.05],
  ];
  if (kind === 'normal') {
    extra.push(['出入口幅（m）', 'entranceWidth', 0.05], ['車いす用 台数', 'wheelchairCount', 1], ['車いす用 マス幅（m）', 'wheelchairWidth', 0.05]);
  }
  extra.push(['境界・障害物からの離れ（m）', 'setback', 0.05]);
  const fields = [
    numField('マス幅（m）', 'stallWidth', 0.05),
    numField('マス奥行（m）', 'stallLength', 0.05),
    ...([90, 60, 45, 0] as AngleType[]).map((a) => ({
      label: `車路幅 ${ANGLE_LABELS[a]}（m）`,
      get: () => params().aisle[a],
      set: (v: number) => (params().aisle[a] = v),
      step: 0.05,
      min: 0.1,
    })),
    ...extra.map(([label, k, step]) => numField(label, k, step)),
  ];

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
    cb.checked = params().angles.includes(a);
    cb.onchange = () => {
      params().angles = ([90, 60, 45, 0] as AngleType[]).filter((x) => (x === a ? cb.checked : params().angles.includes(x)));
      onChange();
    };
    label.append(cb, ` ${ANGLE_LABELS[a]}`);
    angles.append(label);
  }

  const options = $('options');
  options.innerHTML = '';
  for (const [key, text] of [
    ['loopAisles', '行き止まり車路をなくす（周回車路）'],
    ['infill', '幹線車路・車路沿いの余白にマスを追加'],
  ] as const) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = params()[key];
    cb.onchange = () => {
      params()[key] = cb.checked;
      onChange();
    };
    label.append(cb, ` ${text}`);
    options.append(label);
  }

  $('resetParams').onclick = () => {
    all[kind] = withDefaults(kind);
    buildParamsForm(kind, all, onChange);
    onChange();
  };
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

main();
