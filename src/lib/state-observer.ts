/**
 * State observer — captures DOM state changes after an action.
 *
 * Installs a MutationObserver on the target element's parent container before
 * an action, then collects mutations after to produce a StateDelta.
 * Only captures structural changes (focus, aria, visibility), ignoring
 * cosmetic noise (CSS classes, styles, animations).
 */

import createDebug from 'debug';
import type { Browser } from './action-executor.js';

const debug = createDebug('abra:state-observer');

export interface ElementSignature {
  tagName: string;
  role?: string;
  ariaLabel?: string;
  testId?: string;
  textContent?: string;  // Truncated to 50 chars
  nthOfType?: number;
}

export interface StateDelta {
  focusChanged?: {
    gainedFocus?: ElementSignature;
  };
  ariaChanges?: Array<{
    signature: ElementSignature;
    attribute: string;
    newValue: string | null;
  }>;
  visibilityChanges?: Array<{
    signature: ElementSignature;
    appeared: boolean;
  }>;
  urlChanged?: {
    to: string;
  };
  newContentLoaded?: boolean;
}

/**
 * Install a MutationObserver on the target's parent container and snapshot baseline state.
 * Call this BEFORE executing the action.
 */
export async function installObserver(
  browser: Browser,
  targetSelector?: string
): Promise<void> {
  try {
    await browser.evaluate(`
      (function() {
        var target = ${targetSelector ? `document.querySelector(${JSON.stringify(targetSelector)})` : 'null'};
        var container = (target && target.parentElement) || document.body;
        if (!container) return;

        function getSignature(el) {
          if (!el || !el.tagName) return null;
          var sig = { tagName: el.tagName };
          var role = el.getAttribute && el.getAttribute('role');
          if (role) sig.role = role;
          var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
          if (ariaLabel) sig.ariaLabel = ariaLabel;
          var testId = el.getAttribute && el.getAttribute('data-testid');
          if (testId) sig.testId = testId;
          var text = el.textContent;
          if (text) sig.textContent = text.trim().slice(0, 50);
          var nth = 0;
          var sibling = el.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === el.tagName) nth++;
            sibling = sibling.previousElementSibling;
          }
          sig.nthOfType = nth;
          return sig;
        }

        window.__ABRA_STATE_OBSERVER__ = {
          container: container,
          baselineUrl: window.location.href,
          baselineFocus: getSignature(document.activeElement),
          mutations: [],
          observer: null,
          getSignature: getSignature
        };

        var obs = new MutationObserver(function(records) {
          window.__ABRA_STATE_OBSERVER__.mutations.push.apply(
            window.__ABRA_STATE_OBSERVER__.mutations, records
          );
        });

        obs.observe(container, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            'aria-expanded', 'aria-hidden', 'aria-selected', 'aria-checked',
            'aria-disabled', 'aria-busy', 'data-loading', 'data-state',
            'data-open', 'hidden', 'open'
          ],
          characterData: false
        });

        window.__ABRA_STATE_OBSERVER__.observer = obs;
      })();
    `);
  } catch {
    debug('Failed to install state observer (page may have navigated)');
  }
}

/**
 * Collect mutations from the observer and compute a StateDelta.
 * Call this AFTER the action has executed and DOM has settled.
 */
export async function collectObservation(
  browser: Browser
): Promise<StateDelta | null> {
  try {
    const delta = await browser.evaluate(`
      (function() {
        var obs = window.__ABRA_STATE_OBSERVER__;
        if (!obs || !obs.observer) return null;

        obs.observer.disconnect();

        var getSignature = obs.getSignature;
        var delta = {};

        // Focus change
        var newFocus = getSignature(document.activeElement);
        var oldFocus = obs.baselineFocus;
        if (newFocus && (!oldFocus ||
          newFocus.tagName !== oldFocus.tagName ||
          newFocus.testId !== oldFocus.testId ||
          newFocus.ariaLabel !== oldFocus.ariaLabel)) {
          delta.focusChanged = { gainedFocus: newFocus };
        }

        // URL change
        var newUrl = window.location.href;
        if (newUrl !== obs.baselineUrl) {
          delta.urlChanged = { to: newUrl };
        }

        // Process mutations
        var ariaChanges = [];
        var addedElements = [];
        var removedElements = [];

        for (var i = 0; i < obs.mutations.length; i++) {
          var record = obs.mutations[i];
          if (record.type === 'attributes') {
            var attr = record.attributeName;
            if (attr) {
              var sig = getSignature(record.target);
              if (sig) {
                ariaChanges.push({
                  signature: sig,
                  attribute: attr,
                  newValue: record.target.getAttribute(attr)
                });
              }
            }
          } else if (record.type === 'childList') {
            for (var j = 0; j < record.addedNodes.length; j++) {
              var added = record.addedNodes[j];
              if (added.nodeType === 1) addedElements.push(added);
            }
            for (var k = 0; k < record.removedNodes.length; k++) {
              var removed = record.removedNodes[k];
              if (removed.nodeType === 1) removedElements.push(removed);
            }
          }
        }

        if (ariaChanges.length > 0) {
          delta.ariaChanges = ariaChanges.slice(0, 10);
        }

        // Visibility changes: elements that appeared but weren't also removed (and vice versa)
        var visibilityChanges = [];
        var removedSet = new Set(removedElements);
        var addedSet = new Set(addedElements);

        for (var a = 0; a < addedElements.length && visibilityChanges.length < 10; a++) {
          if (!removedSet.has(addedElements[a])) {
            var addedSig = getSignature(addedElements[a]);
            if (addedSig) visibilityChanges.push({ signature: addedSig, appeared: true });
          }
        }
        for (var r = 0; r < removedElements.length && visibilityChanges.length < 10; r++) {
          if (!addedSet.has(removedElements[r])) {
            var removedSig = getSignature(removedElements[r]);
            if (removedSig) visibilityChanges.push({ signature: removedSig, appeared: false });
          }
        }
        if (visibilityChanges.length > 0) {
          delta.visibilityChanges = visibilityChanges;
        }

        // Content loaded check
        if (ariaChanges.some(function(c) {
          return (c.attribute === 'data-loading' && c.newValue === 'false') ||
                 (c.attribute === 'aria-busy' && c.newValue === 'false');
        })) {
          delta.newContentLoaded = true;
        }

        delete window.__ABRA_STATE_OBSERVER__;

        return Object.keys(delta).length > 0 ? delta : null;
      })();
    `) as StateDelta | null;

    return delta;
  } catch {
    debug('Failed to collect observation (page may have navigated)');
    return null;
  }
}

/**
 * Tear down the observer without recording.
 * Call this when the action failed — don't learn from failed actions.
 */
export async function teardownObserver(
  browser: Browser
): Promise<void> {
  try {
    await browser.evaluate(`
      (function() {
        var obs = window.__ABRA_STATE_OBSERVER__;
        if (obs && obs.observer) obs.observer.disconnect();
        delete window.__ABRA_STATE_OBSERVER__;
      })();
    `);
  } catch {
    // Page may have navigated
  }
}
