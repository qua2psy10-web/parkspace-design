import type { Pt } from '../geo/projection';
import type { Arrow } from './generator';

/** 矢印を1本の折れ線（軸 → 矢じり）にする。矢じりの長さは m */
export function arrowPolyline(a: Arrow, head = 1.2): Pt[] {
  const dx = a.to.x - a.from.x;
  const dy = a.to.y - a.from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const wing = (s: number) => ({
    x: a.to.x - head * ux + s * head * 0.6 * -uy,
    y: a.to.y - head * uy + s * head * 0.6 * ux,
  });
  return [a.from, a.to, wing(1), a.to, wing(-1)];
}
