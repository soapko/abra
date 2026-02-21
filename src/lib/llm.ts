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
  `${process.env.HOME}/.local/bin/claude`,
  `${process.env.HOME}/.claude/local/claude`,
  '/Users/karl/.claude/local/claude', // Common macOS location
  'claude', // Let PATH resolve it
].filter(Boolean) as string[];

// Action types the LLM can request
export type ActionType = 'click' | 'type' | 'press' | 'scroll' | 'hover' | 'drag' | 'wait' | 'done' | 'failed' | 'document';

// Document operations for the document action type
export type DocumentOperation = 'create' | 'read' | 'update' | 'append';

export interface Action {
  type: ActionType;
  // Element ID from page analysis (for click, type, hover, drag source)
  elementId?: number;
  // Selector to use
  selector?: string;
  // Playbook reference — name of a stored playbook to replay
  playbook?: string;
  // Target element ID (for drag action)
  targetElementId?: number;
  // Target selector (for drag action)
  targetSelector?: string;
  // Coordinate-based drag (when no elements are available, e.g. captchas)
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  // Text to type (for type action)
  text?: string;
  // Key to press (for press action): Enter, Escape, Tab, ArrowDown, ArrowUp, etc.
  key?: string;
  // Scroll direction (for scroll action)
  direction?: 'up' | 'down';
  // Scroll amount in pixels
  amount?: number;
  // Wait duration in ms
  duration?: number;
  // Reason for done/failed
  reason?: string;
  // LLM-provided name for this sequence (for playbook recording)
  sequenceName?: string;
  // Document action configuration
  document?: {
    operation: DocumentOperation;
    filename: string;
    content?: string;
    section?: string;  // For update - target heading or JSON path
  };
}

export interface ThinkingResult {
  // The persona's internal thought process (for speech bubble)
  thought: string;
  // The action to take
  action: Action;
  // Confidence level (0-1)
  confidence: number;
}

export interface BatchThinkingResult {
  thought: string;
  actions: Action[];
  confidence: number;
  /** Optional name for this sequence (used for playbook recording) */
  sequenceName?: string;
}

/** Max actions per batch (defensive cap) */
const MAX_BATCH_SIZE = 8;

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
  "sequenceName": "optional short name for this action sequence (for future replay)",
  "actions": [
    {
      "type": "click|type|press|scroll|hover|drag|wait|done|failed",
      "elementId": <number if clicking/typing/hovering/dragging on an element>,
      "playbook": "<name of a stored playbook to replay>",
      "selector": "<selector string if needed>",
      "targetElementId": <number of target element for drag>,
      "targetSelector": "<target selector for drag>",
      "text": "<text to type if type action>",
      "key": "<key to press>",
      "direction": "up|down (if scroll)",
      "amount": <pixels to scroll>,
      "duration": <ms to wait>,
      "reason": "<why done or failed>"
    }
  ],
  "confidence": <0.0 to 1.0>
}

OPERATION QUEUE MODEL:
You output a queue of operations. The system executes them mechanically in order.
No LLM involvement between operations — just lightweight bail checks (action failed? URL changed?).
If something unexpected happens, the system stops, takes a fresh screenshot, and re-prompts you.

Queue as many operations as you can predict. Each re-prompt costs 5-15 seconds.
Err on the side of queuing more — the system will bail safely if anything goes wrong.

ALWAYS batch these patterns (2-5 actions):
- Form filling: click field + type text + press Tab/Enter
- Search: click search box + type query + press Enter
- Multi-step UI: click button + fill field + click submit
- Dismissing modals + next action: click dismiss + click target element

Only use a SINGLE action when:
- You genuinely don't know what will appear (first visit, no stored playbooks)
- The action causes navigation to a new page

STORED PLAYBOOKS:
If a "STORED PLAYBOOKS" section lists playbooks in the prompt, you may reference them by exact name:
{"playbook": "dismiss-get-started-modal"}
You can mix playbook references with inline operations in the same batch.
ONLY reference playbooks that are explicitly listed. NEVER invent playbook names.
If no playbooks are listed, use inline actions only (click, type, press, scroll, etc.).

