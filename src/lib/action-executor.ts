/**
 * Action executor - maps LLM decisions to puppet browser commands
 */

import createDebug from 'debug';
import type { Action } from './llm.js';
import type { PageElement } from './page-analyzer.js';
import type { DocumentWriter } from './document-writer.js';

const debug = createDebug('abra:executor');

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
  screenshot(): Promise<Buffer | string>;
  // Press a key (Enter, Escape, Tab, etc.)
  press?(key: string): Promise<void>;
  // Optional coordinate-based click for fallback
  mouse?: {
    click(x: number, y: number): Promise<void>;
  };
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
 * Try clicking with selector, fallback to coordinates if selector fails
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

    // Check if we can recover by clicking at coordinates
    const canRecover = isRecoverableClickError(errorMsg);
    const hasBounds = !!element?.bounds;
    const hasMouse = !!browser.mouse;

    debug('Recovery check: canRecover=%s, hasBounds=%s, hasMouse=%s', canRecover, hasBounds, hasMouse);

    if (canRecover && hasBounds && browser.mouse) {
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
        if (!selector) {
          throw new Error('No selector for type action');
        }
        if (!action.text) {
          throw new Error('No text for type action');
        }

        debug('Typing "%s" into:', action.text, selector);

        // Check if this is a shadow DOM element (selector contains >>> or __SHADOW_DOM__)
        const isShadowElement = selector.includes('>>>') || selector.includes('__SHADOW_DOM__');

        if (isShadowElement && element?.bounds && browser.mouse) {
          // For shadow DOM: click at coordinates, then type via keyboard events
          const center = getElementCenter(element);
          debug('Shadow DOM element - clicking at (%d, %d) then typing via keyboard', center.x, center.y);
          await browser.mouse.click(center.x, center.y);
          await browser.wait(100); // Small delay for focus

          // Type using keyboard events - escape the text for JavaScript
          const escapedText = JSON.stringify(action.text);
          await browser.evaluate(`
            (function() {
              const text = ${escapedText};
              const el = document.activeElement;
              if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
                // Clear existing value
                if (el.value !== undefined) el.value = '';
                // Set new value
                if (el.value !== undefined) {
                  el.value = text;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                  el.textContent = text;
                  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
                }
              }
            })()
          `);
        } else {
          // Regular element: focus first with fallback, then type
          await tryClickWithFallback(browser, selector, element);
          await browser.type(selector, action.text);
        }
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
