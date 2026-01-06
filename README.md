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
cd abra
npm install
```

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
  - Abandon checkout to test the recovery email flow
```

2. Run the simulation:

```bash
npx abra run personas/first-time-buyer.yaml
```

3. Watch the output videos in `./sessions/first-time-buyer/`

## Configuration

### Persona File Structure

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

options:                 # Optional settings
  viewport:              # Browser viewport size
    width: 1440
    height: 900
  timeout: 300000        # Max time per goal (ms), default 5 minutes
  thinkingSpeed: normal  # slow | normal | fast - affects pauses between actions
```

### Global Configuration

Create `abra.config.yaml` in your project root:

```yaml
output:
  dir: ./sessions        # Where to save session videos
  format: mp4            # Video format

llm:
  provider: claude       # claude | local
  localEndpoint: https://darkhorse.local:1234  # For structured responses

browser:
  headless: false        # Show browser during simulation
  slowMo: 50             # Slow down actions for visibility
```

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Abra Orchestrator                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   Persona    │───▶│    Page      │───▶│      LLM         │  │
│  │   Config     │    │   Analyzer   │    │   (Claude CLI)   │  │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘  │
│                                                    │             │
│                                          ┌────────▼─────────┐   │
│                                          │  Decision Engine │   │
│                                          │  - Next action   │   │
│                                          │  - Reasoning     │   │
│                                          └────────┬─────────┘   │
│                                                    │             │
│  ┌──────────────┐    ┌──────────────┐    ┌────────▼─────────┐  │
│  │   Video      │◀───│   Puppet     │◀───│  Action Executor │  │
│  │   Output     │    │   Browser    │    │  + Speech Bubble │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Flow

1. **Load Persona** - Parse YAML config and initialize persona context
2. **Start Session** - Launch browser with video recording via puppet
3. **Navigate to URL** - Go to the starting URL
4. **For Each Goal**:
   a. Inject speech bubble overlay into page
   b. Analyze page - Extract all interactive elements
   c. Send context to LLM (persona + JTBD + goal + page elements)
   d. LLM returns: thought process + next action
   e. Display thought in speech bubble near target element
   f. Execute action via puppet (click, type, scroll, etc.)
   g. Wait for page to settle
   h. Repeat until goal achieved, failed, or timeout
   i. Save video
5. **Generate Report** - Summary of goal outcomes

### Speech Bubble

The speech bubble is a visual overlay injected into the page that:

- Follows the cursor as it moves to elements
- Displays the persona's "inner monologue"
- Shows what they're thinking about each element
- Animates naturally to feel like a real person exploring

Example thoughts:
- "This looks like the search bar... let me try searching for laptops"
- "Hmm, $1,299 is over my budget. Let me look for something cheaper"
- "Add to Cart button - this is what I need to click"

## Output

### Session Directory Structure

```
sessions/
└── first-time-buyer/
    ├── goal-1-find-laptop.mp4
    ├── goal-2-add-to-cart.mp4
    ├── goal-3-abandon-checkout.mp4
    ├── session.json           # Metadata and outcomes
    └── transcript.md          # Full thought transcript
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
      "video": "goal-1-find-laptop.mp4",
      "actions": 12
    },
    {
      "description": "Add the laptop to cart and proceed to checkout",
      "status": "completed",
      "duration": 23000,
      "video": "goal-2-add-to-cart.mp4",
      "actions": 5
    },
    {
      "description": "Abandon checkout to test the recovery email flow",
      "status": "failed",
      "duration": 120000,
      "video": "goal-3-abandon-checkout.mp4",
      "actions": 8,
      "failureReason": "Could not locate checkout abandonment trigger"
    }
  ]
}
```

## CLI Commands

```bash
# Run a persona simulation
npx abra run <persona-file>

# Run with specific goals only
npx abra run personas/buyer.yaml --goals 1,3

# Run in headless mode (no browser window)
npx abra run personas/buyer.yaml --headless

# Validate a persona file without running
npx abra validate personas/buyer.yaml

# List recent sessions
npx abra sessions

# Replay a session (re-watch video)
npx abra replay sessions/first-time-buyer/goal-1-find-laptop.mp4
```

## Requirements

- Node.js 18+
- [puppet](../puppet) - Browser automation with human-like cursor movements
- Claude CLI (`claude`) - Authenticated and available in PATH

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run with debug output
DEBUG=abra:* npx abra run personas/example.yaml
```

## License

MIT
