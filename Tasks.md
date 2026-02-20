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

## 006.features

- [◒] **Task 12: Sight-based analysis mode** -> [006.features.01-sight-mode.md](docs/tasks/006.features.01-sight-mode.md)
  - Add `--sight-mode` CLI flag
  - Use screenshots for decision-making (vision LLM)
  - Map visual coordinates back to HTML elements for actions
  - Keep HTML selectors for reliable action execution

## 007.bugfix

- [✅] **Task 13: Unique selector generation** -> [007.bugfix.01-unique-selectors.md](docs/tasks/007.bugfix.01-unique-selectors.md)
  - Check selector uniqueness before returning
  - Combine attributes for unique selectors
  - Coordinate fallback when selectors fail

## 008.bugfix

- [✅] **Task 14: Shadow DOM element clicking** -> [008.bugfix.shadow-dom-clicking.md](docs/tasks/008.bugfix.shadow-dom-clicking.md)
  - Elements inside shadow DOM (dropdowns, popovers) can't be clicked
  - Playwright reports "covered by" shadow host
  - `document.elementFromPoint()` returns shadow host, not inner element
  - **Fixed**: Added `deepElementFromPoint()` to pierce shadow DOM and direct href navigation for links

## 009.features

- [✅] **Task 15: Document writing capability** -> [009.features.01-document-writing.md](docs/tasks/009.features.01-document-writing.md)
  - Enable persona to write/update documents during session
  - LLM-driven: persona decides when to document based on goal text
  - Full CRUD: create, read, update, append operations
  - Supports markdown, JSON, and custom file formats
  - Documents saved to `sessions/<session>/docs/`

## 010.research

- [✅] **Task 16: Evaluate Abra vs Puppet for automated testing** -> [010.research.01-abra-vs-puppet-testing.md](docs/tasks/010.research.01-abra-vs-puppet-testing.md)
  - Compare reliability, test creation effort, coverage, speed
  - Identify good vs poor fit use cases
  - Propose hybrid testing strategy
  - Answer key questions about determinism and cost
  - Prototype Abra → Puppet test script generation

## 013.core

- [✅] **Task 19: Adaptive DOM settle detection** -> [013.core.01-dom-settle-detection.md](docs/tasks/013.core.01-dom-settle-detection.md)
  - Replace fixed `waitForLoaded(2000)` with MutationObserver-based `waitForDOMSettle()`
  - Resolves when DOM stops changing (100ms quiet period), hard cap at 2s
  - Fast pages go fast (~20ms), slow pages get patience (~500ms-2s)
  - Worst case matches current behavior (chatty sites hit 2s cap)
  - Foundation for Task 17 (inter-action timing) and Task 18 (shared observer)

## 011.features

- [✅] **Task 17: Batch action execution** -> [011.features.01-batch-action-execution.md](docs/tasks/011.features.01-batch-action-execution.md)
  - LLM returns `actions: [...]` (array) instead of single action per cycle
  - Execute in rapid sequence with lightweight bail-out checks between each
  - Bail triggers: action failure, URL change, target element missing, terminal action
  - Backward compatible: parser accepts both old and new format
  - Reduces LLM round-trips for predictable multi-step interactions
  - **Depends on:** 013.core.01 (Adaptive DOM Settle Detection)

## 012.features

- [✅] **Task 18: Domain knowledge & learned assertions** -> [012.features.01-domain-knowledge-learned-assertions.md](docs/tasks/012.features.01-domain-knowledge-learned-assertions.md)
  - Observe and record state deltas (DOM changes) after each action
  - On repeat visits, use recorded observations as assertions for faster execution
  - Optimistic execution: trust knowledge, correct on contact when assertions fail
  - Piecemeal learning: only update the specific transitions that changed
  - Cold start = current behavior; gets faster with each visit to a domain
  - **Depends on:** 013.core.01 (DOM Settle Detection), 011.features.01 (Batch Action Execution)

## 014.bugfix

- [◒] **Task 20: Portal scanning + vision coordinate fallback** -> [014.bugfix.01-portal-scanning-vision-fallback.md](docs/tasks/014.bugfix.01-portal-scanning-vision-fallback.md)
  - Page analyzer now scans Radix/Floating/Headless UI portal containers
  - Vision prompt allows coordinate-based clicks for unannotated elements
  - Action executor handles coordinate clicks from vision fallback
  - Tested against shadcn customizer: purple theme + Maia style + Large radius selected

## 015.features

- [◒] **Task 21: Knowledge-driven batching** -> [015.features.01-knowledge-driven-batching.md](docs/tasks/015.features.01-knowledge-driven-batching.md)
  - Inject domain knowledge into LLM prompt so it can plan ahead
  - Add `label` field for targeting elements by visible text (not yet visible)
  - Label resolution in executeBatch: re-scan page, find by text, click
  - Enables multi-step batches like: click Theme dropdown → click "Purple" by label
  - **Depends on:** Task 18 (Domain Knowledge), Task 17 (Batch Execution)

---

## Task Status Key

- [ ] Not started
- [◒] In progress / implemented but not tested
- [❌] Implemented but failed testing
- [✅] Implemented and passed testing
