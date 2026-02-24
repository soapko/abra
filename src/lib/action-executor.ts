/**
 * Action executor - maps LLM decisions to puppet browser commands
 */

import createDebug from 'debug';
import type { Action } from './llm.js';
import type { PageElement } from './page-analyzer.js';
import type { DocumentWriter } from './document-writer.js';

const debug = createDebug('abra:executor');

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface ScreenshotOptions {
  clip?: { x: number; y: number; width: number; height: number };
  selector?: string;
  fullPage?: boolean;
}

// Browser interface (subset of puppet API we need)
export interface Browser {
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  hover(selector: string): Promise<void>;
  drag(sourceSelector: string, targetSelector: string): Promise<void>;
  dragCoordinates(sourceX: number, sourceY: number, targetX: number, targetY: number): Promise<void>;
  scroll(direction: 'up' | 'down', amount?: number): Promise<void>;
  wait(ms: number): Promise<void>;
  waitForLoaded(timeout?: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer | string>;
  // Press a key (Enter, Escape, Tab, etc.)
  press?(key: string): Promise<void>;
  // Optional coordinate-based click for fallback
  mouse?: {
    click(x: number, y: number): Promise<void>;
  };
  // Navigation
  goto?(url: string): Promise<void>;
  // Tab management
  newTab?(url?: string): Promise<string>;
  switchTab?(tabId: string): Promise<void>;
  closeTab?(tabId?: string): Promise<void>;
  listTabs?(): Promise<TabInfo[]>;
}

export interface ExecutionResult {
  success: boolean;
  error?: string;
  duration: number;
}

/**
 * Find the element from page analysis by ID
 */
function findElement(elements: PageElement[], elementId: number): PageElement | undefined {
  return elements.find(el => el.id === elementId);
}

/**
 * Check if error is recoverable via coordinate click
 */
function isRecoverableClickError(errorMsg: string): boolean {
  return (
    errorMsg.includes('strict mode violation') ||  // Multiple elements match selector
    errorMsg.includes('is covered by') ||          // Element obscured by overlay
    errorMsg.includes('intercept') ||              // Click intercepted by another element
    errorMsg.includes('not visible') ||            // Element not visible
    errorMsg.includes('outside of the viewport') ||// Element scrolled out of view
    errorMsg.includes('Timeout') ||                // Selector timeout (shadow DOM)
    errorMsg.includes('>>>') ||                    // Shadow DOM selector (not supported by Playwright)
    errorMsg.includes('__SHADOW_DOM__')            // Our shadow DOM marker
  );
}

/**
 * Try clicking with selector, fallback to direct JS click, then coordinates
 */
async function tryClickWithFallback(
  browser: Browser,
  selector: string,
  element: PageElement | null | undefined
): Promise<void> {
  try {
    await browser.click(selector);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    debug('Click with selector failed: %s', errorMsg.slice(0, 150));

    const canRecover = isRecoverableClickError(errorMsg);
    if (!canRecover) {
      debug('Cannot recover, rethrowing error');
      throw err;
    }

    // First try: direct JS click on the element (bypasses visual obstruction)
    const escapedSelector = JSON.stringify(selector);
    try {
      debug('Trying direct JS click on %s', selector);
      const jsResult = await browser.evaluate(`
        (function() {
          var el = document.querySelector(${escapedSelector});
          if (!el) return { success: false, reason: 'not found' };
          // Dispatch pointer events first (Radix UI uses pointerdown, not click)
          var rect = el.getBoundingClientRect();
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          var opts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: 1 };
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
          return { success: true };
        })()
      `) as { success: boolean; reason?: string } | null;

      if (jsResult && jsResult.success) {
        debug('Direct JS click succeeded');
        return;
      }
      debug('Direct JS click failed: %s', jsResult?.reason);
    } catch (jsErr) {
      debug('Direct JS click threw: %s', jsErr instanceof Error ? jsErr.message : String(jsErr));
    }

    // Second try: coordinate click
    const hasBounds = !!element?.bounds;
    const hasMouse = !!browser.mouse;
    debug('Recovery check: hasBounds=%s, hasMouse=%s', hasBounds, hasMouse);

    if (hasBounds && browser.mouse) {
      const center = getElementCenter(element!);
      debug('Falling back to coordinate click at (%d, %d)', center.x, center.y);
      await browser.mouse.click(center.x, center.y);
      debug('Coordinate click completed');
    } else {
      debug('Cannot recover, rethrowing error');
      throw err;
    }
  }
}

/**
 * Execute a single action using the browser
 */
export async function executeAction(
  browser: Browser,
  action: Action,
  elements: PageElement[],
  documentWriter?: DocumentWriter
): Promise<ExecutionResult> {
  const startTime = Date.now();

  try {
    switch (action.type) {
      case 'click': {
        // Coordinate-based click (vision fallback or explicit coordinates)
        if (action.sourceX !== undefined && action.sourceY !== undefined && !action.elementId && !action.selector) {
          if (!browser.mouse) throw new Error('Browser does not support coordinate clicks');
          debug('Coordinate click at (%d, %d)', action.sourceX, action.sourceY);
          await browser.mouse.click(action.sourceX, action.sourceY);
          break;
        }

        const element = action.elementId !== undefined
          ? findElement(elements, action.elementId)
          : null;

        const selector = element?.selector || action.selector;
        if (!selector) {
          // No selector - try coordinate click if we have bounds
          if (element?.bounds && browser.mouse) {
            const center = getElementCenter(element);
            debug('No selector, clicking at coordinates (%d, %d)', center.x, center.y);
            await browser.mouse.click(center.x, center.y);
            break;
          }
          throw new Error('No selector for click action');
        }

        debug('Clicking:', selector);
        await tryClickWithFallback(browser, selector, element);
        break;
      }

      case 'drag': {
        // Coordinate-based drag (for captchas and elements not in the DOM tree)
        if (action.sourceX !== undefined && action.sourceY !== undefined &&
            action.targetX !== undefined && action.targetY !== undefined) {
          debug('Coordinate drag: (%d,%d) → (%d,%d)', action.sourceX, action.sourceY, action.targetX, action.targetY);
          await browser.dragCoordinates(action.sourceX, action.sourceY, action.targetX, action.targetY);
          break;
        }

        // Selector-based drag
        const sourceElement = action.elementId !== undefined
          ? findElement(elements, action.elementId)
          : null;
        const targetElement = action.targetElementId !== undefined
          ? findElement(elements, action.targetElementId)
          : null;

        const sourceSelector = sourceElement?.selector || action.selector;
        const targetSelector = targetElement?.selector || action.targetSelector;

        if (!sourceSelector || !targetSelector) {
          throw new Error('Need both source and target selectors (or sourceX/Y + targetX/Y coordinates) for drag action');
        }

        debug('Dragging: %s → %s', sourceSelector, targetSelector);
        await browser.drag(sourceSelector, targetSelector);
        break;
      }

      case 'type': {
        const element = action.elementId !== undefined
          ? findElement(elements, action.elementId)
          : null;

        const selector = element?.selector || action.selector;
        if (!action.text) {
          throw new Error('No text for type action');
        }

        // If we have a selector, check focus and click if needed
        if (selector) {
          debug('Typing "%s" into: %s', action.text, selector);

          // Check if target element already has focus (e.g. from a prior click action in batch)
          const escapedSelector = JSON.stringify(selector);
          const alreadyFocused = await browser.evaluate(`
            (function() {
              var target = document.querySelector(${escapedSelector});
              if (!target) return false;
              var active = document.activeElement;
              if (!active) return false;
              if (active === target) return true;
              if (target.contains(active)) return true;
              if (target.shadowRoot && target.shadowRoot.contains(active)) return true;
              return false;
            })()
          `) as boolean;

          if (!alreadyFocused) {
            debug('Element not focused, clicking to focus');
            const isShadowElement = selector.includes('>>>') || selector.includes('__SHADOW_DOM__');
            if (isShadowElement && element?.bounds && browser.mouse) {
              const center = getElementCenter(element);
              debug('Shadow DOM element - clicking at (%d, %d)', center.x, center.y);
              await browser.mouse.click(center.x, center.y);
            } else {
              await tryClickWithFallback(browser, selector, element);
            }
            await browser.wait(100);
          } else {
            debug('Element already focused, skipping click');
          }
        } else {
          // No selector — type into whatever currently has focus
          debug('Typing "%s" into currently focused element (no selector)', action.text);
        }

        // Type into the focused element using multi-strategy simulation
        // Strategy 1: execCommand('insertText') — triggers all framework observers
        // Strategy 2: Per-character InputEvent — works with modern event listeners
        // Strategy 3: Native setter + synthetic events — fallback for React inputs
        const escapedText = JSON.stringify(action.text);
        await browser.evaluate(`
          (function() {
            var text = ${escapedText};
            var el = document.activeElement;
            // If active element is a shadow host, try to find the input inside
            if (el && el.shadowRoot) {
              var inner = el.shadowRoot.querySelector('input, textarea, [contenteditable]');
              if (inner) { inner.focus(); el = inner; }
            }
            if (!el) return;

            // Clear existing value first
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (el.isContentEditable) {
              el.textContent = '';
            }

            // Strategy 1: execCommand('insertText') — most reliable across frameworks
            // Triggers beforeinput, input, and all MutationObserver callbacks
            try {
              var ok = document.execCommand('insertText', false, text);
              if (ok) {
                // Verify the text was actually inserted
                var currentVal = el.value !== undefined ? el.value : el.textContent;
                if (currentVal && currentVal.indexOf(text) !== -1) return;
              }
            } catch(e) {}

            // Strategy 2: Per-character InputEvent with insertText type
            // Works with search inputs that listen for keyboard-like events
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
              el.value = '';
              for (var i = 0; i < text.length; i++) {
                var ch = text[i];
                el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true }));
                el.dispatchEvent(new InputEvent('beforeinput', { data: ch, inputType: 'insertText', bubbles: true, cancelable: true }));
                el.value += ch;
                el.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true }));
              }
              // Verify insertion worked
              if (el.value === text) return;
            }

            // Strategy 3: Native setter + synthetic events (React, Angular)
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
              var nativeSetter = Object.getOwnPropertyDescriptor(
                el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
                'value'
              );
              if (nativeSetter && nativeSetter.set) {
                nativeSetter.set.call(el, text);
              } else {
                el.value = text;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (el.isContentEditable) {
              el.textContent = text;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            }
          })()
        `);
        break;
      }

      case 'hover': {
        const element = action.elementId !== undefined
          ? findElement(elements, action.elementId)
          : null;

        const selector = element?.selector || action.selector;
        if (!selector) {
          throw new Error('No selector for hover action');
        }

        debug('Hovering:', selector);
        await browser.hover(selector);
        break;
      }

      case 'scroll': {
        const direction = action.direction || 'down';
        const amount = action.amount || 300;

        debug('Scrolling %s %dpx', direction, amount);
        await browser.scroll(direction, amount);
        break;
      }

      case 'press': {
        const key = action.key || 'Enter';
        debug('Pressing key: %s', key);
        if (browser.press) {
          await browser.press(key);
        } else {
          // Fallback: use evaluate to dispatch key event
          await browser.evaluate(`
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }));
            document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key: '${key}', bubbles: true }));
          `);
        }
        break;
      }

      case 'wait': {
        const duration = action.duration || 1000;
        debug('Waiting %dms', duration);
        await browser.wait(duration);
        break;
      }

      case 'document': {
        if (!action.document) {
          throw new Error('No document config for document action');
        }
        if (!documentWriter) {
          throw new Error('Document writer not initialized');
        }

        const { operation, filename, content, section } = action.document;
        debug('Document action: %s %s', operation, filename);

        switch (operation) {
          case 'create':
            if (!content) throw new Error('No content for create operation');
            const createResult = await documentWriter.create(filename, content);
            if (!createResult.success) throw new Error(createResult.error);
            break;

          case 'read':
            const readResult = await documentWriter.read(filename);
            if (!readResult.success) throw new Error(readResult.error);
            // Content is stored in documentWriter.lastReadContent for next LLM call
            break;

          case 'update':
            if (!content) throw new Error('No content for update operation');
            const updateResult = await documentWriter.update(filename, content, section);
            if (!updateResult.success) throw new Error(updateResult.error);
            break;

          case 'append':
            if (!content) throw new Error('No content for append operation');
            const appendResult = await documentWriter.append(filename, content);
            if (!appendResult.success) throw new Error(appendResult.error);
            break;

          default:
            throw new Error(`Unknown document operation: ${operation}`);
        }
        break;
      }

      case 'navigate': {
        if (!action.url) throw new Error('No URL for navigate action');
        if (!browser.goto) throw new Error('Browser does not support navigation');
        debug('Navigating to:', action.url);
        await browser.goto(action.url);
        break;
      }

      case 'newTab': {
        if (!browser.newTab) throw new Error('Browser does not support tab management');
        debug('Opening new tab%s', action.url ? `: ${action.url}` : '');
        await browser.newTab(action.url);
        break;
      }

      case 'switchTab': {
        if (!browser.switchTab) throw new Error('Browser does not support tab management');
        if (!action.tabId) throw new Error('No tabId for switchTab action');
        debug('Switching to tab:', action.tabId);
        await browser.switchTab(action.tabId);
        break;
      }

      case 'closeTab': {
        if (!browser.closeTab) throw new Error('Browser does not support tab management');
        debug('Closing tab:', action.tabId || 'active');
        await browser.closeTab(action.tabId);
        break;
      }

      case 'done':
      case 'failed':
        // These are terminal actions, no browser interaction needed
        debug('Terminal action:', action.type, action.reason);
        break;

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }

    return {
      success: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    debug('Action failed:', error);

    return {
      success: false,
      error,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Get the center coordinates of an element for cursor positioning
 */
export function getElementCenter(element: PageElement): { x: number; y: number } {
  return {
    x: element.bounds.x + element.bounds.width / 2,
    y: element.bounds.y + element.bounds.height / 2,
  };
}

/**
 * Add a random human-like delay
 */
export function getHumanDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
