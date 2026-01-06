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
