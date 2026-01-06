#!/usr/bin/env node

/**
 * Abra CLI - Automated user-testing platform
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdir, stat, readFile } from 'fs/promises';
import { loadPersona, validatePersona } from './lib/persona.js';
import { runSession } from './lib/session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  .option('--goals <indices>', 'Run only specific goals (comma-separated, 1-indexed)')
  .action(async (personaFile: string, options: { output: string; headless?: boolean; sightMode?: boolean; goals?: string }) => {
    const spinner = ora('Loading persona configuration...').start();

    try {
      // Load persona
      const personaPath = resolve(personaFile);
      const persona = await loadPersona(personaPath);
      spinner.succeed(`Loaded persona: ${chalk.cyan(persona.persona.name)}`);

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

      // Log sight mode if enabled
      if (options.sightMode) {
        console.log(chalk.cyan('Sight mode enabled - using screenshots for decision-making'));
      }

      // Run session
      const sessionSpinner = ora('Running simulation...').start();

      const result = await runSession(
        async (browserOptions) => {
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
              scroll: (d: 'up' | 'down', a?: number) => browser.scroll(d, a),
              wait: (ms: number) => browser.wait(ms),
              waitForLoaded: (timeout?: number) => browser.waitForLoaded(timeout),
              evaluate: (script: string) => browser.evaluate(script),
              screenshot: () => browser.screenshot(),
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
          onThought: (thought, goalIndex) => {
            sessionSpinner.text = `Goal ${goalIndex + 1}: ${thought.slice(0, 60)}...`;
          },
          onAction: (action, goalIndex) => {
            sessionSpinner.text = `Goal ${goalIndex + 1}: ${action}`;
          },
        }
      );

      sessionSpinner.succeed('Simulation complete!');
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
      spinner.fail('Error');
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
    const spinner = ora('Validating persona configuration...').start();

    try {
      const personaPath = resolve(personaFile);
      const persona = await loadPersona(personaPath);

      spinner.succeed('Persona configuration is valid');
      console.log();
      console.log(chalk.bold('Persona:'), persona.persona.name);
      console.log(chalk.bold('URL:'), persona.url);
      console.log(chalk.bold('Goals:'), persona.goals.length);
      console.log(chalk.bold('Jobs to be done:'), persona.persona.jobs_to_be_done.length);
      console.log(chalk.bold('Viewport:'), `${persona.options.viewport.width}x${persona.options.viewport.height}`);
      console.log(chalk.bold('Timeout:'), `${persona.options.timeout / 1000}s`);
      console.log(chalk.bold('Thinking speed:'), persona.options.thinkingSpeed);
    } catch (err) {
      spinner.fail('Validation failed');
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
    const spinner = ora('Loading sessions...').start();

    try {
      const sessionsDir = resolve(options.dir);
      let entries: string[];

      try {
        entries = await readdir(sessionsDir);
      } catch {
        spinner.info('No sessions found');
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

      spinner.stop();

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
      spinner.fail('Error');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parse();
