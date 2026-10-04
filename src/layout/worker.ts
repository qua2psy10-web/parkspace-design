import { generatePlans, type SiteInput } from './generator';
import type { LayoutParams } from './standards';

// 割付計算を画面とは別スレッドで行う
self.onmessage = (e: MessageEvent<{ site: SiteInput; params: LayoutParams }>) => {
  try {
    const plans = generatePlans(e.data.site, e.data.params);
    self.postMessage({ ok: true, plans });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
