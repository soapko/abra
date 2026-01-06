# Abra - Task List

## 001.setup

- [ ] Initialize linting and pre-commit hooks -> [001.setup.01-init-linting.md](docs/tasks/001.setup.01-init-linting.md)
- [✅] **Task 1: Initialize project structure** -> [001.setup.02-project-structure.md](docs/tasks/001.setup.02-project-structure.md)
  - Create package.json with TypeScript and ESM configuration
  - Set up tsconfig.json
  - Configure build scripts
  - Create directory structure: `src/`, `personas/`, `sessions/`

## 002.core

- [✅] **Task 2: Persona configuration schema and loader** -> [002.core.01-persona-loader.md](docs/tasks/002.core.01-persona-loader.md)
  - Define TypeScript interfaces for persona config
  - Create YAML parser with validation (using zod)
  - Handle default values and optional fields
  - Export `loadPersona(filePath)` function

- [✅] **Task 3: Page analyzer module** -> [002.core.02-page-analyzer.md](docs/tasks/002.core.02-page-analyzer.md)
  - Extract all interactive elements from page (buttons, links, inputs, etc.)
  - Get element attributes: text, aria-label, data-testid, position
  - Filter to visible/clickable elements only
  - Return structured data for LLM consumption

- [✅] **Task 4: LLM integration module** -> [002.core.03-llm-integration.md](docs/tasks/002.core.03-llm-integration.md)
  - Wrapper for Claude CLI invocation via child_process
  - Build prompts with persona context + page state + goal
  - Parse LLM response for action decisions
  - Optional: local LLM fallback for structured responses

- [✅] **Task 5: Speech bubble overlay** -> [002.core.04-speech-bubble.md](docs/tasks/002.core.04-speech-bubble.md)
  - CSS/JS for speech bubble component
  - Inject into page via puppet's evaluate()
  - Position bubble relative to cursor/target element
  - Animate text appearance (typewriter effect)
  - Update content as persona "thinks"

- [✅] **Task 6: Action executor** -> [002.core.05-action-executor.md](docs/tasks/002.core.05-action-executor.md)
  - Map LLM action decisions to puppet commands
  - Support: click, type, scroll, hover, wait
  - Handle element selection via various selectors
  - Error handling and retry logic

## 003.orchestration

- [✅] **Task 7: Session orchestrator** -> [003.orchestration.01-session-orchestrator.md](docs/tasks/003.orchestration.01-session-orchestrator.md)
  - Main loop: analyze page → think → act → repeat
  - Goal completion detection (LLM-based)
  - Timeout handling
  - Video recording per goal
  - Session state management

- [✅] **Task 8: Output and reporting** -> [003.orchestration.02-output-reporting.md](docs/tasks/003.orchestration.02-output-reporting.md)
  - Save session metadata (JSON)
  - Generate thought transcript (Markdown)
  - Organize videos by session/goal
  - Summary report generation

## 004.cli

- [✅] **Task 9: CLI interface** -> [004.cli.01-cli-interface.md](docs/tasks/004.cli.01-cli-interface.md)
  - `run` command with options
  - `validate` command for persona files
  - `sessions` command to list past sessions
  - Progress output during simulation

## 005.testing

- [✅] **Task 10: Sample personas** -> [005.testing.01-sample-personas.md](docs/tasks/005.testing.01-sample-personas.md)
  - Create example persona files
  - Document best practices for writing personas

- [✅] **Task 11: End-to-end testing** -> [005.testing.02-e2e-testing.md](docs/tasks/005.testing.02-e2e-testing.md)
  - Test against a known website (example.com or local test server)
  - Verify video output
  - Verify speech bubble rendering
  - Verify goal completion detection

---

## Task Status Key

- [ ] Not started
- [◒] In progress / implemented but not tested
- [❌] Implemented but failed testing
- [✅] Implemented and passed testing
