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
├── cli.ts                # CLI entry point (run, validate, sessions commands)
├── index.ts              # Public API exports
└── lib/
    ├── persona.ts        # Persona config schema and loader (zod validation)
    ├── page-analyzer.ts  # Extract interactive elements from pages
    ├── llm.ts            # Claude CLI integration for persona thinking
    ├── speech-bubble.ts  # Inject speech bubble overlay into pages
    ├── action-executor.ts # Map LLM decisions to puppet commands
    ├── session.ts        # Main orchestrator loop
    ├── dom-settle.ts     # Adaptive DOM settle detection (MutationObserver)
    ├── state-observer.ts # DOM state delta capture for learning
    └── domain-knowledge.ts # Persistent domain knowledge store
```

## Key Components

### Persona Configuration
- YAML-based configuration with zod validation
- Defines: persona background, jobs-to-be-done, goals, URL
- Options: viewport size, timeout, thinking speed

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
- Main loop: analyze → think → show bubble → execute batch → repeat
- Batch execution: LLM can return multiple actions per cycle, executed in sequence
- Bail-out checks between batch actions: failure, URL change, missing target, assertion mismatch
- Video recording per goal
- Saves transcripts and session metadata
- Handles timeouts and action limits

### Adaptive DOM Settle Detection
- `waitForDOMSettle()` replaces fixed `waitForLoaded(2000)` for post-action settling
- MutationObserver-based: resolves when DOM stops changing (100ms quiet period)
- Hard cap at 2s prevents infinite waits on chatty sites
- Fast pages settle in ~20ms, framework re-renders in ~100-150ms, API loads in ~500ms-2s
- Navigation-safe: try/catch around evaluate() handles page transitions

### Domain Knowledge & Learned Assertions
- Observes DOM state deltas after each action (focus, aria changes, visibility, URL)
- Records transitions per domain in `~/.abra/domains/` as JSONL files
- On repeat visits, asserts expected outcomes — bails to re-sensing on mismatch
- Piecemeal learning: only updates the specific transition that changed
- Cold start = current behavior; gets faster with each visit
- Similarity matching: additive noise ignored, only missing expected changes trigger bail
- `--no-learn` CLI flag disables knowledge recording and assertions
- Append-only per-session log files prevent concurrent write conflicts

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

## CLI Commands

- `abra run <persona.yaml>` - Run simulation
  - `--sight-mode` - Use screenshots for decision-making
  - `--observe` - Enable observer agent for concurrent documentation
  - `--no-learn` - Disable domain knowledge recording and assertions
  - `--goals <indices>` - Run specific goals only
  - `--headless` - Run browser in headless mode
- `abra validate <persona.yaml>` - Validate config
- `abra sessions` - List past sessions

## Dependencies

- puppet (peer) - Browser automation
- commander - CLI framework
- yaml - YAML parsing
- zod - Schema validation
- chalk/ora - CLI styling
- debug - Debug logging
