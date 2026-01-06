/**
 * LLM integration module - invokes Claude CLI for persona thinking
 */

import { spawn } from 'child_process';
import createDebug from 'debug';
import type { PersonaConfig } from './persona.js';
import type { PageState } from './page-analyzer.js';
import { formatPageStateForLLM } from './page-analyzer.js';

const debug = createDebug('abra:llm');

// Claude CLI paths to try
const CLAUDE_PATHS = [
  process.env.CLAUDE_CLI_PATH,
  '/Users/karl/.claude/local/claude', // Common macOS location
  `${process.env.HOME}/.claude/local/claude`,
  'claude', // Let PATH resolve it
].filter(Boolean) as string[];

// Action types the LLM can request
export type ActionType = 'click' | 'type' | 'scroll' | 'hover' | 'wait' | 'done' | 'failed';

export interface Action {
  type: ActionType;
  // Element ID from page analysis (for click, type, hover)
  elementId?: number;
  // Selector to use
  selector?: string;
  // Text to type (for type action)
  text?: string;
  // Scroll direction (for scroll action)
  direction?: 'up' | 'down';
  // Scroll amount in pixels
  amount?: number;
  // Wait duration in ms
  duration?: number;
  // Reason for done/failed
  reason?: string;
}

export interface ThinkingResult {
  // The persona's internal thought process (for speech bubble)
  thought: string;
  // The action to take
  action: Action;
  // Confidence level (0-1)
  confidence: number;
}

/**
 * Build the system prompt for the persona
 */
function buildSystemPrompt(persona: PersonaConfig): string {
  return `You are simulating a user persona for usability testing. You must think and act as this persona would.

PERSONA:
Name: ${persona.persona.name}
Background: ${persona.persona.background}

JOBS TO BE DONE (what this persona is trying to accomplish in their life/work):
${persona.persona.jobs_to_be_done.map(j => `- ${j}`).join('\n')}

You are browsing a website to achieve specific goals. For each step:
1. Look at the available page elements
2. Think about what action would help achieve the goal
3. Choose the most appropriate action

Your response MUST be valid JSON with this exact structure:
{
  "thought": "Your internal monologue as this persona (1-2 sentences, first person)",
  "action": {
    "type": "click|type|scroll|hover|wait|done|failed",
    "elementId": <number if clicking/typing/hovering on an element>,
    "selector": "<selector string if needed>",
    "text": "<text to type if type action>",
    "direction": "up|down (if scroll)",
    "amount": <pixels to scroll>,
    "duration": <ms to wait>,
    "reason": "<why done or failed>"
  },
  "confidence": <0.0 to 1.0>
}

Rules:
- Use "done" when you believe the goal has been achieved
- Use "failed" if you cannot find a way to achieve the goal
- Think as the persona would, using their perspective and priorities
- Be specific about which element to interact with using elementId
- Keep thoughts natural and conversational`;
}

/**
 * Build the user prompt for a specific step
 */
function buildUserPrompt(goal: string, pageState: PageState, previousActions: string[]): string {
  const parts: string[] = [
    `CURRENT GOAL: ${goal}`,
    '',
    formatPageStateForLLM(pageState),
  ];

  if (previousActions.length > 0) {
    parts.push('');
    parts.push('PREVIOUS ACTIONS:');
    parts.push(previousActions.slice(-5).join('\n')); // Last 5 actions
  }

  parts.push('');
  parts.push('What should you do next? Respond with JSON only.');

  return parts.join('\n');
}

/**
 * Find a working Claude CLI path
 */
async function findClaudeCLI(): Promise<string> {
  const { access } = await import('fs/promises');
  const { constants } = await import('fs');

  for (const path of CLAUDE_PATHS) {
    try {
      await access(path, constants.X_OK);
      debug('Found Claude CLI at:', path);
      return path;
    } catch {
      // Try next path
    }
  }

  throw new Error('Claude CLI not found. Please install it from https://claude.ai/code');
}

// Cached Claude CLI path
let claudePath: string | null = null;

/**
 * Invoke Claude CLI and get a response
 */
