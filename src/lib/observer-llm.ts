/**
 * Observer LLM module - dedicated agent that reads page content and documents observations.
 * Runs concurrently with the Navigator agent; focused purely on reading and writing, never navigating.
 */

import createDebug from 'debug';
import type { PersonaConfig } from './persona.js';
import type { PageContent } from './page-content-extractor.js';
import { formatPageContentForLLM } from './page-content-extractor.js';
import { invokeClaudeCLI } from './llm.js';
import type { DocumentOperation } from './llm.js';

const debug = createDebug('abra:observer');

export interface ObserverResult {
  /** What the observer noticed about this page */
  observation: string;
  /** Action: either document something or skip */
  action: {
    type: 'document' | 'skip';
    document?: {
      operation: DocumentOperation;
      filename: string;
      content?: string;
      section?: string;
    };
  };
  /** How noteworthy this page is (0 = boring, 1 = very interesting) */
  salience: number;
}

/**
 * Build the system prompt for the Observer agent
 */
function buildObserverSystemPrompt(persona: PersonaConfig): string {
  return `You are the OBSERVER agent for a persona usability test. Your role is to READ and DOCUMENT what the persona sees on the page. You do NOT navigate or click anything — a separate Navigator agent handles that.

PERSONA:
Name: ${persona.persona.name}
Background: ${persona.persona.background}

JOBS TO BE DONE:
${persona.persona.jobs_to_be_done.map(j => `- ${j}`).join('\n')}

Your job each step:
1. Read the page content provided to you
2. Decide if it's worth documenting from this persona's perspective
3. Either write an observation document or skip

IMPORTANT RULES:
- You can ONLY output "document" or "skip" actions — never navigation actions
- Use filenames prefixed with "observations-" (e.g., "observations-homepage.md", "observations-search-results.md")
- Focus on what the persona would notice, find useful, confusing, or interesting
- Don't re-document pages you've already documented unless the content has meaningfully changed
- Be concise but thorough in observations

Your response MUST be valid JSON with this exact structure:
{
  "observation": "Brief note about what you see on this page (1-2 sentences, first person as the persona)",
  "action": {
    "type": "document" or "skip",
    "document": {
      "operation": "create|append|update",
      "filename": "observations-something.md",
      "content": "markdown content to write",
      "section": "optional section heading for update"
    }
  },
  "salience": 0.0 to 1.0
}

If skipping (page not noteworthy or already documented):
{
  "observation": "Brief note about why this page isn't worth documenting",
  "action": { "type": "skip" },
  "salience": 0.2
}`;
}

/**
 * Build the user prompt for the Observer agent
 */
function buildObserverUserPrompt(
  goal: string,
  pageContent: PageContent,
  documentIndex?: string
): string {
  const parts: string[] = [
    `CURRENT GOAL (being pursued by Navigator): ${goal}`,
    '',
    formatPageContentForLLM(pageContent),
  ];

  if (documentIndex) {
    parts.push('');
    parts.push('YOUR EXISTING DOCUMENTS:');
    parts.push(documentIndex);
  }

  parts.push('');
  parts.push('What do you observe on this page? Should you document anything? Respond with JSON only.');

  return parts.join('\n');
}

/**
 * Parse the Observer LLM response
 */
function parseObserverResponse(response: string): ObserverResult {
  // Extract first JSON object from response
  let braceCount = 0;
  let startIndex = -1;

  for (let i = 0; i < response.length; i++) {
    if (response[i] === '{') {
      if (startIndex === -1) startIndex = i;
      braceCount++;
    } else if (response[i] === '}') {
      braceCount--;
      if (braceCount === 0 && startIndex !== -1) {
        const jsonStr = response.slice(startIndex, i + 1);
        try {
          const parsed = JSON.parse(jsonStr);

          return {
            observation: parsed.observation || 'No observation',
            action: {
              type: parsed.action?.type === 'document' ? 'document' : 'skip',
              document: parsed.action?.type === 'document' ? parsed.action.document : undefined,
            },
            salience: typeof parsed.salience === 'number' ? parsed.salience : 0.5,
          };
        } catch (err) {
          throw new Error(`Failed to parse observer JSON: ${err}`);
        }
      }
    }
  }

  throw new Error('No JSON found in observer response');
}

/**
 * Get the Observer's assessment and optional document action for the current page.
 */
export async function getObserverAction(
  persona: PersonaConfig,
  goal: string,
  pageContent: PageContent,
  documentIndex?: string,
  sessionId?: string
): Promise<ObserverResult> {
  const systemPrompt = buildObserverSystemPrompt(persona);
  const userPrompt = buildObserverUserPrompt(goal, pageContent, documentIndex);

  debug('Observer analyzing page: %s', pageContent.title);

  const response = await invokeClaudeCLI(systemPrompt, userPrompt, sessionId);
  debug('Observer response: %s', response.slice(0, 200));

  return parseObserverResponse(response);
}
