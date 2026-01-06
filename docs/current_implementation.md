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
├── cli.ts              # CLI entry point (run, validate, sessions commands)
├── index.ts            # Public API exports
└── lib/
    ├── persona.ts      # Persona config schema and loader (zod validation)
    ├── page-analyzer.ts # Extract interactive elements from pages
    ├── llm.ts          # Claude CLI integration for persona thinking
    ├── speech-bubble.ts # Inject speech bubble overlay into pages
    ├── action-executor.ts # Map LLM decisions to puppet commands
    └── session.ts      # Main orchestrator loop
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
- Returns structured JSON: thought + action + confidence
- Supports actions: click, type, scroll, hover, wait, done, failed

### Speech Bubble
- CSS/JS injected into page via evaluate()
- Shows persona's thoughts near cursor position
- Typewriter animation for natural feel
- Auto-positions to stay on screen

### Session Orchestrator
- Main loop: analyze → think → show bubble → execute → repeat
- Video recording per goal
- Saves transcripts and session metadata
- Handles timeouts and action limits

## CLI Commands

- `abra run <persona.yaml>` - Run simulation
- `abra validate <persona.yaml>` - Validate config
- `abra sessions` - List past sessions

## Dependencies

- puppet (peer) - Browser automation
- commander - CLI framework
- yaml - YAML parsing
- zod - Schema validation
- chalk/ora - CLI styling
- debug - Debug logging