async function invokeClaudeCLI(systemPrompt: string, userPrompt: string): Promise<string> {
  // Find Claude CLI path if not cached
  if (!claudePath) {
    claudePath = await findClaudeCLI();
  }

  return new Promise((resolve, reject) => {
    debug('Invoking Claude CLI at:', claudePath);

    // Combine into a single prompt for simplicity
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    const proc = spawn(claudePath!, [
      '--print',  // Print response only, non-interactive
      '--no-session-persistence', // Don't save session
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        debug('Claude CLI error:', stderr);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        return;
      }
      debug('Claude CLI response received');
      resolve(stdout.trim());
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    // Write prompt to stdin and close
    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

/**
 * Parse LLM response to extract action
 */
function parseResponse(response: string): ThinkingResult {
  // Try to extract JSON from the response
  // The response might have extra text around it
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in LLM response');
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!parsed.thought || typeof parsed.thought !== 'string') {
      throw new Error('Missing or invalid thought field');
    }
    if (!parsed.action || typeof parsed.action !== 'object') {
      throw new Error('Missing or invalid action field');
    }
    if (!parsed.action.type) {
      throw new Error('Missing action type');
    }

    return {
      thought: parsed.thought,
      action: parsed.action,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  } catch (err) {
    throw new Error(`Failed to parse LLM response: ${err}`);
  }
}

/**
 * Get the next action from the LLM based on current state
 */
export async function getNextAction(
  persona: PersonaConfig,
  goal: string,
  pageState: PageState,
  previousActions: string[] = []
): Promise<ThinkingResult> {
  const systemPrompt = buildSystemPrompt(persona);
  const userPrompt = buildUserPrompt(goal, pageState, previousActions);

  debug('Getting next action for goal:', goal);
  debug('Page has %d elements', pageState.elements.length);

  const response = await invokeClaudeCLI(systemPrompt, userPrompt);
  debug('Raw response:', response.slice(0, 200) + '...');

  return parseResponse(response);
}

/**
 * Build the vision system prompt for screenshot-based analysis
 */
function buildVisionSystemPrompt(persona: PersonaConfig): string {
  return `You are simulating a user persona for usability testing. You must think and act as this persona would.

PERSONA:
Name: ${persona.persona.name}
Background: ${persona.persona.background}

JOBS TO BE DONE (what this persona is trying to accomplish in their life/work):
${persona.persona.jobs_to_be_done.map(j => `- ${j}`).join('\n')}

You are looking at an ANNOTATED screenshot of a website. Interactive elements are marked with RED boxes and numbered labels like [0], [1], [2], etc.

IMPORTANT: Use the element numbers from the annotations to specify which element to interact with. Do NOT guess coordinates.

Your response MUST be valid JSON with this exact structure:
{
  "thought": "Your internal monologue as this persona (1-2 sentences, first person)",
  "action": {
    "type": "click|type|scroll|hover|wait|done|failed",
    "elementId": <the number from the red label, e.g. 5 for [5]>,
    "text": "<text to type if type action>",
    "direction": "up|down (if scroll)",
    "amount": <pixels to scroll>,
    "duration": <ms to wait>,
    "reason": "<why done or failed>"
  },
  "confidence": <0.0 to 1.0>
}

Rules:
- ALWAYS use elementId to reference elements by their [number] label in the screenshot
- Look at the visual context to understand the page layout and purpose
- Use "done" when you believe the goal has been achieved
- Use "failed" if you cannot find a way to achieve the goal
- Think as the persona would, using their perspective and priorities
- For typing: first click the input field, then type in a separate action`;
}

/**
 * Build the vision user prompt with screenshot
 */
function buildVisionUserPrompt(goal: string, elementLegend: string, previousActions: string[]): string {
  const parts: string[] = [
    `CURRENT GOAL: ${goal}`,
    '',
    'Look at the annotated screenshot. Elements are marked with red boxes and [number] labels.',
    '',
    elementLegend,
  ];

  if (previousActions.length > 0) {
    parts.push('');
    parts.push('PREVIOUS ACTIONS:');
    parts.push(previousActions.slice(-5).join('\n')); // Last 5 actions
  }

  parts.push('');
  parts.push('What should you do next? Use elementId to reference elements. Respond with JSON only.');

  return parts.join('\n');
}

/**
 * Vision action result from LLM
 * Uses elementId from annotated screenshot instead of coordinates
 */
export interface VisionAction extends Action {
  // Element ID from the annotated screenshot labels
  elementId?: number;
}

export interface VisionThinkingResult {
  thought: string;
  action: VisionAction;
  confidence: number;
}

/**
 * Extract the first valid JSON object from a string
 */
function extractFirstJson(text: string): string | null {
  let braceCount = 0;
  let startIndex = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (startIndex === -1) startIndex = i;
      braceCount++;
    } else if (text[i] === '}') {
      braceCount--;
      if (braceCount === 0 && startIndex !== -1) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

/**
 * Parse vision LLM response
 */
function parseVisionResponse(response: string): VisionThinkingResult {
  debug('Parsing vision response (%d chars)', response.length);

  // Try to extract the first complete JSON object
  const jsonStr = extractFirstJson(response);
  if (!jsonStr) {
    debug('No JSON found in response: %s', response.slice(0, 500));
    throw new Error('No JSON found in vision LLM response');
  }

  try {
    const parsed = JSON.parse(jsonStr);

    if (!parsed.thought || typeof parsed.thought !== 'string') {
      throw new Error('Missing or invalid thought field');
    }
    if (!parsed.action || typeof parsed.action !== 'object') {
      throw new Error('Missing or invalid action field');
    }
    if (!parsed.action.type) {
      throw new Error('Missing action type');
    }

    return {
      thought: parsed.thought,
      action: parsed.action,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  } catch (err) {
    debug('JSON parse error. Raw JSON: %s', jsonStr.slice(0, 500));
    throw new Error(`Failed to parse vision LLM response: ${err}`);
  }
}

/**
 * Save screenshot to temp file and return path
 */
async function saveScreenshotToTemp(screenshot: Buffer | string): Promise<string> {
  const { writeFile } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  const filename = `abra-screenshot-${Date.now()}.png`;
  const filepath = join(tmpdir(), filename);

  // Handle both Buffer and base64 string (puppet returns base64 string)
  const buffer = Buffer.isBuffer(screenshot)
    ? screenshot
    : Buffer.from(screenshot, 'base64');

  await writeFile(filepath, buffer);
  debug('Screenshot saved to:', filepath);

  return filepath;
}

/**
 * Clean up temp screenshot file
 */
async function cleanupScreenshot(filepath: string): Promise<void> {
  const { unlink } = await import('fs/promises');
  try {
    await unlink(filepath);
    debug('Cleaned up screenshot:', filepath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Invoke Claude CLI with vision (file-based)
 */
async function invokeClaudeCLIWithVision(
  systemPrompt: string,
  userPrompt: string,
  screenshotPath: string
): Promise<string> {
  if (!claudePath) {
    claudePath = await findClaudeCLI();
  }

  return new Promise((resolve, reject) => {
    debug('Invoking Claude CLI with vision, screenshot:', screenshotPath);

    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}\n\nLook at the screenshot at: ${screenshotPath}`;

    const proc = spawn(claudePath!, [
      '--print',
      '--no-session-persistence',
      '--dangerously-skip-permissions', // Required to read temp files
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        debug('Claude CLI error:', stderr);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        return;
      }
      debug('Claude CLI vision response received');
      resolve(stdout.trim());
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

/**
 * Get next action using vision (screenshot) analysis
 */
export async function getNextActionFromScreenshot(
  persona: PersonaConfig,
  goal: string,
  screenshot: Buffer | string,
  elementLegend: string,
  previousActions: string[] = []
): Promise<VisionThinkingResult> {
  const systemPrompt = buildVisionSystemPrompt(persona);
  const userPrompt = buildVisionUserPrompt(goal, elementLegend, previousActions);

  debug('Getting next action from screenshot for goal:', goal);

  // Save screenshot to temp file (Claude CLI needs file access, not inline base64)
  const screenshotPath = await saveScreenshotToTemp(screenshot);

  try {
    const response = await invokeClaudeCLIWithVision(systemPrompt, userPrompt, screenshotPath);
    debug('Vision response:', response.slice(0, 200) + '...');
    return parseVisionResponse(response);
  } finally {
    // Clean up temp file
    await cleanupScreenshot(screenshotPath);
  }
}

/**
 * Format an action for the action history
 */
export function formatAction(action: Action): string {
  switch (action.type) {
    case 'click':
      return `Clicked element ${action.elementId} (${action.selector})`;
    case 'type':
      return `Typed "${action.text}" into element ${action.elementId}`;
    case 'scroll':
      return `Scrolled ${action.direction} ${action.amount}px`;
    case 'hover':
      return `Hovered over element ${action.elementId}`;
    case 'wait':
      return `Waited ${action.duration}ms`;
    case 'done':
      return `Goal completed: ${action.reason}`;
    case 'failed':
      return `Goal failed: ${action.reason}`;
    default:
      return `Unknown action: ${action.type}`;
  }
}

/**
 * Format a vision action for the action history
 */
export function formatVisionAction(action: VisionAction): string {
  const elemRef = action.elementId !== undefined ? ` element [${action.elementId}]` : '';

  switch (action.type) {
    case 'click':
      return `[sight] Clicked${elemRef}`;
    case 'type':
      return `[sight] Typed "${action.text}" into${elemRef}`;
    case 'scroll':
      return `[sight] Scrolled ${action.direction} ${action.amount}px`;
    case 'hover':
      return `[sight] Hovered over${elemRef}`;
    case 'wait':
      return `[sight] Waited ${action.duration}ms`;
    case 'done':
      return `[sight] Goal completed: ${action.reason}`;
    case 'failed':
      return `[sight] Goal failed: ${action.reason}`;
    default:
      return `[sight] Unknown action: ${action.type}`;
  }
}
