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
  type AuthConfig,
} from './lib/persona.js';

// Auth utilities
export {
  resolveAuth,
  resolveStorageStatePath,
  validateStorageState,
  ensureAuthDir,
  AUTH_DIR,
} from './lib/auth.js';

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
  formatBatchFeedback,
  normalizeToBatch,
  type Action,
  type ActionType,
  type DocumentOperation,
  type ThinkingResult,
  type BatchThinkingResult,
  type VisionBatchThinkingResult,
} from './lib/llm.js';

// Document writing
export {
  DocumentWriter,
  type DocumentInfo,
  type DocumentWriteResult,
  type DocumentReadResult,
} from './lib/document-writer.js';

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

// Page content extraction (for observer)
export {
  PAGE_CONTENT_SCRIPT,
  formatPageContentForLLM,
  type PageContent,
} from './lib/page-content-extractor.js';

// Observer LLM
export {
  getObserverAction,
  type ObserverResult,
} from './lib/observer-llm.js';

// DOM settle detection
export {
  waitForDOMSettle,
  type DOMSettleOptions,
} from './lib/dom-settle.js';

// Playbook store
export {
  PlaybookStore,
  toRelative,
  toAbsolute,
  type RelativePosition,
  type PlaybookOperation,
  type Playbook,
  type RecordedOperation,
} from './lib/playbook-store.js';

// Session orchestration
export {
  runSession,
  type SessionResult,
  type GoalResult,
  type SessionOptions,
} from './lib/session.js';
