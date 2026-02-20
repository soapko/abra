/**
 * Adaptive DOM settle detection using MutationObserver.
 *
 * Replaces fixed `waitForLoaded(2000)` with a dynamic approach that resolves
 * when the DOM stops changing (quiet period) or hits a hard timeout cap.
 * Fast pages go fast, slow pages get patience.
 */

import createDebug from 'debug';
import type { Browser } from './action-executor.js';

const debug = createDebug('abra:settle');

export interface DOMSettleOptions {
  /** Max wait time in ms. Default: 2000 */
  timeout?: number;
  /** How long mutations must be quiet before resolving. Default: 100 */
  quietPeriod?: number;
}

/**
 * Wait for the DOM to stop changing after an action.
 * Uses MutationObserver injected into the page context.
 *
 * Behavior:
 * - Static page click: settles in ~20ms
 * - React input: settles in ~100-150ms (framework render cycle)
 * - API call + skeleton loading: settles in ~500ms-2s
 * - Chatty site (ads, analytics): hits 2s hard cap (same as old behavior)
 *
 * If the page navigates (destroying the old context), the evaluate()
 * call will reject — we catch this and resolve immediately since
 * navigation itself is the "settle" signal.
 */
export async function waitForDOMSettle(
  browser: Browser,
  options: DOMSettleOptions = {}
): Promise<void> {
  const { timeout = 2000, quietPeriod = 100 } = options;

  try {
    await browser.evaluate(`
      new Promise((resolve) => {
        if (!document.body) { resolve(); return; }

        let timer;
        let hardTimeout;

        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            clearTimeout(hardTimeout);
            resolve();
          }, ${quietPeriod});
        });

        observer.observe(document.body, {
          childList: true, subtree: true,
          attributes: true, characterData: true
        });

        hardTimeout = setTimeout(() => {
          observer.disconnect();
          clearTimeout(timer);
          resolve();
        }, ${timeout});

        timer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, ${quietPeriod});
      });
    `);
  } catch {
    // Page likely navigated — the old context is gone.
    // Navigation itself is the "settle" signal, so resolve immediately.
    debug('evaluate() rejected (page likely navigated) — treating as settled');
  }
}
