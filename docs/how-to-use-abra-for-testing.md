# How to Use Abra for Testing

This guide covers how to integrate Abra into your testing workflow alongside traditional automation tools like Puppet/Playwright.

## When to Use Abra vs Traditional Tests

| Use Case | Tool | Why |
|----------|------|-----|
| Regression testing | Puppet | Deterministic, fast, CI/CD friendly |
| Smoke testing | Abra | Validates user goals without explicit scripts |
| Exploratory testing | Abra | Discovers unexpected issues |
| UX validation | Abra | Simulates real user thinking |
| Performance benchmarks | Puppet | Consistent timing |
| Onboarding flows | Abra | Tests if new users can complete journeys |

## Getting Started

### 1. Create a Test Persona

Create a YAML file describing your test user:

```yaml
# personas/checkout-tester.yaml
persona:
  name: Test Shopper
  background: |
    A first-time visitor testing the checkout flow.
    Moderately tech-savvy, expects standard e-commerce patterns.

  jobs_to_be_done:
    - Complete purchases without confusion
    - Find products quickly
    - Trust the site with payment info

url: https://your-staging-site.com

goals:
  - Add a product to the cart
  - Complete the checkout process up to payment
  - Verify order confirmation appears

options:
  timeout: 180000  # 3 minutes per goal
  thinkingSpeed: fast
```

### 2. Run the Test

```bash
# Run all goals
node dist/cli.js run personas/checkout-tester.yaml

# Run specific goals only
node dist/cli.js run personas/checkout-tester.yaml --goals 1,2

# Use sight mode for complex UIs
node dist/cli.js run personas/checkout-tester.yaml --sight-mode

# Headless mode for CI environments
node dist/cli.js run personas/checkout-tester.yaml --headless
```

### 3. Review Results

After each run, check:

```
sessions/<persona-name>-<timestamp>/
├── videos/
│   └── *.webm              # Screen recordings
├── goal-1-*-transcript.md  # Thought process log
├── goal-2-*-transcript.md
└── session.json            # Structured results
```

## Interpreting Results

### Session JSON Structure

```json
{
  "persona": "Test Shopper",
  "goals": [
    {
      "description": "Add a product to the cart",
      "status": "completed",  // or "failed"
      "duration": 45000,
      "actions": 5,
      "failureReason": null   // explains failures
    }
  ]
}
```

### Reading Transcripts

Transcripts show the persona's thinking:

```markdown
[timestamp] Thought: I see a product grid. Let me click on the first item to view details.
[timestamp] Action: Clicked element 12 (product-card)
[timestamp] Thought: Good, I'm on the product page. I need to add this to my cart.
[timestamp] Action: Clicked element 8 (add-to-cart-button)
```

Use transcripts to understand:
- Where the persona got confused
- Which elements were hard to find
- Whether the UI matched user expectations

## Testing Patterns

### Pattern 1: Goal Validation

Test if users can achieve key goals without instructions:

```yaml
goals:
  - Sign up for a new account
  - Find the pricing page
  - Contact support
```

If Abra fails, real users might too.

### Pattern 2: Regression Detection

Run the same persona multiple times. Consistent failures indicate real issues:

```bash
# Run 3 times
for i in 1 2 3; do
  node dist/cli.js run personas/checkout-tester.yaml --goals 1
done

# Check all sessions for failures
grep -r '"status": "failed"' sessions/test-shopper-*/session.json
```

### Pattern 3: Multi-Persona Testing

Create personas with different backgrounds:

```yaml
# personas/tech-savvy-user.yaml
persona:
  name: Dev Dana
  background: Software developer, power user, uses keyboard shortcuts

# personas/non-tech-user.yaml
persona:
  name: Casual Carl
  background: Retired teacher, prefers obvious buttons, avoids complex menus
```

Run both against the same goals to find accessibility gaps.

### Pattern 4: Document Findings

Use Abra's document action to have personas record what they find:

```yaml
goals:
  - Explore the homepage and document all navigation options in notes.md
  - Find the help section and note any confusing elements
```

Documents are saved to `sessions/<session>/docs/`.

## CI/CD Integration

### Scheduled Runs (Recommended)

Add to your nightly build:

```yaml
# .github/workflows/nightly-ux.yml
name: Nightly UX Tests
on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM daily

jobs:
  ux-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Abra tests
        run: |
          node dist/cli.js run personas/smoke-test.yaml --headless

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: ux-test-results
          path: sessions/
```

### Failure Alerting

Check exit codes and session status:

```bash
#!/bin/bash
node dist/cli.js run personas/critical-flow.yaml --headless

# Check for failures
if grep -q '"status": "failed"' sessions/*/session.json; then
  echo "UX test failures detected!"
  exit 1
fi
```

## Cost and Performance

| Metric | Value |
|--------|-------|
| LLM calls per action | 1 |
| Simple goal (2-3 actions) | ~$0.015, ~55 seconds |
| Complex goal (10-20 actions) | ~$0.05-0.10, ~3-5 minutes |
| Parallelization | Limited by LLM rate limits |

### Optimizing Costs

1. **Use specific goals** - Vague goals require more exploration
2. **Set appropriate timeouts** - Prevent runaway sessions
3. **Use `thinkingSpeed: fast`** - Reduces pauses between actions
4. **Run headless** - Slightly faster without rendering overhead

## Troubleshooting

### "Goal failed" but UI looks fine

- Check the transcript for the persona's reasoning
- The element might be in shadow DOM (use `--sight-mode`)
- Selectors might not be unique (Abra logs will show this)

### Inconsistent results

- Run the same test 3+ times
- If it passes 2/3 times, it's likely a timing issue
- If it fails consistently, there's a real UX problem

### Slow execution

- LLM latency is the main factor (~5-10s per decision)
- Use `thinkingSpeed: fast` to reduce artificial pauses
- Consider running fewer goals per session

## Best Practices

1. **Keep goals atomic** - One clear objective per goal
2. **Use realistic personas** - Match your actual user demographics
3. **Review videos** - Transcripts don't capture visual issues
4. **Combine with Puppet** - Use Abra for discovery, Puppet for regression
5. **Run multiple times** - Single runs don't prove reliability
6. **Version your personas** - Track changes to test definitions