"done" and "failed" must ALWAYS be the LAST action in the array.

DOCUMENT ACTIONS:
You can create and maintain documents to record your findings, notes, and journey.
Use the "document" action type with these operations:

- create: Start a new document
  {"type": "document", "document": {"operation": "create", "filename": "notes.md", "content": "# Notes\\n..."}}

- read: Read existing document (content will be available in next step)
  {"type": "document", "document": {"operation": "read", "filename": "notes.md"}}

- update: Replace content (optionally target a section by heading)
  {"type": "document", "document": {"operation": "update", "filename": "notes.md", "content": "...", "section": "## Findings"}}

- append: Add to end of document
  {"type": "document", "document": {"operation": "append", "filename": "notes.md", "content": "\\n## New Section\\n..."}}

Formats: .md (Markdown), .json (JSON), .txt (plain text), or any custom extension.
Document when your goal mentions: document, record, note, track, log, compare, write down.

DRAG ACTION:
Use "drag" when you need to click-and-drag an element to another location. This is useful for:
- Captcha/verification puzzles that require dragging a slider or aligning objects
- Sortable lists, kanban boards, drag-and-drop interfaces
Specify elementId for the source (what to grab) and targetElementId for the destination (where to drop).

Rules:
- Use "done" when you believe the goal has been achieved
- Use "failed" if you cannot find a way to achieve the goal
- Think as the persona would, using their perspective and priorities
- Be specific about which element to interact with using elementId
- Keep thoughts natural and conversational
- ALWAYS queue multiple operations when you can predict the next steps`;
}

/**
 * Build the user prompt for a specific step
 */
function buildUserPrompt(
  goal: string,
  pageState: PageState,
  previousActions: string[],
  documentIndex?: string,
  lastReadContent?: string | null,
  lastActionFeedback?: string | null,
  playbookSummary?: string | null
): string {
  const parts: string[] = [
    `CURRENT GOAL: ${goal}`,
  ];

  // Playbook summary BEFORE page elements — so LLM reads it first and can plan ahead
  if (playbookSummary) {
    parts.push('');
    parts.push(playbookSummary);
  }

  parts.push('');
  parts.push(formatPageStateForLLM(pageState));

  // Add available documents
  if (documentIndex) {
    parts.push('');
    parts.push('AVAILABLE DOCUMENTS:');
    parts.push(documentIndex);
  }

  // Add last read document content if available
  if (lastReadContent) {
    parts.push('');
    parts.push('LAST READ DOCUMENT CONTENT:');
    parts.push(lastReadContent.slice(0, 2000)); // Limit to prevent prompt bloat
  }

  if (previousActions.length > 0) {
    parts.push('');
    parts.push('PREVIOUS ACTIONS:');
    parts.push(previousActions.slice(-5).join('\n')); // Last 5 actions
  }

  // Add feedback about the last action's result
  if (lastActionFeedback) {
    parts.push('');
    parts.push('RESULT OF LAST ACTION:');
    parts.push(lastActionFeedback);
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

// Track which sessions have been created (first call uses --session-id, subsequent use --resume)
const createdSessions = new Set<string>();

/**
 * Invoke Claude CLI and get a response
 */
export async function invokeClaudeCLI(
  systemPrompt: string,
  userPrompt: string,
  sessionId?: string
): Promise<string> {
  // Find Claude CLI path if not cached
  if (!claudePath) {
    claudePath = await findClaudeCLI();
  }

  return new Promise((resolve, reject) => {
    const isNewSession = sessionId && !createdSessions.has(sessionId);
    debug('Invoking Claude CLI at:', claudePath, sessionId ? `(session: ${sessionId.slice(0, 8)}..., new: ${isNewSession})` : '(no session)');

    // Combine into a single prompt for simplicity
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    const args = ['--print', '--model', 'claude-haiku-4-5-20251001'];
    if (sessionId) {
      if (isNewSession) {
        // First call for this session - create it
        args.push('--session-id', sessionId);
        createdSessions.add(sessionId);
      } else {
        // Subsequent calls - resume the existing session
        args.push('--resume', sessionId);
      }
    } else {
      args.push('--no-session-persistence');
    }

    const proc = spawn(claudePath!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
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
 * Truncate actions array after a document.read action.
 * Read content isn't available to the LLM until the next cycle,
 * so any non-terminal actions after a read are invalid.
 */
function truncateAfterDocumentRead(actions: Action[]): Action[] {
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].type === 'document' && actions[i].document?.operation === 'read') {
      return actions.slice(0, i + 1);
    }
  }
  return actions;
}

/**
 * Parse LLM response to extract actions (supports both single and batch format)
 */
function parseResponse(response: string): BatchThinkingResult {
  const jsonStr = extractFirstJson(response);
  if (!jsonStr) {
    throw new Error('No JSON found in LLM response');
  }

  try {
    const parsed = JSON.parse(jsonStr);

    if (!parsed.thought || typeof parsed.thought !== 'string') {
      throw new Error('Missing or invalid thought field');
    }

    // Accept either 'actions' (array) or 'action' (single) for backward compatibility
    let actions: Action[];
    if (parsed.actions) {
      actions = Array.isArray(parsed.actions) ? parsed.actions : [parsed.actions];
    } else if (parsed.action && typeof parsed.action === 'object') {
      actions = [parsed.action];
    } else {
      throw new Error('Missing action or actions field');
    }

    // Validate each action has a type or playbook reference
    for (const action of actions) {
      if (!action.type && !action.playbook) {
        throw new Error('Action missing both type and playbook fields');
      }
    }

    // Cap batch size
    if (actions.length > MAX_BATCH_SIZE) {
      debug('Batch size %d exceeds max %d, truncating', actions.length, MAX_BATCH_SIZE);
      actions = actions.slice(0, MAX_BATCH_SIZE);
    }

    // Truncate after document.read
    actions = truncateAfterDocumentRead(actions);

    return {
      thought: parsed.thought,
      actions,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      sequenceName: typeof parsed.sequenceName === 'string' ? parsed.sequenceName : undefined,
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
  previousActions: string[] = [],
  documentIndex?: string,
  lastReadContent?: string | null,
  sessionId?: string,
  lastActionFeedback?: string | null,
  playbookSummary?: string | null
): Promise<BatchThinkingResult> {
  const systemPrompt = buildSystemPrompt(persona);
  const userPrompt = buildUserPrompt(goal, pageState, previousActions, documentIndex, lastReadContent, lastActionFeedback, playbookSummary);

  debug('Getting next action for goal:', goal);
  debug('Page has %d elements', pageState.elements.length);

  const response = await invokeClaudeCLI(systemPrompt, userPrompt, sessionId);
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

IMPORTANT: Use the element numbers from the annotations to specify which element to interact with.

Your response MUST be valid JSON with this exact structure:
{
  "thought": "Your internal monologue as this persona (1-2 sentences, first person)",
  "sequenceName": "optional short name for this action sequence (for future replay)",
  "actions": [
    {
      "type": "click|type|press|scroll|hover|drag|wait|done|failed",
      "elementId": <the number from the red label, e.g. 5 for [5]>,
      "playbook": "<name of a stored playbook to replay>",
      "x": <pixel x coordinate for coordinate fallback click>,
      "y": <pixel y coordinate for coordinate fallback click>,
      "targetElementId": <number of target element for drag>,
      "sourceX": <pixel x for coordinate-based drag>,
      "sourceY": <pixel y for coordinate-based drag>,
      "targetX": <pixel x destination for coordinate-based drag>,
      "targetY": <pixel y destination for coordinate-based drag>,
      "text": "<text to type if type action>",
      "key": "<key to press: Enter, Escape, Tab, ArrowDown, ArrowUp>",
      "direction": "up|down (if scroll)",
      "amount": <pixels to scroll>,
      "duration": <ms to wait>,
      "reason": "<why done or failed>"
    }
  ],
  "confidence": <0.0 to 1.0>
}

OPERATION QUEUE MODEL:
You output a queue of operations. The system executes them mechanically in order.
No LLM involvement between operations — just lightweight bail checks (action failed? URL changed?).
If something unexpected happens, the system stops, takes a fresh screenshot, and re-prompts you.

Queue as many operations as you can predict. Each re-prompt costs 5-15 seconds.
Err on the side of queuing more — the system will bail safely if anything goes wrong.

ALWAYS batch these patterns (2-5 actions):
- Form filling: click field + type text + press Tab/Enter
- Search: click search box + type query + press Enter
- Multi-step UI: click button + fill field + click submit
- Dismissing modals + next action: click dismiss + click target element

Only use a SINGLE action when:
- You genuinely don't know what will appear (first visit, no stored playbooks)
- The action causes navigation to a new page

STORED PLAYBOOKS:
If a "STORED PLAYBOOKS" section lists playbooks in the prompt, you may reference them by exact name:
{"playbook": "dismiss-get-started-modal"}
You can mix playbook references with inline operations in the same batch.
ONLY reference playbooks that are explicitly listed. NEVER invent playbook names.
If no playbooks are listed, use inline actions only (click, type, press, scroll, etc.).

"done" and "failed" must ALWAYS be the LAST action in the array.

DOCUMENT ACTIONS:
You can create and maintain documents to record your findings, notes, and journey.
Use the "document" action type with these operations:

- create: Start a new document
  {"type": "document", "document": {"operation": "create", "filename": "notes.md", "content": "# Notes\\n..."}}

- read: Read existing document (content will be available in next step)
  {"type": "document", "document": {"operation": "read", "filename": "notes.md"}}

- update: Replace content (optionally target a section by heading)
  {"type": "document", "document": {"operation": "update", "filename": "notes.md", "content": "...", "section": "## Findings"}}

- append: Add to end of document
  {"type": "document", "document": {"operation": "append", "filename": "notes.md", "content": "\\n## New Section\\n..."}}

Formats: .md (Markdown), .json (JSON), .txt (plain text), or any custom extension.
Document when your goal mentions: document, record, note, track, log, compare, write down.

COORDINATE FALLBACK:
If you see an interactive element in the screenshot that has NO red numbered label
(e.g., color swatches, popover items, dropdown options that appeared after an action),
you may specify a coordinate-based click using "x" and "y" fields instead of "elementId":
{"type": "click", "x": 450, "y": 320}
Estimate coordinates from the screenshot (viewport is typically 1440x900).
Only use this when no annotated element covers what you need to click.

Rules:
- CRITICAL: Look at the RED numbered labels [0], [1], [2] etc in the screenshot and use the EXACT number for the element you want to interact with
- The Element Legend below tells you what each [number] refers to - use it to verify you're selecting the right element
- Look at the visual context to understand the page layout and purpose
- IMPORTANT: After typing in a search box, ALWAYS press Enter to submit. Do NOT try to click dropdown suggestions - they are inside shadow DOM and clicking them will fail
- Use "drag" when you need to drag an element to another (captcha sliders, sortable lists, drag-and-drop):
  - If elements are annotated with [numbers], use elementId (source) and targetElementId (destination)
  - If NO elements are annotated (e.g. captcha/verification pages), use pixel coordinates: sourceX, sourceY, targetX, targetY based on what you see in the screenshot. Estimate the coordinates from the screenshot dimensions (viewport is typically 1440x900)
- Use "done" when you believe the goal has been achieved
- Use "failed" if you cannot find a way to achieve the goal
- Think as the persona would, using their perspective and priorities
- For typing: first click the input field, then type in a separate action
- ALWAYS queue multiple operations when you can predict the next steps`;
}

