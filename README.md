# Abra

Automated user-testing platform that simulates personas interacting with websites to achieve their goals.

## What It Does

Abra creates realistic user testing sessions by:

1. **Simulating a Persona** - Configure a user persona with background, jobs-to-be-done, and specific goals
2. **Navigating Autonomously** - The persona explores your website, making decisions based on their goals and context
3. **Thinking Out Loud** - A speech bubble follows the cursor, showing the persona's thought process as they interact
4. **Recording Everything** - Each goal attempt is recorded as a video for later review

## Use Cases

- **UX Research** - Watch how a simulated user thinks through your interface
- **Usability Testing** - Identify friction points where personas struggle to achieve goals
- **Onboarding Validation** - Verify that new users can complete key workflows
- **Accessibility Insights** - See how different personas interpret your UI elements
- **Automated QA** - Generate video evidence of user journeys for review

## Installation

```bash
npm install
npm run build
```

## Requirements

- Node.js 18+
- [puppet](https://github.com/soapko/puppet) - Browser automation with human-like cursor movements (installed automatically)
- Claude CLI (`claude`) - Authenticated and available in PATH

## Quick Start

1. Create a persona configuration file:

```yaml
# personas/first-time-buyer.yaml
persona:
  name: Sarah Chen
  background: |
    28-year-old product manager who shops online frequently.
    Comfortable with technology but values efficiency.
    First time visiting this e-commerce site.

  jobs_to_be_done:
    - Find products that solve my specific needs quickly
    - Feel confident I'm getting a good deal
    - Complete purchases without friction or confusion

url: https://example-store.com

goals:
  - Find a laptop suitable for remote work under $1000
  - Add the laptop to cart and proceed to checkout
```

2. Run the simulation:

```bash
node dist/cli.js run personas/first-time-buyer.yaml
```

3. Watch the output videos in `./sessions/`

## Authenticated Sessions

Many sites require login (OAuth, email/password, etc.). Abra supports this by saving and restoring browser auth state.

### 1. Capture auth state

```bash
# Opens a browser — log in manually, then press ENTER in the terminal
abra auth google

# Optionally navigate to a specific URL first
abra auth claude --url https://claude.ai
```

Auth state is saved to `~/.abra/auth/<name>.json`. This file contains cookies and localStorage — enough to restore a logged-in session.

### 2. Use it in a persona

Add an `auth` field to your persona YAML:

```yaml
persona:
  name: Shane
  background: BDR at a SaaS company
  jobs_to_be_done:
    - Review shared documents and dashboards

url: https://app.example.com/dashboard

auth:
  storageState: google        # loads ~/.abra/auth/google.json

goals:
  - Navigate to the reports page and export the weekly summary
```

You can also use an absolute path:

```yaml
auth:
  storageState: /path/to/auth-state.json
```

Or connect to an already-running Chrome instance via CDP:

```yaml
auth:
  cdpUrl: http://localhost:9222
```

### 3. Refreshing expired auth

Auth tokens expire. Abra warns if your auth state file is older than 24 hours. To refresh, just run the capture command again:

```bash
abra auth google
```

## CLI Commands

```bash
# Run a persona simulation
node dist/cli.js run <persona-file>

# Run with sight mode (uses screenshots for smarter decisions)
node dist/cli.js run personas/buyer.yaml --sight-mode

# Run with specific goals only
node dist/cli.js run personas/buyer.yaml --goals 1,3

# Run in headless mode (no browser window)
node dist/cli.js run personas/buyer.yaml --headless

# Custom output directory
node dist/cli.js run personas/buyer.yaml --output ./my-sessions

# Validate a persona file without running
node dist/cli.js validate personas/buyer.yaml

# List recent sessions
node dist/cli.js sessions

# Capture auth state for authenticated testing
node dist/cli.js auth <name>
node dist/cli.js auth <name> --url https://example.com
```

## Persona Configuration

```yaml
persona:
  name: string           # Display name for the persona
  background: string     # Rich description of who they are
  jobs_to_be_done:       # What they're trying to accomplish in life/work
    - string
    - string

url: string              # Starting URL for the session

goals:                   # Specific tasks to attempt (one video per goal)
  - string
  - string

auth:                    # Optional — for authenticated sessions
  storageState: string   # Name (e.g. "google") or path to storageState JSON
  cdpUrl: string         # Or connect to existing Chrome via CDP

options:                 # Optional settings
  viewport:              # Browser viewport size
    width: 1440
    height: 900
  timeout: 300000        # Max time per goal (ms), default 5 minutes
  thinkingSpeed: fast    # slow | normal | fast - affects pauses between actions
```

### Thinking Speed

| Speed | Thinking Pause |
|-------|----------------|
| `fast` (default) | 500-1000ms |
| `normal` | 1000-2000ms |
| `slow` | 2000-4000ms |

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                         Abra Orchestrator                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   Persona    │───▶│    Page      │───▶│      LLM         │  │
│  │   Config     │    │   Analyzer   │    │   (Claude CLI)   │  │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘  │
│                                                   │             │
│                                         ┌─────────▼─────────┐   │
│                                         │  Decision Engine  │   │
│                                         │  - Next action    │   │
│                                         │  - Reasoning      │   │
│                                         └─────────┬─────────┘   │
│                                                   │             │
│  ┌──────────────┐    ┌──────────────┐    ┌───────▼──────────┐  │
│  │   Video      │◀───│   Puppet     │◀───│  Action Executor │  │
│  │   Output     │    │   Browser    │    │  + Speech Bubble │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Flow

1. **Load Persona** - Parse YAML config and initialize persona context
2. **Start Session** - Launch browser with video recording via puppet
3. **Navigate to URL** - Go to the starting URL
4. **For Each Goal**:
   - Inject speech bubble overlay into page
   - Analyze page - Extract all interactive elements (including shadow DOM)
   - Send context to LLM (persona + goal + page elements)
   - LLM returns: thought process + next action
   - Display thought in speech bubble near target element
   - Execute action via puppet (click, type, scroll, press key, etc.)
   - Wait for page to settle
   - Repeat until goal achieved, failed, or timeout
   - Save video
5. **Generate Report** - Summary of goal outcomes

### Sight Mode

With `--sight-mode`, Abra uses annotated screenshots instead of HTML analysis:

1. Captures screenshot of current page
2. Overlays numbered labels on interactive elements
3. Sends screenshot to Claude's vision API
4. Claude visually identifies what to click based on appearance
5. Maps visual selection back to HTML elements for reliable clicking

This is more robust for complex UIs with shadow DOM, dynamic content, or non-standard elements.

## Output

### Session Directory Structure

```
sessions/
└── sarah-chen-1704538200000/
    ├── videos/
    │   └── *.webm
    ├── goal-1-find-laptop-transcript.md
    ├── goal-2-add-to-cart-transcript.md
    └── session.json
```

### Session Metadata

```json
{
  "persona": "Sarah Chen",
  "startedAt": "2025-01-06T10:30:00Z",
  "completedAt": "2025-01-06T10:35:42Z",
  "goals": [
    {
      "description": "Find a laptop suitable for remote work under $1000",
      "status": "completed",
      "duration": 45000,
      "actions": 12
    },
    {
      "description": "Add the laptop to cart and proceed to checkout",
      "status": "failed",
      "duration": 120000,
      "actions": 8,
      "failureReason": "Could not locate add to cart button"
    }
  ]
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run with debug output
DEBUG=abra:* node dist/cli.js run personas/example.yaml
```

## License

MIT
