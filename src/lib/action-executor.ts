/**
 * Action executor - maps LLM decisions to puppet browser commands
 */

import createDebug from 'debug';
import type { Action } from './llm.js';
import type { PageElement } from './page-analyzer.js';

const debug = createDebug('abra:executor');

// Browser interface (subset of puppet API we need)
export interface Browser {
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  hover(selector: string): Promise<void>;
  scroll(direction: 'up' | 'down', amount?: number): Promise<void>;
  wait(ms: number): Promise<void>;
  waitForLoaded(timeout?: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  screenshot(): Promise<Buffer | string>;
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
 * Execute a single action using the browser
 */
export async function executeAction(
  browser: Browser,
  action: Action,
  elements: PageElement[]
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
          throw new Error('No selector for click action');
        }

        debug('Clicking:', selector);
        await browser.click(selector);
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
        await browser.click(selector); // Focus first
        await browser.type(selector, action.text);
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

      case 'wait': {
        const duration = action.duration || 1000;
        debug('Waiting %dms', duration);
        await browser.wait(duration);
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
