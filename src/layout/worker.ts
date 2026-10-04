import { type AreasInput, layoutAreas } from './areas';

// 割付計算を画面とは別スレッドで行う
self.onmessage = (e: MessageEvent<AreasInput>) => {
  try {
    const results = layoutAreas(e.data);
    self.postMessage({ ok: true, results });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
