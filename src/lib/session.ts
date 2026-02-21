/**
 * Session orchestrator - main loop for persona simulation
 */

import { mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import createDebug from 'debug';
import type { PersonaConfig } from './persona.js';
import { getThinkingDelay } from './persona.js';
import type { PageState, PageElement } from './page-analyzer.js';
import { PAGE_ANALYZER_SCRIPT } from './page-analyzer.js';
import {
  getNextAction,
  getNextActionFromScreenshot,
  formatAction,
  formatVisionAction,
  formatBatchFeedback,
  type Action,
  type BatchThinkingResult,
  type VisionBatchThinkingResult,
} from './llm.js';
import {
  getAnnotationScript,
  getRemoveAnnotationScript,
  formatElementLegend,
} from './screenshot-annotator.js';
import { executeAction, getElementCenter, getHumanDelay, type Browser } from './action-executor.js';
import {
  getInitScript,
  getShowScript,
  getShowThinkingScript,
  getHideScript,
  getDestroyScript,
} from './speech-bubble.js';
import { DocumentWriter } from './document-writer.js';
import { PAGE_CONTENT_SCRIPT, type PageContent } from './page-content-extractor.js';
import { getObserverAction, type ObserverResult } from './observer-llm.js';
import { waitForDOMSettle } from './dom-settle.js';
import {
  PlaybookStore,
  toRelative,
  toAbsolute,
  type RecordedOperation,
  type PlaybookOperation,
} from './playbook-store.js';

const debug = createDebug('abra:session');

/** Observer timeout — never let a slow observer delay navigation */
const OBSERVER_TIMEOUT_MS = 30_000;

export interface GoalResult {
  description: string;
  status: 'completed' | 'failed' | 'timeout';
  duration: number;
  actions: number;
  video?: string;
  failureReason?: string;
  transcript: string[];
}

export interface SessionResult {
  persona: string;
  startedAt: string;
  completedAt: string;
  goals: GoalResult[];
}

export interface SessionOptions {
  outputDir: string;
  headless?: boolean;
  sightMode?: boolean;
  observe?: boolean;
  /** Enable playbook recording and replay. Default: true */
  playbooks?: boolean;
  onThought?: (thought: string, goalIndex: number) => void;
  onAction?: (action: string, goalIndex: number) => void;
  onObservation?: (observation: string, goalIndex: number) => void;
}

/**
 * Create the output directory structure
 */
async function ensureOutputDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Generate a slug from a string
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

interface BatchActionResult {
  actionDesc: string;
  success: boolean;
  error?: string;
}

interface BatchExecutionResult {
  results: BatchActionResult[];
  completedCount: number;
  terminalAction?: Action;
  urlChanged: boolean;
  bailReason?: string;
  /** Operations recorded during execution (for playbook creation) */
  recordedOps: RecordedOperation[];
}

/**
 * Get the current viewport dimensions from the browser.
 */
async function getViewport(browser: Browser): Promise<{ width: number; height: number }> {
  try {
    const dims = await browser.evaluate(
      'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })'
    ) as string;
    return JSON.parse(dims);
  } catch {
    return { width: 1440, height: 900 }; // fallback
  }
}

/**
 * Get current scroll position from the browser.
 */
async function getScroll(browser: Browser): Promise<{ x: number; y: number }> {
  try {
    const scroll = await browser.evaluate(
      'JSON.stringify({ x: window.scrollX, y: window.scrollY })'
    ) as string;
    return JSON.parse(scroll);
  } catch {
    return { x: 0, y: 0 };
  }
}

/**
 * Execute a batch of actions with bail-out checks between each.
 * Records each successful operation for playbook creation.
 * Returns results for all executed actions plus any terminal action.
 */
async function executeBatch(
  browser: Browser,
  actions: Action[],
  elements: PageElement[],
  documentWriter: DocumentWriter,
  callbacks: {
    sightMode: boolean;
    onAction: (desc: string) => void;
    onError: (desc: string, error: string) => void;
  },
  playbookStore?: PlaybookStore,
  domain?: string
): Promise<BatchExecutionResult> {
  const batchT0 = Date.now();
  const results: BatchActionResult[] = [];
  const recordedOps: RecordedOperation[] = [];
  let terminalAction: Action | undefined;
  let urlChanged = false;
  let bailReason: string | undefined;

  // Get initial URL for change detection
  let currentUrl: string;
  try {
    currentUrl = await browser.evaluate('window.location.href') as string;
  } catch {
    currentUrl = '';
  }

  const formatFn = callbacks.sightMode ? formatVisionAction : formatAction;
  const viewport = await getViewport(browser);

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    // Terminal action — return for main loop to handle
    if (action.type === 'done' || action.type === 'failed') {
      terminalAction = action;
      break;
    }

    // Playbook reference — expand into operations
    if (action.playbook && playbookStore && domain) {
      const expansion = playbookStore.expand(domain, action.playbook, viewport);
      if (!expansion) {
        // Hallucinated playbook name — skip this action and continue
        debug('Playbook "%s" not found — skipping (LLM may have invented it)', action.playbook);
        results.push({ actionDesc: `Playbook "${action.playbook}" (not found, skipped)`, success: false, error: 'playbook not found' });
        continue;
      }

      debug('Expanding playbook "%s" (%d operations)', action.playbook, expansion.operations.length);

      // Execute each playbook operation inline
      for (let j = 0; j < expansion.operations.length; j++) {
        const op = expansion.operations[j];
        const opDesc = `[playbook "${action.playbook}" step ${j + 1}/${expansion.operations.length}] ${op.type} ${op.selector || ''}`;
        callbacks.onAction(opDesc);

        const opResult = await executePlaybookOperation(browser, op, viewport, documentWriter);
        results.push({ actionDesc: opDesc, success: opResult.success, error: opResult.error });

        if (!opResult.success) {
          bailReason = `playbook "${action.playbook}" failed at step ${j + 1}: ${opResult.error}`;
          callbacks.onError(opDesc, opResult.error!);
          playbookStore.markFailure(expansion.playbook);
          break;
        }

        // Auto-inject DOM settle between operations
        if (j < expansion.operations.length - 1) {
          await waitForDOMSettle(browser);

          // Check URL change
          try {
            const newUrl = await browser.evaluate('window.location.href') as string;
            if (newUrl !== currentUrl) {
              urlChanged = true;
              bailReason = `URL changed during playbook "${action.playbook}" at step ${j + 1}`;
              break;
            }
          } catch {
            urlChanged = true;
            bailReason = `navigation during playbook "${action.playbook}"`;
            break;
          }
        }
      }

      if (bailReason) break;

      // Playbook completed successfully
      playbookStore.markSuccess(expansion.playbook);
      continue;
    }

    const actionT0 = Date.now();
    const actionDesc = formatFn(action);
    callbacks.onAction(actionDesc);

    // Find the target element
    const targetElement = action.elementId !== undefined
      ? elements.find(el => el.id === action.elementId)
      : null;

    // Execute the action
    const execResult = await executeAction(browser, action, elements, documentWriter);
    debug('  Action %d/%d executed in %dms: %s', i + 1, actions.length, Date.now() - actionT0, actionDesc);

    results.push({
      actionDesc,
      success: execResult.success,
      error: execResult.error,
    });

    // Bail on failure
    if (!execResult.success) {
      callbacks.onError(actionDesc, execResult.error!);
      bailReason = `action failed: ${execResult.error}`;
      break;
    }

    // Record the operation for playbook creation
    const scroll = await getScroll(browser);
    const recorded: RecordedOperation = {
      type: action.type as RecordedOperation['type'],
      selector: targetElement?.selector || action.selector,
      text: action.text,
      key: action.key,
      direction: action.direction,
      amount: action.amount,
      duration: action.duration,
      description: actionDesc,
    };

    // Add relative position if we have bounds
    if (targetElement?.bounds) {
      const centerX = targetElement.bounds.x + targetElement.bounds.width / 2;
      const centerY = targetElement.bounds.y + targetElement.bounds.height / 2;
      recorded.position = toRelative(centerX, centerY, viewport, scroll);
    } else if (action.sourceX !== undefined && action.sourceY !== undefined) {
      recorded.position = toRelative(action.sourceX, action.sourceY, viewport, scroll);
    }

    recordedOps.push(recorded);

    // If last action, skip inter-action checks
    if (i === actions.length - 1) break;

    // Inter-action settle (adaptive: waits for DOM mutations to stop)
    await waitForDOMSettle(browser);

    // Check URL change
    try {
      const newUrl = await browser.evaluate('window.location.href') as string;
      if (newUrl !== currentUrl) {
        urlChanged = true;
        bailReason = 'URL changed';
        debug('Batch bail: URL changed from %s to %s', currentUrl, newUrl);
        break;
      }
    } catch {
      urlChanged = true;
      bailReason = 'navigation detected';
      break;
    }

    // Check next action's target element still exists
    const nextAction = actions[i + 1];
    if (nextAction && nextAction.type !== 'done' && nextAction.type !== 'failed' && !nextAction.playbook) {
      const nextElement = nextAction.elementId !== undefined
        ? elements.find(el => el.id === nextAction.elementId)
        : null;
      const nextSelector = nextElement?.selector || nextAction.selector;

      if (nextSelector) {
        try {
          const exists = await browser.evaluate(
            `!!document.querySelector(${JSON.stringify(nextSelector)})`
          ) as boolean;
          if (!exists) {
            bailReason = `next target missing: ${nextSelector}`;
            debug('Batch bail: next target element missing: %s', nextSelector);
            break;
          }
        } catch {
          bailReason = 'element check failed (page may have navigated)';
          urlChanged = true;
          break;
        }
      }
    }
  }

  const batchElapsed = Date.now() - batchT0;
  debug('Batch complete: %d/%d actions in %dms%s',
    results.length, actions.length, batchElapsed,
    bailReason ? ` (bailed: ${bailReason})` : '');

  return {
    results,
    completedCount: results.length,
    terminalAction,
    urlChanged,
    bailReason,
    recordedOps,
  };
}

