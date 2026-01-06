/**
 * Abra - Automated user-testing platform
 *
 * Simulates user personas interacting with websites to achieve goals,
 * with speech bubbles showing their thought process.
 */

// Persona configuration
export {
  loadPersona,
  validatePersona,
  getThinkingDelay,
  PersonaConfigSchema,
  type PersonaConfig,
  type PersonaDetails,
  type Options,
  type Viewport,
} from './lib/persona.js';

// Page analysis
export {
  PAGE_ANALYZER_SCRIPT,
  formatPageStateForLLM,
  type PageElement,
  type PageState,
} from './lib/page-analyzer.js';

// LLM integration
export {
  getNextAction,
  formatAction,
  type Action,
  type ActionType,
  type ThinkingResult,
} from './lib/llm.js';

// Action execution
export {
  executeAction,
  getElementCenter,
  getHumanDelay,
  type Browser,
  type ExecutionResult,
} from './lib/action-executor.js';

// Speech bubble
export {
  getInitScript,
  getShowScript,
  getHideScript,
  getMoveScript,
  getDestroyScript,
} from './lib/speech-bubble.js';

// Session orchestration
export {
  runSession,
  type SessionResult,
  type GoalResult,
  type SessionOptions,
} from './lib/session.js';
