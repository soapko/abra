/**
 * Auth capture command — opens a browser for user login, saves storageState.
 *
 * Usage: abra auth <name>
 */

import { writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import chalk from 'chalk';
import createDebug from 'debug';
import { ensureAuthDir, resolveStorageStatePath } from '../lib/auth.js';

const debug = createDebug('abra:auth');

/**
 * Wait for the user to press ENTER in the terminal.
 */
function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Run the auth capture flow:
 * 1. Launch a visible browser via puppet's getBrowser()
 * 2. User logs in manually
 * 3. Save context.storageState() to ~/.abra/auth/<name>.json
 */
export async function runAuthCapture(name: string, options: { url?: string } = {}): Promise<string> {
  // Import puppet dynamically (peer dependency)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let puppetModule: any;
  try {
    puppetModule = await import('puppet');
  } catch {
    throw new Error(
      'puppet package not found. Install it with: npm install puppet'
    );
  }

  await ensureAuthDir();

  const filePath = resolveStorageStatePath(name);
  const startUrl = options.url || 'about:blank';

  console.log(chalk.cyan('Opening browser for auth capture...'));
  console.log(chalk.dim(`Navigate to the site and log in.`));
  console.log(chalk.dim(`When done, come back here and press ENTER.\n`));

  // Use puppet's getBrowser() for raw Playwright access
  const { browser, context, page } = await puppetModule.getBrowser({
    headless: false,
    viewport: { width: 1440, height: 900 },
  });

  try {
    // Navigate to starting URL
    await page.goto(startUrl);
    debug('Browser opened at %s', startUrl);

    // Wait for user to finish logging in
    await waitForEnter(chalk.bold('Press ENTER when you have finished logging in... '));

    // Save storage state
    const state = await context.storageState();
    await writeFile(filePath, JSON.stringify(state, null, 2));
    debug('Storage state saved to %s', filePath);

    console.log(chalk.green(`\nAuth state saved to: ${filePath}`));
    return filePath;
  } finally {
    await browser.close();
  }
}