/**
 * Execute a single playbook operation.
 * Uses selector-first targeting with coordinate fallback.
 */
async function executePlaybookOperation(
  browser: Browser,
  op: PlaybookOperation,
  currentViewport: { width: number; height: number },
  documentWriter: DocumentWriter
): Promise<{ success: boolean; error?: string }> {
  try {
    switch (op.type) {
      case 'click': {
        // Try selector first
        if (op.selector) {
          try {
            await browser.click(op.selector);
            return { success: true };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            debug('Playbook selector click failed: %s — trying coordinate fallback', msg.slice(0, 100));
          }
        }
        // Coordinate fallback
        if (op.position && browser.mouse) {
          const abs = toAbsolute(op.position, currentViewport);
          debug('Playbook coordinate click at (%d, %d)', abs.x, abs.y);
          await browser.mouse.click(abs.x, abs.y);
          return { success: true };
        }
        return { success: false, error: `No selector or coordinates for click` };
      }

      case 'type': {
        if (!op.text) return { success: false, error: 'No text for type operation' };

        // Check if target already has focus (from prior click in sequence)
        let needsClick = true;
        if (op.selector) {
          const escapedSel = JSON.stringify(op.selector);
          needsClick = !(await browser.evaluate(`
            (function() {
              var target = document.querySelector(${escapedSel});
              if (!target) return false;
              var active = document.activeElement;
              if (!active) return false;
              return active === target || target.contains(active) ||
                (target.shadowRoot && target.shadowRoot.contains(active));
            })()
          `) as boolean);
        }

        if (needsClick && op.selector) {
          try {
            await browser.click(op.selector);
          } catch {
            // Click failed — try coordinate fallback
            if (op.position && browser.mouse) {
              const abs = toAbsolute(op.position, currentViewport);
              await browser.mouse.click(abs.x, abs.y);
            }
          }
          await browser.wait(100);
        }

        // Type using multi-strategy simulation (same as action-executor)
        const escapedText = JSON.stringify(op.text);
        await browser.evaluate(`
          (function() {
            var text = ${escapedText};
            var el = document.activeElement;
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

            // Strategy 1: execCommand('insertText')
            try {
              var ok = document.execCommand('insertText', false, text);
              if (ok) {
                var currentVal = el.value !== undefined ? el.value : el.textContent;
                if (currentVal && currentVal.indexOf(text) !== -1) return;
              }
            } catch(e) {}

            // Strategy 2: Per-character InputEvent
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
        return { success: true };
      }

      case 'press': {
        const key = op.key || 'Enter';
        if (browser.press) {
          await browser.press(key);
        } else {
          await browser.evaluate(`
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }));
            document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key: '${key}', bubbles: true }));
          `);
        }
        return { success: true };
      }

      case 'scroll': {
        const direction = op.direction || 'down';
        const amount = op.amount || 300;
        await browser.scroll(direction, amount);
        return { success: true };
      }

      case 'hover': {
        if (op.selector) {
          await browser.hover(op.selector);
          return { success: true };
        }
        return { success: false, error: 'No selector for hover operation' };
      }

      case 'wait': {
        await browser.wait(op.duration || 300);
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown operation type: ${op.type}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run a single goal simulation
 */
async function runGoal(
  browser: Browser,
  persona: PersonaConfig,
  goal: string,
  goalIndex: number,
  options: SessionOptions,
  documentWriter: DocumentWriter,
  playbookStore?: PlaybookStore
): Promise<GoalResult> {
  const startTime = Date.now();
  const actionHistory: string[] = [];
  const transcript: string[] = [];
  let actionCount = 0;
  const timeout = persona.options.timeout;
  const thinkingDelay = getThinkingDelay(persona.options.thinkingSpeed);
  const sightMode = options.sightMode ?? false;

  // Extract domain for playbook lookups
  const domain = new URL(persona.url).hostname;

  // Track all operations for post-session playbook stitching
  const sessionActionLog: RecordedOperation[] = [];

  // Generate unique session IDs for LLM conversations
  // Navigator and Observer each get their own session for independent conversational memory
  const navigatorSessionId = randomUUID();
  const observerSessionId = options.observe ? randomUUID() : undefined;
  const llmSessionId = navigatorSessionId;

  // Track feedback about the last action's result
  let lastActionFeedback: string | null = null;

  debug('Starting goal %d: %s (sightMode: %s, session: %s)', goalIndex + 1, goal, sightMode, llmSessionId.slice(0, 8));

  // Initialize speech bubble
  await browser.evaluate(getInitScript(persona.persona.name));

  try {
    // Main simulation loop
    while (Date.now() - startTime < timeout) {
      // Note: waitForLoaded is called after each action, so we skip it here
      // except for the first iteration (before any action has been taken)
      if (actionCount === 0) {
        try {
          await browser.waitForLoaded(2000);  // Shorter timeout for initial load
        } catch {
          // Ignore timeout - proceed with analysis anyway
        }
      }

      const iterT0 = Date.now();

      // Show "thinking..." bubble while we do analysis + LLM call
      // Use last known position or center of viewport
      const thinkingShownAt = Date.now();
      try {
        await browser.evaluate(getShowThinkingScript(700, 400));
      } catch {
        // Bubble not available, re-inject
        try {
          await browser.evaluate(getInitScript(persona.persona.name));
          await browser.evaluate(getShowThinkingScript(700, 400));
        } catch { /* proceed without bubble */ }
      }

      // Analyze current page (always needed for element mapping)
      const analyzeT0 = Date.now();
      const pageState = await browser.evaluate(PAGE_ANALYZER_SCRIPT) as PageState;
      debug('Page analyzed in %dms: %s (%d elements)', Date.now() - analyzeT0, pageState.title, pageState.elements.length);

      // Extract page content for observer (if enabled)
      let pageContent: PageContent | null = null;
      if (options.observe) {
        try {
          pageContent = await browser.evaluate(PAGE_CONTENT_SCRIPT) as PageContent;
          debug('Page content extracted (%d chars raw text)', pageContent.rawText.length);
        } catch (err) {
          debug('Page content extraction failed (observer will be skipped):', err);
        }
      }

      // Variables for batch result
      let thought: string;
      let actionsToExecute: Action[];
      let targetElement: PageElement | null = null;

      // Build the navigator LLM call (deferred so we can run it concurrently with observer)
      const docIndex = documentWriter.formatIndexForLLM();
      const lastReadContent = documentWriter.getLastReadContent();

      // Get playbook summary for prompt injection
      const playbookSummary = playbookStore
        ? playbookStore.getSummary(domain) || null
        : null;
      if (playbookSummary) {
        debug('Injecting playbook summary (%d chars) into prompt', playbookSummary.length);
      }

      let navigatorPromise: Promise<BatchThinkingResult | VisionBatchThinkingResult>;

      if (sightMode) {
        // SIGHT MODE: Use annotated screenshot for decision-making

        // Inject annotations onto the page
        await browser.evaluate(getAnnotationScript(pageState.elements));
        debug('Annotations injected (%d elements)', pageState.elements.length);

        // Capture annotated screenshot
        const screenshot = await browser.screenshot();
        debug('Annotated screenshot captured (%d bytes)', screenshot.length);

        // Remove annotations
        await browser.evaluate(getRemoveAnnotationScript());

        // Generate element legend for the prompt
        const elementLegend = formatElementLegend(pageState.elements);

        navigatorPromise = getNextActionFromScreenshot(persona, goal, screenshot, elementLegend, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, playbookSummary);
      } else {
        // STANDARD MODE: Use HTML analysis for decision-making
        navigatorPromise = getNextAction(persona, goal, pageState, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, playbookSummary);
      }

      // Build the observer LLM call (if enabled and page content was extracted)
      let observerPromise: Promise<ObserverResult> | null = null;
      if (options.observe && pageContent && observerSessionId) {
        // Wrap observer in a timeout so it never delays navigation
        const observerCall = getObserverAction(persona, goal, pageContent, docIndex, observerSessionId);
        observerPromise = Promise.race([
          observerCall,
          new Promise<ObserverResult>((_, reject) =>
            setTimeout(() => reject(new Error('Observer timeout')), OBSERVER_TIMEOUT_MS)
          ),
        ]);
      }

      // Run navigator and observer concurrently
      const llmT0 = Date.now();
      let navigatorResult: BatchThinkingResult | VisionBatchThinkingResult;
      let observerResult: ObserverResult | null = null;

      if (observerPromise) {
        const [navSettled, obsSettled] = await Promise.allSettled([navigatorPromise, observerPromise]);

        // Handle navigator result (with retry on failure)
        if (navSettled.status === 'fulfilled') {
          navigatorResult = navSettled.value;
        } else {
          debug('Navigator LLM error (retrying):', navSettled.reason);
          await browser.wait(2000);
          if (sightMode) {
            // Re-capture for retry
            await browser.evaluate(getAnnotationScript(pageState.elements));
            const retryScreenshot = await browser.screenshot();
            await browser.evaluate(getRemoveAnnotationScript());
            const retryLegend = formatElementLegend(pageState.elements);
            navigatorResult = await getNextActionFromScreenshot(persona, goal, retryScreenshot, retryLegend, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, playbookSummary);
          } else {
            navigatorResult = await getNextAction(persona, goal, pageState, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, playbookSummary);
          }
        }

        // Handle observer result (failure is non-blocking)
        if (obsSettled.status === 'fulfilled') {
          observerResult = obsSettled.value;
          debug('Observer: %s (salience: %.2f, action: %s)', observerResult.observation.slice(0, 80), observerResult.salience, observerResult.action.type);
        } else {
          debug('Observer failed (non-blocking): %s', obsSettled.reason);
        }
      } else {
        // No observer — navigator only (original behavior)
        try {
          navigatorResult = await navigatorPromise;
        } catch (err) {
          debug('Navigator LLM error (retrying):', err);
          await browser.wait(2000);
          if (sightMode) {
            await browser.evaluate(getAnnotationScript(pageState.elements));
            const retryScreenshot = await browser.screenshot();
            await browser.evaluate(getRemoveAnnotationScript());
            const retryLegend = formatElementLegend(pageState.elements);
            navigatorResult = await getNextActionFromScreenshot(persona, goal, retryScreenshot, retryLegend, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, playbookSummary);
          } else {
            navigatorResult = await getNextAction(persona, goal, pageState, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, playbookSummary);
          }
        }
      }

      debug('LLM call resolved in %dms', Date.now() - llmT0);

      // Process observer document action (file I/O only, no browser contention)
      if (observerResult && observerResult.action.type === 'document' && observerResult.action.document) {
        const doc = observerResult.action.document;
        try {
          const execResult = await executeAction(
            browser,
            { type: 'document', document: doc },
            [],
            documentWriter
          );
          if (execResult.success) {
            debug('Observer document written: %s (%s)', doc.filename, doc.operation);
            transcript.push(`[${new Date().toISOString()}] Observer: ${observerResult.observation}`);
            transcript.push(`[${new Date().toISOString()}] Observer document: ${doc.operation} ${doc.filename}`);
          } else {
            debug('Observer document write failed: %s', execResult.error);
          }
        } catch (err) {
          debug('Observer document action error: %s', err);
        }
      } else if (observerResult) {
        // Observer skipped — still log the observation
        transcript.push(`[${new Date().toISOString()}] Observer: ${observerResult.observation}`);
      }
      if (observerResult) {
        options.onObservation?.(observerResult.observation, goalIndex);
      }

      // Process navigator result — resolve actions for execution
      if (sightMode) {
        const visionResult = navigatorResult as VisionBatchThinkingResult;
        thought = visionResult.thought;

        // Resolve ALL actions' elementIds to selectors
        actionsToExecute = visionResult.actions.map(vAction => {
          // Coordinate fallback: LLM specified x/y instead of elementId
          if (vAction.x !== undefined && vAction.y !== undefined && vAction.elementId === undefined) {
            debug('Vision coordinate fallback: click at (%d, %d)', vAction.x, vAction.y);
            return {
              ...vAction,
              // Store coordinates as sourceX/sourceY so action executor can use mouse.click
              sourceX: vAction.x,
              sourceY: vAction.y,
            };
          }

          const element = vAction.elementId !== undefined
            ? pageState.elements.find(el => el.id === vAction.elementId) ?? null
            : null;
          const dragTarget = vAction.type === 'drag' && vAction.targetElementId !== undefined
            ? pageState.elements.find(el => el.id === vAction.targetElementId) ?? null
            : null;

          if (element) {
            debug('Vision resolved element [%d]: %s', vAction.elementId, element.selector ?? 'no selector');
          }

          return {
            ...vAction,
            elementId: element?.id,
            selector: element?.selector,
            targetElementId: dragTarget?.id,
            targetSelector: dragTarget?.selector ?? vAction.targetSelector,
          };
        });
      } else {
        const result = navigatorResult as BatchThinkingResult;
        thought = result.thought;
        actionsToExecute = result.actions;
      }

      // Speech bubble target: first non-terminal action's element
      const firstAction = actionsToExecute.find(a => a.type !== 'done' && a.type !== 'failed');
      if (firstAction?.elementId !== undefined) {
        targetElement = pageState.elements.find(el => el.id === firstAction.elementId) ?? null;
      }

      debug('Batch: %d actions planned', actionsToExecute.length);

      // Log thought
      transcript.push(`[${new Date().toISOString()}] Thought: ${thought}`);
      options.onThought?.(thought, goalIndex);
      debug('Thought: %s', thought);

      // Ensure thinking dots are visible for at least the thinking delay duration
      // (if the LLM call was fast, pad the remaining time so the dots feel natural)
      const thinkingElapsed = Date.now() - thinkingShownAt;
      const minThinkingDuration = getHumanDelay(thinkingDelay.min, thinkingDelay.max);
      const thinkingRemaining = minThinkingDuration - thinkingElapsed;
      if (thinkingRemaining > 0) {
        await browser.wait(thinkingRemaining);
      }

      // Replace thinking animation with actual thought (bubble is already visible)
      try {
        if (targetElement) {
          const center = getElementCenter(targetElement);
          await browser.evaluate(getShowScript(thought, center.x, center.y));
        } else {
          await browser.evaluate(getShowScript(thought, 700, 400));
        }
      } catch {
        try {
          await browser.evaluate(getInitScript(persona.persona.name));
          await browser.evaluate(getShowScript(thought, 700, 400));
        } catch { /* proceed without bubble */ }
      }

      // Wait for typing animation to complete (30ms per character)
      const typingDuration = thought.length * 30;
      await browser.wait(typingDuration);

      // Execute batch with bail-out checks
      const batchResult = await executeBatch(
        browser,
        actionsToExecute,
        pageState.elements,
        documentWriter,
        {
          sightMode,
          onAction: (desc) => {
            transcript.push(`[${new Date().toISOString()}] Action: ${desc}`);
            options.onAction?.(desc, goalIndex);
            debug('Action: %s', desc);
            actionHistory.push(desc);
          },
          onError: (desc, error) => {
            debug('Action failed: %s', error);
            transcript.push(`[${new Date().toISOString()}] Error: ${error}`);
          },
        },
        playbookStore,
        domain
      );

      // Accumulate recorded operations for post-session stitching
      sessionActionLog.push(...batchResult.recordedOps);

      // If batch completed fully with 2+ inline operations, save as a playbook
      if (playbookStore && !batchResult.bailReason && batchResult.recordedOps.length >= 2) {
        let pagePath: string;
        try {
          pagePath = new URL(await browser.evaluate('window.location.href') as string).pathname;
        } catch {
          pagePath = '/';
        }

        const seqName = (navigatorResult as BatchThinkingResult).sequenceName
          || playbookStore.autoName(batchResult.recordedOps);

        const viewport = await getViewport(browser);
        playbookStore.record(domain, pagePath, seqName, batchResult.recordedOps, viewport);
        debug('Saved new playbook "%s" (%d ops)', seqName, batchResult.recordedOps.length);
      }

      actionCount += batchResult.completedCount;

      // Handle terminal action (done/failed returned from batch)
      if (batchResult.terminalAction) {
        try { await browser.evaluate(getHideScript()); } catch { /* page may have navigated */ }
        if (batchResult.terminalAction.type === 'done') {
          return {
            description: goal,
            status: 'completed',
            duration: Date.now() - startTime,
            actions: actionCount,
            transcript,
          };
        } else {
          return {
            description: goal,
            status: 'failed',
            duration: Date.now() - startTime,
            actions: actionCount,
            failureReason: batchResult.terminalAction.reason,
            transcript,
          };
        }
      }

      // Build feedback for next LLM iteration
      lastActionFeedback = formatBatchFeedback(batchResult.results, batchResult.bailReason);

      // Clear last read content after using it (it's been included in this iteration's context)
      documentWriter.clearLastReadContent();

      // Wait for DOM to settle after batch
      await waitForDOMSettle(browser);

      debug('Iteration complete in %dms (LLM: %dms, actions: %d)', Date.now() - iterT0, Date.now() - llmT0, batchResult.completedCount);

      // Safety: max 100 actions per goal
      if (actionCount >= 100) {
        debug('Max actions reached');
        break;
      }
    }

    // Timeout
    return {
      description: goal,
      status: 'timeout',
      duration: Date.now() - startTime,
      actions: actionCount,
      failureReason: 'Goal timeout exceeded',
      transcript,
    };
  } finally {
    // Post-session playbook stitching: create playbooks from single-action iterations
    if (playbookStore && sessionActionLog.length >= 2) {
      let pagePath: string;
      try {
        pagePath = new URL(await browser.evaluate('window.location.href') as string).pathname;
      } catch {
        pagePath = '/';
      }
      const viewport = await getViewport(browser);
      const stitched = playbookStore.stitchFromLog(domain, pagePath, sessionActionLog, viewport);
      if (stitched.length > 0) {
        debug('Post-session stitching created %d playbooks from %d operations', stitched.length, sessionActionLog.length);
      }
    }

    // Cleanup speech bubble (may fail if page navigated)
    try {
      await browser.evaluate(getDestroyScript());
    } catch {
      // Ignore - page may have navigated
    }
  }
}

/**
 * Run a full session with all goals
 */
export async function runSession(
  createBrowser: (options: { headless?: boolean; video?: { dir: string } }) => Promise<{
    browser: Browser;
    goto: (url: string) => Promise<void>;
    close: () => Promise<void>;
    getVideoPath?: () => Promise<{ path: string } | null>;
  }>,
  persona: PersonaConfig,
  options: SessionOptions
): Promise<SessionResult> {
  const sessionId = `${slugify(persona.persona.name)}-${Date.now()}`;
  const sessionDir = join(options.outputDir, sessionId);

  await ensureOutputDir(sessionDir);

  // Initialize document writer for this session
  const documentWriter = new DocumentWriter(sessionDir);
  await documentWriter.initialize();

  // Initialize playbook store (unless --no-playbooks)
  const playbooksEnabled = options.playbooks !== false;
  let playbookStore: PlaybookStore | undefined;
  if (playbooksEnabled) {
    const domain = new URL(persona.url).hostname;
    playbookStore = new PlaybookStore();
    await playbookStore.load(domain);
    debug('Playbooks loaded for %s (%d stored)', domain, playbookStore.getPlaybooks(domain).length);
  }

  const startedAt = new Date().toISOString();
  const goalResults: GoalResult[] = [];

  debug('Starting session: %s', sessionId);
  debug('Output directory: %s', sessionDir);

  for (let i = 0; i < persona.goals.length; i++) {
    const goal = persona.goals[i];
    const goalSlug = `goal-${i + 1}-${slugify(goal)}`;
    const videoDir = join(sessionDir, 'videos');

    await ensureOutputDir(videoDir);

    debug('Starting goal %d/%d: %s', i + 1, persona.goals.length, goal);

    // Create browser with video recording
    const browserSession = await createBrowser({
      headless: options.headless,
      video: { dir: videoDir },
    });

    try {
      // Navigate to starting URL
      await browserSession.goto(persona.url);

      // Run the goal
      const result = await runGoal(
        browserSession.browser,
        persona,
        goal,
        i,
        options,
        documentWriter,
        playbookStore
      );

      // Save playbooks after each goal
      if (playbookStore) {
        try {
          const domain = new URL(persona.url).hostname;
          await playbookStore.save(domain);
        } catch (err) {
          debug('Failed to save playbooks: %s', err);
        }
      }

      // Get video path if available
      if (browserSession.getVideoPath) {
        try {
          const videoInfo = await browserSession.getVideoPath();
          if (videoInfo?.path) {
            result.video = videoInfo.path;
          }
        } catch {
          debug('Could not get video path');
        }
      }

      goalResults.push(result);

      // Save transcript
      const transcriptPath = join(sessionDir, `${goalSlug}-transcript.md`);
      await writeFile(transcriptPath, [
        `# Goal: ${goal}`,
        '',
        `Status: ${result.status}`,
        `Duration: ${result.duration}ms`,
        `Actions: ${result.actions}`,
        result.failureReason ? `Failure: ${result.failureReason}` : '',
        '',
        '## Transcript',
        '',
        ...result.transcript,
      ].filter(Boolean).join('\n'));
    } finally {
      await browserSession.close();
    }
  }

  const completedAt = new Date().toISOString();

  // Save session metadata
  const sessionResult: SessionResult = {
    persona: persona.persona.name,
    startedAt,
    completedAt,
    goals: goalResults,
  };

  const metadataPath = join(sessionDir, 'session.json');
  await writeFile(metadataPath, JSON.stringify(sessionResult, null, 2));

  debug('Session complete: %s', sessionId);

  return sessionResult;
}
