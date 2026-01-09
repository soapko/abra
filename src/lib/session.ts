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
  type ThinkingResult,
  type VisionThinkingResult,
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
  getHideScript,
  getDestroyScript,
} from './speech-bubble.js';
import { DocumentWriter } from './document-writer.js';

const debug = createDebug('abra:session');

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
  onThought?: (thought: string, goalIndex: number) => void;
  onAction?: (action: string, goalIndex: number) => void;
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

/**
 * Run a single goal simulation
 */
async function runGoal(
  browser: Browser,
  persona: PersonaConfig,
  goal: string,
  goalIndex: number,
  options: SessionOptions,
  documentWriter: DocumentWriter
): Promise<GoalResult> {
  const startTime = Date.now();
  const actionHistory: string[] = [];
  const transcript: string[] = [];
  let actionCount = 0;
  const timeout = persona.options.timeout;
  const thinkingDelay = getThinkingDelay(persona.options.thinkingSpeed);
  const sightMode = options.sightMode ?? false;

  // Generate a unique session ID for this goal's LLM conversation
  // This allows the LLM to maintain context across iterations
  const llmSessionId = randomUUID();

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

      // Analyze current page (always needed for element mapping)
      const pageState = await browser.evaluate(PAGE_ANALYZER_SCRIPT) as PageState;
      debug('Page analyzed: %s (%d elements)', pageState.title, pageState.elements.length);

      // Variables for action result
      let thought: string;
      let actionType: string;
      let actionDesc: string;
      let targetElement: PageElement | null = null;
      let actionToExecute: ThinkingResult['action'];

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

        // Get document context for LLM
        const docIndex = documentWriter.formatIndexForLLM();
        const lastReadContent = documentWriter.getLastReadContent();

        let visionResult: VisionThinkingResult;
        try {
          visionResult = await getNextActionFromScreenshot(persona, goal, screenshot, elementLegend, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback);
        } catch (err) {
          debug('Vision LLM error:', err);
          await browser.wait(2000);
          visionResult = await getNextActionFromScreenshot(persona, goal, screenshot, elementLegend, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback);
        }

        thought = visionResult.thought;
        actionType = visionResult.action.type;
        actionDesc = formatVisionAction(visionResult.action);

        // Find the element by ID from the vision response
        if (visionResult.action.elementId !== undefined) {
          targetElement = pageState.elements.find(el => el.id === visionResult.action.elementId) ?? null;
          debug('Vision selected element [%d]: %s',
            visionResult.action.elementId,
            targetElement?.selector ?? 'not found'
          );
        }

        // Convert vision action to standard action for execution
        actionToExecute = {
          ...visionResult.action,
          elementId: targetElement?.id,
          selector: targetElement?.selector,
        };
      } else {
        // STANDARD MODE: Use HTML analysis for decision-making

        // Get document context for LLM
        const docIndex = documentWriter.formatIndexForLLM();
        const lastReadContent = documentWriter.getLastReadContent();

        let result: ThinkingResult;
        try {
          result = await getNextAction(persona, goal, pageState, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback);
        } catch (err) {
          debug('LLM error:', err);
          await browser.wait(2000);
          result = await getNextAction(persona, goal, pageState, actionHistory, docIndex, lastReadContent, llmSessionId, lastActionFeedback);
        }

        thought = result.thought;
        actionType = result.action.type;
        actionDesc = formatAction(result.action);
        actionToExecute = result.action;

        targetElement = result.action.elementId !== undefined
          ? pageState.elements.find(el => el.id === result.action.elementId) ?? null
          : null;
      }

      // Log thought
      transcript.push(`[${new Date().toISOString()}] Thought: ${thought}`);
      options.onThought?.(thought, goalIndex);
      debug('Thought: %s', thought);

      // Show speech bubble at target element position
      if (targetElement) {
        const center = getElementCenter(targetElement);
        await browser.evaluate(getShowScript(thought, center.x, center.y));
      } else {
        // Show at center of viewport
        await browser.evaluate(getShowScript(thought, 700, 400));
      }

      // Wait for typing animation to complete (30ms per character)
      const typingDuration = thought.length * 30;
      await browser.wait(typingDuration);

      // Human-like thinking pause (so viewer can read the complete thought)
      await browser.wait(getHumanDelay(thinkingDelay.min, thinkingDelay.max));

      // Check for terminal actions
      if (actionType === 'done') {
        await browser.evaluate(getHideScript());
        return {
          description: goal,
          status: 'completed',
          duration: Date.now() - startTime,
          actions: actionCount,
          transcript,
        };
      }

      if (actionType === 'failed') {
        await browser.evaluate(getHideScript());
        return {
          description: goal,
          status: 'failed',
          duration: Date.now() - startTime,
          actions: actionCount,
          failureReason: actionToExecute.reason,
          transcript,
        };
      }

      // Execute the action
      transcript.push(`[${new Date().toISOString()}] Action: ${actionDesc}`);
      options.onAction?.(actionDesc, goalIndex);
      debug('Action: %s', actionDesc);

      const execResult = await executeAction(browser, actionToExecute, pageState.elements, documentWriter);

      // Set feedback for the next LLM iteration
      if (execResult.success) {
        lastActionFeedback = `SUCCESS: "${actionDesc}" completed successfully.`;
      } else {
        lastActionFeedback = `FAILED: "${actionDesc}" failed with error: ${execResult.error}. Try a different approach.`;
        debug('Action failed: %s', execResult.error);
        transcript.push(`[${new Date().toISOString()}] Error: ${execResult.error}`);
      }

      // Clear last read content after using it (it's been included in this iteration's context)
      documentWriter.clearLastReadContent();

      actionHistory.push(actionDesc);
      actionCount++;

      // Hide bubble after action (may fail if page navigated)
      try {
        await browser.evaluate(getHideScript());
      } catch {
        // Page may have navigated, will re-inject speech bubble on next iteration
      }

      // Wait for page to settle (loading indicators gone, network idle)
      // Use shorter timeout - if page has loading indicators they should appear quickly
      try {
        await browser.waitForLoaded(2000);
      } catch {
        // Timeout is fine - proceed anyway
      }

      // Re-inject speech bubble in case page navigated
      try {
        await browser.evaluate(getInitScript(persona.persona.name));
      } catch {
        // Ignore
      }

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
        documentWriter
      );

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
