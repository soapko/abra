#!/usr/bin/env node

/**
 * Abra CLI - Automated user-testing platform
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdir, stat, readFile } from 'fs/promises';
import { loadPersona, validatePersona } from './lib/persona.js';
import { runSession } from './lib/session.js';
import { resolveAuth } from './lib/auth.js';
import { runAuthCapture } from './commands/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isTTY = !!(process.stderr.isTTY);

/**
 * Wrap a raw Playwright Page to match the Browser interface expected by session.ts.
 * Used for storageState and CDP auth modes where puppet's fluent API isn't available.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapPlaywrightPage(page: any) {
  return {
    click: (selector: string) => page.click(selector),
    type: (selector: string, text: string) => page.fill(selector, text),
    hover: (selector: string) => page.hover(selector),
    drag: async (source: string, target: string) => {
      await page.dragAndDrop(source, target);
    },
    dragCoordinates: async (sourceX: number, sourceY: number, targetX: number, targetY: number) => {
      await page.mouse.move(sourceX, sourceY);
      await page.mouse.down();
      await page.mouse.move(targetX, targetY);
      await page.mouse.up();
    },
    scroll: async (direction: 'up' | 'down', amount?: number) => {
      const delta = (amount || 300) * (direction === 'up' ? -1 : 1);
      await page.mouse.wheel(0, delta);
    },
    wait: (ms: number) => page.waitForTimeout(ms),
    waitForLoaded: async (timeout?: number) => {
      try {
        await page.waitForLoadState('networkidle', { timeout: timeout || 5000 });
      } catch { /* timeout is ok */ }
    },
    evaluate: (script: string) => page.evaluate(script),
    screenshot: async () => await page.screenshot({ type: 'png' }),
    press: async (key: string) => {
      await page.keyboard.press(key);
    },
    mouse: {
      click: async (x: number, y: number) => {
        await page.mouse.click(x, y);
      },
    },
  };
}

/**
 * Create a spinner that falls back to plain console.log in non-TTY environments.
 * ora v8 disables animation but still prints static lines in non-TTY — use
 * isSilent to fully suppress, then handle output ourselves.
 */
function createSpinner(text: string): Ora {
  if (!isTTY) {
    console.log(text);
    return ora({ text, isSilent: true });
  }
  return ora(text).start();
}

/** Log a spinner success — always prints, even in non-TTY */
function spinnerSucceed(spinner: Ora, text: string): void {
  if (isTTY) {
    spinner.succeed(text);
  } else {
    spinner.stop();
    console.log(`✓ ${text}`);
  }
}

/** Log a spinner failure — always prints, even in non-TTY */
function spinnerFail(spinner: Ora, text: string): void {
  if (isTTY) {
    spinner.fail(text);
  } else {
    spinner.stop();
    console.error(`✗ ${text}`);
  }
}

/** Log a spinner info — always prints, even in non-TTY */
function spinnerInfo(spinner: Ora, text: string): void {
  if (isTTY) {
    spinner.info(text);
  } else {
    spinner.stop();
    console.log(`ℹ ${text}`);
  }
}

const program = new Command();

program
  .name('abra')
  .description('Automated user-testing platform that simulates personas interacting with websites')
  .version('0.1.0');

/**
 * Run command - execute a persona simulation
 */
