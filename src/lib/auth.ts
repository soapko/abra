/**
 * Auth utilities — resolve storageState paths, validate auth files,
 * and create authenticated browser sessions.
 */

import { homedir } from 'os';
import { join, isAbsolute } from 'path';
import { readFile, stat, mkdir } from 'fs/promises';
import createDebug from 'debug';
import type { AuthConfig } from './persona.js';

const debug = createDebug('abra:auth');

/** Directory where named auth state files are stored */
export const AUTH_DIR = join(homedir(), '.abra', 'auth');

/** Warn if storageState file is older than this (24 hours) */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Ensure the auth directory exists.
 */
export async function ensureAuthDir(): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
}

/**
 * Resolve a storageState value to an absolute file path.
 *
 * - If it looks like a path (contains / or .json), treat as-is (resolve relative to cwd)
 * - Otherwise treat as a name referencing ~/.abra/auth/<name>.json
 */
export function resolveStorageStatePath(value: string): string {
  if (isAbsolute(value)) return value;
  if (value.includes('/') || value.includes('\\') || value.endsWith('.json')) {
    return join(process.cwd(), value);
  }
  return join(AUTH_DIR, `${value}.json`);
}

/**
 * Validate that a storageState file exists and is readable.
 * Returns warnings (e.g. stale file) but throws on hard errors.
 */
export async function validateStorageState(filePath: string): Promise<string[]> {
  const warnings: string[] = [];

  // Check file exists
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new Error(
      `Auth state file not found: ${filePath}\n` +
      `Run \`abra auth <name>\` to capture auth state.`
    );
  }

  // Check it's valid JSON with expected shape
  try {
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    if (!data.cookies || !Array.isArray(data.cookies)) {
      throw new Error('Missing or invalid "cookies" array');
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Auth state file is not valid JSON: ${filePath}`);
    }
    throw err;
  }

  // Warn if stale
  const age = Date.now() - fileStat.mtimeMs;
  if (age > STALE_THRESHOLD_MS) {
    const hours = Math.round(age / (60 * 60 * 1000));
    warnings.push(
      `Auth state is ${hours}h old and may be expired. Run \`abra auth <name>\` to refresh.`
    );
  }

  return warnings;
}

/**
 * Load a storageState JSON file and return its parsed contents.
 */
export async function loadStorageState(filePath: string): Promise<{
  cookies: Array<Record<string, unknown>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Resolve and validate auth config from a persona.
 * Returns null if no auth is configured.
 */
export async function resolveAuth(auth: AuthConfig): Promise<{
  mode: 'storageState';
  filePath: string;
  warnings: string[];
} | {
  mode: 'cdp';
  cdpUrl: string;
  warnings: string[];
} | null> {
  if (!auth) return null;

  if (auth.cdpUrl) {
    debug('Auth mode: CDP (%s)', auth.cdpUrl);
    return { mode: 'cdp', cdpUrl: auth.cdpUrl, warnings: [] };
  }

  if (auth.storageState) {
    const filePath = resolveStorageStatePath(auth.storageState);
    debug('Auth mode: storageState (%s -> %s)', auth.storageState, filePath);
    const warnings = await validateStorageState(filePath);
    return { mode: 'storageState', filePath, warnings };
  }

  return null;
}
