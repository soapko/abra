# Current Implementation

## Overview

Abra is an automated user-testing platform that simulates personas interacting with websites to achieve goals. It uses:

- **puppet** for browser automation with human-like cursor movements
- **Claude CLI** for persona thinking and decision-making
- **Video recording** to capture sessions for review
- **Speech bubbles** to visualize the persona's thought process

## Architecture

```
src/
├── cli.ts                # CLI entry point (run, validate, sessions, auth commands)
├── index.ts              # Public API exports
├── commands/
│   └── auth.ts           # Auth capture command (abra auth <name>)
└── lib/
    ├── persona.ts        # Persona config schema and loader (zod validation)
    ├── auth.ts           # Auth utilities (path resolution, validation, storageState)
    ├── page-analyzer.ts  # Extract interactive elements from pages
    ├── llm.ts            # Claude CLI integration for persona thinking
    ├── speech-bubble.ts  # Inject speech bubble overlay into pages
    ├── action-executor.ts # Map LLM decisions to puppet commands
    ├── session.ts        # Main orchestrator loop
    ├── dom-settle.ts     # Adaptive DOM settle detection (MutationObserver)
    └── playbook-store.ts # Persistent playbook storage and replay
```

## Key Components

### Persona Configuration
- YAML-based configuration with zod validation
- Defines: persona background, jobs-to-be-done, goals, URL
- Options: viewport size, timeout, thinking speed
- Optional `auth` field for authenticated sessions (storageState or CDP)

### Page Analyzer
- Extracts all interactive elements (buttons, links, inputs, etc.)
- Gets: text, aria-label, testid, position, visibility, enabled state
- Generates smart selectors prioritizing data-testid

### LLM Integration
- Uses Claude CLI via child_process spawn
- Builds prompts with persona context + page state + goal
- Returns structured JSON: thought + actions[] + confidence (batch format)
- Supports actions: click, type, press, scroll, hover, drag, wait, done, failed, document
- Backward compatible: parser accepts both single `action` and batch `actions` format

### Speech Bubble
- CSS/JS injected into page via evaluate()
- Shows persona's thoughts near cursor position
- Typewriter animation for natural feel
- Auto-positions to stay on screen

### Session Orchestrator
- Main loop: analyze → think → show bubble → execute operation queue → repeat
- Operation queue: LLM outputs concrete operations executed mechanically in sequence
- Playbook references expanded inline at execution time
- Bail-out checks between operations: failure, URL change, missing target
- Operation recording: each successful action tracked for playbook creation
- Post-session stitching: consecutive single-action iterations grouped into playbooks
- Video recording per goal
- Saves transcripts and session metadata
- Handles timeouts and action limits

### Adaptive DOM Settle Detection
- `waitForDOMSettle()` replaces fixed `waitForLoaded(2000)` for post-action settling
- MutationObserver-based: resolves when DOM stops changing (100ms quiet period)
- Hard cap at 2s prevents infinite waits on chatty sites
- Fast pages settle in ~20ms, framework re-renders in ~100-150ms, API loads in ~500ms-2s
- Navigation-safe: try/catch around evaluate() handles page transitions

### Operational Playbooks
- Records successful operation sequences as named playbooks per domain
- Storage: `~/.abra/domains/{domain}/playbooks.json` (JSON, not JSONL)
- Relative coordinates: positions stored as viewport ratios, recomputed at replay time
- Selector-first targeting with coordinate fallback when selectors break
- Playbook recording: saves inline 2+ operation batches that complete without bail
- Post-session stitching: groups consecutive single-action iterations into playbooks
- LLM prompt injection: available playbooks shown as referenceable sequences
- Playbook references: LLM can output `{"playbook": "name"}` to replay stored sequences
- Rich bail feedback: includes playbook name, step number, and failure reason
- Success/failure tracking per playbook for reliability assessment
- `--no-playbooks` CLI flag disables playbook recording and replay
- Replaces: domain knowledge (JSONL), state observer, label resolution

### Shadow DOM Click Support
- `deepElementFromPoint(x, y)` pierces shadow DOM to find actual element
- For links inside shadow DOM, extracts href and navigates directly
- Falls back to event dispatch for non-link elements
- Works with Reddit search suggestions and other shadow DOM components

### Document Writing
- Personas can create and maintain documents during sessions
- LLM-driven: decides when to document based on goal cues (document, note, track, compare)
- Full CRUD operations: create, read, update (with section targeting), append
- Documents saved to `sessions/<session>/docs/`
- Supports markdown, JSON, and custom file extensions
- Document index shown to LLM each iteration for context
- Size limit: 100KB per document
- Filename sanitization prevents path traversal

### Browser Auth State
- `abra auth <name>` captures auth state by opening a browser for manual login
- Saves Playwright storageState (cookies + localStorage) to `~/.abra/auth/<name>.json`
- Persona YAML `auth.storageState` loads saved state before navigating (supports names or paths)
- Persona YAML `auth.cdpUrl` connects to an existing Chrome instance via CDP
- storageState mode: uses Playwright's `browser.newContext({ storageState })` via puppet's `launchBrowser()`
- CDP mode: uses Playwright's `chromium.connectOverCDP()` directly
- Warns if auth state file is older than 24 hours
- Clear error messages when auth file is missing

## CLI Commands

- `abra run <persona.yaml>` - Run simulation
  - `--sight-mode` - Use screenshots for decision-making
  - `--observe` - Enable observer agent for concurrent documentation
  - `--no-playbooks` - Disable playbook recording and replay
  - `--goals <indices>` - Run specific goals only
  - `--headless` - Run browser in headless mode
- `abra validate <persona.yaml>` - Validate config
- `abra sessions` - List past sessions
- `abra auth <name>` - Capture browser auth state for authenticated testing
  - `-u, --url <url>` - Navigate to a specific URL before login

## Dependencies

- puppet (peer) - Browser automation
- commander - CLI framework
- yaml - YAML parsing
- zod - Schema validation
- chalk/ora - CLI styling
- debug - Debug logging