program
  .command('run <persona-file>')
  .description('Run a persona simulation')
  .option('-o, --output <dir>', 'Output directory for session files', './sessions')
  .option('--headless', 'Run browser in headless mode')
  .option('--sight-mode', 'Use screenshots for decision-making instead of HTML analysis')
  .option('--observe', 'Enable observer agent for concurrent page documentation')
  .option('--goals <indices>', 'Run only specific goals (comma-separated, 1-indexed)')
  .option('--no-playbooks', 'Disable playbook recording and replay')
  .action(async (personaFile: string, options: { output: string; headless?: boolean; sightMode?: boolean; observe?: boolean; goals?: string; playbooks?: boolean }) => {
    const spinner = createSpinner('Loading persona configuration...');

    try {
      // Load persona
      const personaPath = resolve(personaFile);
      const persona = await loadPersona(personaPath);
      spinnerSucceed(spinner, `Loaded persona: ${chalk.cyan(persona.persona.name)}`);

      // Filter goals if specified
      if (options.goals) {
        const indices = options.goals.split(',').map(s => parseInt(s.trim(), 10) - 1);
        persona.goals = persona.goals.filter((_, i) => indices.includes(i));
        console.log(chalk.dim(`Running ${persona.goals.length} selected goal(s)`));
      }

      console.log(chalk.dim('Starting URL:'), persona.url);
      console.log(chalk.dim('Goals:'));
      persona.goals.forEach((goal, i) => {
        console.log(chalk.dim(`  ${i + 1}. ${goal}`));
      });
      console.log();

      // Import puppet dynamically (peer dependency)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let puppetModule: any;
      try {
        puppetModule = await import('puppet');
      } catch {
        console.error(chalk.red('Error: puppet package not found.'));
        console.error(chalk.dim('Install it with: npm install puppet'));
        process.exit(1);
      }

      // Resolve auth configuration
      const authResult = persona.auth ? await resolveAuth(persona.auth) : null;
      if (authResult) {
        for (const warning of authResult.warnings) {
          console.log(chalk.yellow(`⚠ ${warning}`));
        }
        if (authResult.mode === 'storageState') {
          console.log(chalk.cyan(`Auth: loading storageState from ${authResult.filePath}`));
        } else if (authResult.mode === 'cdp') {
          console.log(chalk.cyan(`Auth: connecting via CDP to ${authResult.cdpUrl}`));
        }
      }

      // Log sight mode if enabled
      if (options.sightMode) {
        console.log(chalk.cyan('Sight mode enabled - using screenshots for decision-making'));
      }

      // Log observer mode if enabled
      if (options.observe) {
        console.log(chalk.cyan('Observer mode enabled - concurrent page documentation'));
      }

      // Run session
      const sessionSpinner = createSpinner('Running simulation...');

      const result = await runSession(
        async (browserOptions) => {
          // --- CDP mode: connect to existing Chrome instance ---
          if (authResult?.mode === 'cdp') {
            const { chromium } = await import('playwright');
            const cdpBrowser = await chromium.connectOverCDP(authResult.cdpUrl);
            const contexts = cdpBrowser.contexts();
            const context = contexts[0] || await cdpBrowser.newContext();
            const pages = context.pages();
            const page = pages[0] || await context.newPage();

            return {
              browser: wrapPlaywrightPage(page),
              goto: (url: string) => page.goto(url).then(() => {}),
              close: () => cdpBrowser.close(),
              getVideoPath: () => Promise.resolve(null),
            };
          }

          // --- storageState mode: use puppet's launchBrowser + manual context ---
          if (authResult?.mode === 'storageState') {
            const rawBrowser = await puppetModule.launchBrowser({
              headless: browserOptions.headless,
            });
            const contextOptions: Record<string, unknown> = {
              storageState: authResult.filePath,
              viewport: { width: 1440, height: 900 },
              userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              locale: 'en-US',
              colorScheme: 'light',
            };
            if (browserOptions.video) {
              contextOptions.recordVideo = {
                dir: browserOptions.video.dir,
                size: { width: 1440, height: 900 },
              };
            }
            const context = await rawBrowser.newContext(contextOptions);
            const page = await context.newPage();

            return {
              browser: wrapPlaywrightPage(page),
              goto: (url: string) => page.goto(url).then(() => {}),
              close: async () => {
                await context.close();
                await rawBrowser.close();
              },
              getVideoPath: async () => {
                try {
                  const video = page.video();
                  if (video) {
                    const path = await video.path();
                    return { path };
                  }
                } catch { /* no video */ }
                return null;
              },
            };
          }

          // --- Default mode: use puppet's fluent API ---
          const browser = await puppetModule.puppet({
            headless: browserOptions.headless,
            video: browserOptions.video,
            showCursor: true,
          });

          return {
            browser: {
              click: (s: string) => browser.click(s),
              type: (s: string, t: string) => browser.type(s, t),
              hover: (s: string) => browser.hover(s),
              drag: (source: string, target: string) => browser.drag(source, target),
              dragCoordinates: (sourceX: number, sourceY: number, targetX: number, targetY: number) =>
                browser.dragCoordinates(sourceX, sourceY, targetX, targetY),
              scroll: (d: 'up' | 'down', a?: number) => browser.scroll(d, a),
              wait: (ms: number) => browser.wait(ms),
              waitForLoaded: (timeout?: number) => browser.waitForLoaded(timeout),
              evaluate: (script: string) => browser.evaluate(script),
              screenshot: () => browser.screenshot(),
              // Press a key (uses Playwright keyboard API if available)
              press: async (key: string) => {
                // Try native press first, fallback to evaluate
                if (browser.press) {
                  await browser.press(key);
                } else {
                  await browser.evaluate(`
                    (function() {
                      const el = document.activeElement;
                      if (el) {
                        el.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true, cancelable: true }));
                        el.dispatchEvent(new KeyboardEvent('keypress', { key: '${key}', bubbles: true, cancelable: true }));
                        el.dispatchEvent(new KeyboardEvent('keyup', { key: '${key}', bubbles: true, cancelable: true }));
                        // For Enter, also try form submission
                        if ('${key}' === 'Enter' && el.form) {
                          el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                        }
                      }
                    })()
                  `);
                }
              },
              // Navigation
              goto: (url: string) => browser.goto(url),
              // Tab management
              newTab: (url?: string) => browser.newTab(url),
              switchTab: (tabId: string) => browser.switchTab(tabId),
              closeTab: (tabId?: string) => browser.closeTab(tabId),
              listTabs: () => browser.listTabs(),
              // Mouse for coordinate-based clicking (fallback when selectors fail)
              mouse: {
                click: async (x: number, y: number) => {
                  // Move visual cursor to click position (so it shows in video)
                  await browser.evaluate(`
                    (function() {
                      if (typeof window.__puppetMoveCursor__ === 'function') {
                        window.__puppetMoveCursor__(${x}, ${y});
                      }
                      if (typeof window.__puppetClickEffect__ === 'function') {
                        window.__puppetClickEffect__(${x}, ${y});
                      }
                    })()
                  `);

                  // Use native pointer events with shadow DOM piercing
                  const result = await browser.evaluate(`
                    (function() {
                      const x = ${x}, y = ${y};

                      // Recursively find element at coordinates, piercing shadow DOM
                      function deepElementFromPoint(x, y) {
                        let el = document.elementFromPoint(x, y);
                        if (!el) return null;

                        // Keep piercing shadow roots until we find the deepest element
                        let attempts = 0;
                        while (el.shadowRoot && attempts < 10) {
                          const inner = el.shadowRoot.elementFromPoint(x, y);
                          if (!inner || inner === el) break;
                          el = inner;
                          attempts++;
                        }
                        return el;
                      }

                      // Find the deepest element (piercing shadow DOM)
                      const el = deepElementFromPoint(x, y);
                      if (!el) return { success: false, reason: 'no element' };

                      // For links, get the href and navigate directly
                      const link = el.closest('a[href]');
                      if (link && link.href && !link.href.startsWith('javascript:')) {
                        // Navigate directly to the link target
                        window.location.href = link.href;
                        return { success: true, navigated: link.href };
                      }

                      // For buttons and other clickable elements, try multiple approaches
                      const target = el;

                      // Dispatch pointer/mouse events
                      const eventInit = {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        clientX: x,
                        clientY: y,
                        screenX: x,
                        screenY: y,
                        button: 0,
                        buttons: 1
                      };

                      // Focus the element first
                      if (typeof target.focus === 'function') {
                        target.focus();
                      }

                      // Fire complete event sequence
                      target.dispatchEvent(new PointerEvent('pointerdown', eventInit));
                      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
                      target.dispatchEvent(new PointerEvent('pointerup', eventInit));
                      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
                      target.dispatchEvent(new MouseEvent('click', eventInit));

                      // Also try direct click on the element
                      if (typeof target.click === 'function') {
                        target.click();
                      }

                      return { success: true, clicked: target.tagName };
                    })()
                  `);
                  // Log the result for debugging
                  if (result && typeof result === 'object') {
                    console.error('[abra:mouse] Coordinate click result:', JSON.stringify(result));
                  }
                },
              },
            },
            goto: (url: string) => browser.goto(url),
            close: () => browser.close(),
            getVideoPath: () => browser.getVideoPath?.() ?? Promise.resolve(null),
          };
        },
        persona,
        {
          outputDir: resolve(options.output),
          headless: options.headless,
          sightMode: options.sightMode,
          observe: options.observe,
          playbooks: options.playbooks,
          onThought: (thought, goalIndex) => {
            const msg = `Goal ${goalIndex + 1}: ${thought.slice(0, 60)}...`;
            if (isTTY) {
              sessionSpinner.text = msg;
            } else {
              console.log(chalk.dim(`[thought] ${msg}`));
            }
          },
          onAction: (action, goalIndex) => {
            const msg = `Goal ${goalIndex + 1}: ${action}`;
            if (isTTY) {
              sessionSpinner.text = msg;
            } else {
              console.log(chalk.dim(`[action]  ${msg}`));
            }
          },
          onObservation: (observation, goalIndex) => {
            if (isTTY) {
              sessionSpinner.suffixText = chalk.dim(`[observer] ${observation.slice(0, 50)}`);
            } else {
              console.log(chalk.dim(`[observer] Goal ${goalIndex + 1}: ${observation.slice(0, 80)}`));
            }
          },
        }
      );

      spinnerSucceed(sessionSpinner, 'Simulation complete!');
      console.log();

      // Print results
      console.log(chalk.bold('Results:'));
      console.log(chalk.dim('─'.repeat(50)));

      for (const goal of result.goals) {
        const statusIcon = goal.status === 'completed' ? chalk.green('✓')
          : goal.status === 'failed' ? chalk.red('✗')
          : chalk.yellow('⏱');

        console.log(`${statusIcon} ${goal.description}`);
        console.log(chalk.dim(`   Status: ${goal.status} | Actions: ${goal.actions} | Duration: ${(goal.duration / 1000).toFixed(1)}s`));

        if (goal.failureReason) {
          console.log(chalk.red(`   Reason: ${goal.failureReason}`));
        }
        if (goal.video) {
          console.log(chalk.dim(`   Video: ${goal.video}`));
        }
      }

      console.log();
      console.log(chalk.dim(`Session saved to: ${options.output}`));
    } catch (err) {
      spinnerFail(spinner, 'Error');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

/**
 * Validate command - check a persona file without running
 */
program
  .command('validate <persona-file>')
  .description('Validate a persona configuration file')
  .action(async (personaFile: string) => {
    const spinner = createSpinner('Validating persona configuration...');

    try {
      const personaPath = resolve(personaFile);
      const persona = await loadPersona(personaPath);

      spinnerSucceed(spinner, 'Persona configuration is valid');
      console.log();
      console.log(chalk.bold('Persona:'), persona.persona.name);
      console.log(chalk.bold('URL:'), persona.url);
      console.log(chalk.bold('Goals:'), persona.goals.length);
      console.log(chalk.bold('Jobs to be done:'), persona.persona.jobs_to_be_done.length);
      console.log(chalk.bold('Viewport:'), `${persona.options.viewport.width}x${persona.options.viewport.height}`);
      console.log(chalk.bold('Timeout:'), `${persona.options.timeout / 1000}s`);
      console.log(chalk.bold('Thinking speed:'), persona.options.thinkingSpeed);
    } catch (err) {
      spinnerFail(spinner, 'Validation failed');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

/**
 * Sessions command - list past sessions
 */
program
  .command('sessions')
  .description('List past sessions')
  .option('-d, --dir <dir>', 'Sessions directory', './sessions')
  .action(async (options: { dir: string }) => {
    const spinner = createSpinner('Loading sessions...');

    try {
      const sessionsDir = resolve(options.dir);
      let entries: string[];

      try {
        entries = await readdir(sessionsDir);
      } catch {
        spinnerInfo(spinner, 'No sessions found');
        return;
      }

      const sessions: Array<{ name: string; date: Date; goals: number; completed: number }> = [];

      for (const entry of entries) {
        const entryPath = resolve(sessionsDir, entry);
        const entryStat = await stat(entryPath);

        if (!entryStat.isDirectory()) continue;

        try {
          const metadataPath = resolve(entryPath, 'session.json');
          const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));

          sessions.push({
            name: entry,
            date: new Date(metadata.startedAt),
            goals: metadata.goals.length,
            completed: metadata.goals.filter((g: { status: string }) => g.status === 'completed').length,
          });
        } catch {
          // Skip invalid session directories
        }
      }

      spinnerSucceed(spinner, 'Sessions loaded');

      if (sessions.length === 0) {
        console.log(chalk.dim('No sessions found'));
        return;
      }

      // Sort by date descending
      sessions.sort((a, b) => b.date.getTime() - a.date.getTime());

      console.log(chalk.bold('Recent Sessions:'));
      console.log(chalk.dim('─'.repeat(60)));

      for (const session of sessions.slice(0, 10)) {
        const successRate = session.goals > 0
          ? Math.round((session.completed / session.goals) * 100)
          : 0;
        const statusColor = successRate === 100 ? chalk.green
          : successRate > 50 ? chalk.yellow
          : chalk.red;

        console.log(`${chalk.cyan(session.name)}`);
        console.log(chalk.dim(`  ${session.date.toLocaleString()} | Goals: ${statusColor(`${session.completed}/${session.goals}`)} (${successRate}%)`));
      }
    } catch (err) {
      spinnerFail(spinner, 'Error');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

/**
 * Auth command - capture browser auth state for authenticated testing
 */
program
  .command('auth <name>')
  .description('Capture browser auth state (opens browser for manual login)')
  .option('-u, --url <url>', 'URL to navigate to before login')
  .action(async (name: string, options: { url?: string }) => {
    try {
      await runAuthCapture(name, options);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parse();
