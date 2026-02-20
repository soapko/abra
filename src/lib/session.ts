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
import { installObserver, collectObservation, teardownObserver } from './state-observer.js';
import {
  DomainKnowledgeStore,
  assertDeltaMatch,
  buildActionSignature,
} from './domain-knowledge.js';

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
  /** Enable domain knowledge learning and assertions. Default: true */
  learn?: boolean;
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
}

/**
 * Execute a batch of actions with bail-out checks between each.
 * Optionally observes state deltas and asserts against domain knowledge.
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
  knowledge?: {
    store: DomainKnowledgeStore;
    domain: string;
    pagePath: string;
  }
): Promise<BatchExecutionResult> {
  const batchT0 = Date.now();
  const results: BatchActionResult[] = [];
  let terminalAction: Action | undefined;
  let urlChanged = false;
  let bailReason: string | undefined;
  // Mutable copy — may be refreshed during label resolution
  let currentElements = elements;

  // Get initial URL for change detection
  let currentUrl: string;
  try {
    currentUrl = await browser.evaluate('window.location.href') as string;
  } catch {
    currentUrl = '';
  }

  const formatFn = callbacks.sightMode ? formatVisionAction : formatAction;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    // Terminal action — return for main loop to handle
    if (action.type === 'done' || action.type === 'failed') {
      terminalAction = action;
      break;
    }

    // Label resolution: if action has label but no elementId/selector, find element by text
    if (action.label && action.elementId === undefined && !action.selector) {
      debug('Resolving label "%s" — re-scanning page', action.label);

      // Wait for DOM to settle (the preceding action may have opened a dropdown)
      await waitForDOMSettle(browser);

      try {
        // Re-run page analyzer to get fresh elements
        const freshState = await browser.evaluate(PAGE_ANALYZER_SCRIPT) as PageState;
        const label = action.label.toLowerCase();

        // Find element by: exact text match, then contains, then ariaLabel
        const match =
          freshState.elements.find(el => el.text.toLowerCase() === label) ||
          freshState.elements.find(el => el.text.toLowerCase().includes(label)) ||
          freshState.elements.find(el => el.ariaLabel?.toLowerCase() === label) ||
          freshState.elements.find(el => el.ariaLabel?.toLowerCase().includes(label));

        if (match) {
          debug('Label "%s" resolved to element [%d] (%s): %s', action.label, match.id, match.tag, match.selector);
          action.elementId = match.id;
          action.selector = match.selector;
          // Update elements reference so downstream lookups work
          currentElements = freshState.elements;
        } else {
          bailReason = `label not found: "${action.label}"`;
          debug('Label resolution failed: no element matching "%s" (scanned %d elements)', action.label, freshState.elements.length);
          break;
        }
      } catch (err) {
        bailReason = `label resolution error: ${err}`;
        debug('Label resolution error: %s', err);
        break;
      }
    }

    const actionT0 = Date.now();
    const actionDesc = formatFn(action);
    callbacks.onAction(actionDesc);

    // Find the target element for knowledge lookups and observer scoping
    const targetElement = action.elementId !== undefined
      ? currentElements.find(el => el.id === action.elementId)
      : null;

    // Install state observer before action (if learning)
    if (knowledge) {
      await installObserver(browser, targetElement?.selector);
    }

    // Execute the action
    const execResult = await executeAction(browser, action, currentElements, documentWriter);
    debug('  Action %d/%d executed in %dms: %s', i + 1, actions.length, Date.now() - actionT0, actionDesc);

    results.push({
      actionDesc,
      success: execResult.success,
      error: execResult.error,
    });

    // Bail on failure — tear down observer without recording
    if (!execResult.success) {
      if (knowledge) await teardownObserver(browser);
      callbacks.onError(actionDesc, execResult.error!);
      bailReason = `action failed: ${execResult.error}`;
      break;
    }

    // Collect observation and assert/record (if learning)
    if (knowledge) {
      const actualDelta = await collectObservation(browser);
      const actionSig = buildActionSignature(
        action.type, targetElement ?? null, action.text, action.key
      );
      const existing = knowledge.store.findTransition(
        knowledge.domain, knowledge.pagePath, actionSig
      );

      if (existing) {
        if (assertDeltaMatch(existing.expectedOutcome, actualDelta)) {
          // Assertion passed — confirm
          knowledge.store.confirmTransition(existing);
          debug('Knowledge assertion passed for %s on %s', action.type, targetElement?.selector ?? 'unknown');
        } else {
          // Assertion failed — update knowledge and bail to re-sensing
          if (actualDelta) {
            knowledge.store.updateTransition(existing, actualDelta);
          }
          bailReason = 'knowledge assertion mismatch';
          debug('Knowledge assertion FAILED for %s on %s — bailing to re-sense',
            action.type, targetElement?.selector ?? 'unknown');
          break;
        }
      } else if (actualDelta) {
        // New transition — record it
        knowledge.store.recordTransition({
          domain: knowledge.domain,
          pagePath: knowledge.pagePath,
          action: actionSig,
          expectedOutcome: actualDelta,
          lastConfirmed: new Date().toISOString(),
          confirmCount: 1,
          failCount: 0,
        });
        debug('Recorded new transition for %s on %s', action.type, targetElement?.selector ?? 'unknown');
      }
    }

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

    // Check next action's target element still exists (skip for label-based actions — they'll be resolved later)
    const nextAction = actions[i + 1];
    if (nextAction && nextAction.type !== 'done' && nextAction.type !== 'failed' && !nextAction.label) {
      const nextElement = nextAction.elementId !== undefined
        ? currentElements.find(el => el.id === nextAction.elementId)
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
  };
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
  knowledgeStore?: DomainKnowledgeStore
): Promise<GoalResult> {
  const startTime = Date.now();
  const actionHistory: string[] = [];
  const transcript: string[] = [];
  let actionCount = 0;
  const timeout = persona.options.timeout;
  const thinkingDelay = getThinkingDelay(persona.options.thinkingSpeed);
  const sightMode = options.sightMode ?? false;

  // Extract domain for knowledge lookups
  const domain = new URL(persona.url).hostname;

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

      // Get domain knowledge summary for prompt injection
      const knowledgeSummary = knowledgeStore
        ? knowledgeStore.getKnowledgeSummary(domain) || null
        : null;
      if (knowledgeSummary) {
        debug('Injecting domain knowledge (%d chars) into prompt', knowledgeSummary.length);
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

        navigatorPromise = getNextActionFromScreenshot(persona, goal, screenshot, elementLegend, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, knowledgeSummary);
      } else {
        // STANDARD MODE: Use HTML analysis for decision-making
        navigatorPromise = getNextAction(persona, goal, pageState, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, knowledgeSummary);
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
            navigatorResult = await getNextActionFromScreenshot(persona, goal, retryScreenshot, retryLegend, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, knowledgeSummary);
          } else {
            navigatorResult = await getNextAction(persona, goal, pageState, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, knowledgeSummary);
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
            navigatorResult = await getNextActionFromScreenshot(persona, goal, retryScreenshot, retryLegend, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, knowledgeSummary);
          } else {
            navigatorResult = await getNextAction(persona, goal, pageState, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback, knowledgeSummary);
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

      // Build knowledge context for this iteration
      let knowledgeContext: { store: DomainKnowledgeStore; domain: string; pagePath: string } | undefined;
      if (knowledgeStore) {
        let pagePath: string;
        try {
          pagePath = new URL(await browser.evaluate('window.location.href') as string).pathname;
        } catch {
          pagePath = '/';
        }
        knowledgeContext = { store: knowledgeStore, domain, pagePath };
      }

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
        knowledgeContext
      );

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

  // Initialize domain knowledge store (unless --no-learn)
  const learn = options.learn !== false;
  let knowledgeStore: DomainKnowledgeStore | undefined;
  if (learn) {
    const domain = new URL(persona.url).hostname;
    knowledgeStore = new DomainKnowledgeStore(undefined, sessionId);
    await knowledgeStore.load(domain);
    debug('Domain knowledge loaded for %s (learning enabled)', domain);
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
        knowledgeStore
      );

      // Save domain knowledge after each goal
      if (knowledgeStore) {
        try {
          await knowledgeStore.saveAll();
        } catch (err) {
          debug('Failed to save domain knowledge: %s', err);
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