/**
 * Build the vision user prompt with screenshot
 */
function buildVisionUserPrompt(
  goal: string,
  elementLegend: string,
  previousActions: string[],
  documentIndex?: string,
  lastReadContent?: string | null,
  lastActionFeedback?: string | null,
  playbookSummary?: string | null
): string {
  const parts: string[] = [
    `CURRENT GOAL: ${goal}`,
  ];

  // Playbook summary BEFORE element legend — so LLM reads it first
  if (playbookSummary) {
    parts.push('');
    parts.push(playbookSummary);
  }

  parts.push('');
  parts.push('Look at the annotated screenshot. Elements are marked with red boxes and [number] labels.');
  parts.push('');
  parts.push(elementLegend);

  // Add available documents
  if (documentIndex) {
    parts.push('');
    parts.push('AVAILABLE DOCUMENTS:');
    parts.push(documentIndex);
  }

  // Add last read document content if available
  if (lastReadContent) {
    parts.push('');
    parts.push('LAST READ DOCUMENT CONTENT:');
    parts.push(lastReadContent.slice(0, 2000)); // Limit to prevent prompt bloat
  }

  if (previousActions.length > 0) {
    parts.push('');
    parts.push('PREVIOUS ACTIONS:');
    parts.push(previousActions.slice(-5).join('\n')); // Last 5 actions
  }

  // Add feedback about the last action's result
  if (lastActionFeedback) {
    parts.push('');
    parts.push('RESULT OF LAST ACTION:');
    parts.push(lastActionFeedback);
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
  // Coordinate-based click fallback (when element has no annotation)
  x?: number;
  y?: number;
}

export interface VisionThinkingResult {
  thought: string;
  action: VisionAction;
  confidence: number;
}

export interface VisionBatchThinkingResult {
  thought: string;
  actions: VisionAction[];
  confidence: number;
  sequenceName?: string;
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
 * Parse vision LLM response (supports both single and batch format)
 */
function parseVisionResponse(response: string): VisionBatchThinkingResult {
  debug('Parsing vision response (%d chars)', response.length);

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

    // Accept either 'actions' (array) or 'action' (single)
    let actions: VisionAction[];
    if (parsed.actions) {
      actions = Array.isArray(parsed.actions) ? parsed.actions : [parsed.actions];
    } else if (parsed.action && typeof parsed.action === 'object') {
      actions = [parsed.action];
    } else {
      throw new Error('Missing action or actions field');
    }

    for (const action of actions) {
      if (!action.type && !action.playbook) {
        throw new Error('Action missing both type and playbook fields');
      }
    }

    if (actions.length > MAX_BATCH_SIZE) {
      debug('Vision batch size %d exceeds max %d, truncating', actions.length, MAX_BATCH_SIZE);
      actions = actions.slice(0, MAX_BATCH_SIZE);
    }

    actions = truncateAfterDocumentRead(actions) as VisionAction[];

    return {
      thought: parsed.thought,
      actions,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      sequenceName: typeof parsed.sequenceName === 'string' ? parsed.sequenceName : undefined,
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
export async function invokeClaudeCLIWithVision(
  systemPrompt: string,
  userPrompt: string,
  screenshotPath: string,
  sessionId?: string
): Promise<string> {
  if (!claudePath) {
    claudePath = await findClaudeCLI();
  }

  return new Promise((resolve, reject) => {
    const isNewSession = sessionId && !createdSessions.has(sessionId);
    debug('Invoking Claude CLI with vision, screenshot:', screenshotPath, sessionId ? `(session: ${sessionId.slice(0, 8)}..., new: ${isNewSession})` : '');

    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}\n\nLook at the screenshot at: ${screenshotPath}`;

    const args = ['--print', '--model', 'claude-haiku-4-5-20251001', '--dangerously-skip-permissions'];
    if (sessionId) {
      if (isNewSession) {
        args.push('--session-id', sessionId);
        createdSessions.add(sessionId);
      } else {
        args.push('--resume', sessionId);
      }
    } else {
      args.push('--no-session-persistence');
    }

    const proc = spawn(claudePath!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
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
  previousActions: string[] = [],
  documentIndex?: string,
  lastReadContent?: string | null,
  sessionId?: string,
  lastActionFeedback?: string | null,
  playbookSummary?: string | null
): Promise<VisionBatchThinkingResult> {
  const systemPrompt = buildVisionSystemPrompt(persona);
  const userPrompt = buildVisionUserPrompt(goal, elementLegend, previousActions, documentIndex, lastReadContent, lastActionFeedback, playbookSummary);

  debug('Getting next action from screenshot for goal:', goal);

  // Save screenshot to temp file (Claude CLI needs file access, not inline base64)
  const screenshotPath = await saveScreenshotToTemp(screenshot);

  try {
    const response = await invokeClaudeCLIWithVision(systemPrompt, userPrompt, screenshotPath, sessionId);
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
  if (action.playbook) return `Playbook: "${action.playbook}"`;

  switch (action.type) {
    case 'click':
      return `Clicked element ${action.elementId} (${action.selector})`;
    case 'type':
      return `Typed "${action.text}" into element ${action.elementId}`;
    case 'scroll':
      return `Scrolled ${action.direction} ${action.amount}px`;
    case 'drag':
      return `Dragged element ${action.elementId} to element ${action.targetElementId}`;
    case 'hover':
      return `Hovered over element ${action.elementId}`;
    case 'wait':
      return `Waited ${action.duration}ms`;
    case 'document':
      return `Document ${action.document?.operation}: ${action.document?.filename}`;
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
  if (action.playbook) return `[sight] Playbook: "${action.playbook}"`;

  const elemRef = action.elementId !== undefined ? ` element [${action.elementId}]` : '';

  switch (action.type) {
    case 'click':
      return `[sight] Clicked${elemRef}`;
    case 'type':
      return `[sight] Typed "${action.text}" into${elemRef}`;
    case 'press':
      return `[sight] Pressed ${action.key}`;
    case 'scroll':
      return `[sight] Scrolled ${action.direction} ${action.amount}px`;
    case 'drag': {
      if (action.sourceX !== undefined && action.targetX !== undefined) {
        return `[sight] Dragged from (${action.sourceX},${action.sourceY}) to (${action.targetX},${action.targetY})`;
      }
      const targetRef = action.targetElementId !== undefined ? ` to element [${action.targetElementId}]` : '';
      return `[sight] Dragged${elemRef}${targetRef}`;
    }
    case 'hover':
      return `[sight] Hovered over${elemRef}`;
    case 'wait':
      return `[sight] Waited ${action.duration}ms`;
    case 'document':
      return `[sight] Document ${action.document?.operation}: ${action.document?.filename}`;
    case 'done':
      return `[sight] Goal completed: ${action.reason}`;
    case 'failed':
      return `[sight] Goal failed: ${action.reason}`;
    default:
      return `[sight] Unknown action: ${action.type}`;
  }
}

/**
 * Normalize a single-action result to batch format (backward compatibility)
 */
export function normalizeToBatch(
  result: ThinkingResult | BatchThinkingResult
): BatchThinkingResult {
  if ('action' in result && !('actions' in result)) {
    return { thought: result.thought, actions: [(result as ThinkingResult).action], confidence: result.confidence };
  }
  return result as BatchThinkingResult;
}

/**
 * Format batch execution results as feedback for the next LLM call
 */
export function formatBatchFeedback(
  results: Array<{ actionDesc: string; success: boolean; error?: string }>,
  bailReason?: string
): string {
  if (results.length === 0) {
    return bailReason ? `BATCH SKIPPED: ${bailReason}` : 'No actions executed.';
  }

  if (results.length === 1) {
    const r = results[0];
    return r.success
      ? `SUCCESS: "${r.actionDesc}" completed.`
      : `FAILED: "${r.actionDesc}" failed with error: ${r.error}. Try a different approach.`;
  }

  const lines = results.map((r, i) =>
    r.success
      ? `${i + 1}. SUCCESS: "${r.actionDesc}"`
      : `${i + 1}. FAILED: "${r.actionDesc}" - ${r.error}`
  );
  const header = bailReason
    ? `BATCH RESULT (${results.length} actions executed, bailed: ${bailReason}):`
    : `BATCH RESULT (${results.length} actions completed):`;

  return [header, ...lines].join('\n');
}
