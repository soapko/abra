/**
 * Domain knowledge store — persistent storage for learned transition records.
 *
 * Stores observed state deltas per action per domain. On repeat visits,
 * these deltas serve as assertions for faster, more confident execution.
 *
 * Storage: append-only JSONL files per session, merged on read.
 * Location: ~/.abra/domains/ (global, shared across projects).
 */

import { mkdir, readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import createDebug from 'debug';
import type { ElementSignature, StateDelta } from './state-observer.js';
import type { ActionType } from './llm.js';

const debug = createDebug('abra:knowledge');

export interface ActionSignature {
  type: ActionType;
  signature: ElementSignature;
  text?: string;
  key?: string;
}

export interface TransitionRecord {
  domain: string;
  pagePath: string;
  action: ActionSignature;
  expectedOutcome: StateDelta;
  lastConfirmed: string;
  confirmCount: number;
  failCount: number;
}

/**
 * Generate a deterministic key for a transition record.
 */
function transitionKey(record: TransitionRecord): string {
  const sig = record.action.signature;
  return [
    record.domain,
    record.pagePath,
    record.action.type,
    sig.tagName,
    sig.testId || '',
    sig.ariaLabel || '',
    sig.textContent?.slice(0, 30) || '',
  ].join('|');
}

export class DomainKnowledgeStore {
  private dataDir: string;
  private transitions: Map<string, TransitionRecord> = new Map();
  private loadedDomains: Set<string> = new Set();
  private sessionId: string;
  private pendingWrites: Map<string, TransitionRecord[]> = new Map();

  constructor(dataDir?: string, sessionId?: string) {
    this.dataDir = dataDir || join(homedir(), '.abra', 'domains');
    this.sessionId = sessionId || `session-${Date.now()}`;
  }

  private async ensureDir(domain: string): Promise<void> {
    await mkdir(join(this.dataDir, domain), { recursive: true });
  }

  /**
   * Load all transition records for a domain from disk.
   * Merges all session log files — last-write-wins per transition key.
   */
  async load(domain: string): Promise<void> {
    if (this.loadedDomains.has(domain)) return;

    try {
      const domainDir = join(this.dataDir, domain);
      const files = await readdir(domainDir).catch(() => []);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const content = await readFile(join(domainDir, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as TransitionRecord;
            const key = transitionKey(record);
            const existing = this.transitions.get(key);
            // Last-write-wins: keep the one with the more recent lastConfirmed
            if (!existing || record.lastConfirmed > existing.lastConfirmed) {
              this.transitions.set(key, record);
            }
          } catch {
            debug('Skipping malformed record in %s/%s', domain, file);
          }
        }
      }

      this.loadedDomains.add(domain);
      debug('Loaded %d transitions for %s', this.countForDomain(domain), domain);
    } catch {
      debug('No existing knowledge for domain: %s', domain);
      this.loadedDomains.add(domain);
    }
  }

  /**
   * Find a matching transition for the given action on this domain/path.
   */
  findTransition(
    domain: string,
    pagePath: string,
    action: ActionSignature
  ): TransitionRecord | null {
    const sig = action.signature;
    const key = [
      domain,
      pagePath,
      action.type,
      sig.tagName,
      sig.testId || '',
      sig.ariaLabel || '',
      sig.textContent?.slice(0, 30) || '',
    ].join('|');
    return this.transitions.get(key) || null;
  }

  /**
   * Record a newly observed transition.
   */
  recordTransition(record: TransitionRecord): void {
    const key = transitionKey(record);
    this.transitions.set(key, record);
    this.queueWrite(record.domain, record);
  }

  /**
   * Update a transition when its assertion failed — patch with the new delta.
   */
  updateTransition(existing: TransitionRecord, newDelta: StateDelta): void {
    existing.expectedOutcome = newDelta;
    existing.lastConfirmed = new Date().toISOString();
    existing.failCount++;

    const key = transitionKey(existing);
    this.transitions.set(key, existing);
    this.queueWrite(existing.domain, existing);
  }

  /**
   * Confirm a transition — its assertion passed.
   */
  confirmTransition(record: TransitionRecord): void {
    record.lastConfirmed = new Date().toISOString();
    record.confirmCount++;

    const key = transitionKey(record);
    this.transitions.set(key, record);
    this.queueWrite(record.domain, record);
  }

  /**
   * Save pending writes for a domain to its session log file.
   */
  async save(domain: string): Promise<void> {
    const records = this.pendingWrites.get(domain);
    if (!records?.length) return;

    await this.ensureDir(domain);

    const filepath = join(this.dataDir, domain, `${this.sessionId}.jsonl`);
    const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(filepath, lines, { flag: 'a' });

    this.pendingWrites.set(domain, []);
    debug('Saved %d transitions for %s', records.length, domain);
  }

  /**
   * Save all pending writes across all domains.
   */
  async saveAll(): Promise<void> {
    for (const domain of this.pendingWrites.keys()) {
      await this.save(domain);
    }
  }

  private queueWrite(domain: string, record: TransitionRecord): void {
    if (!this.pendingWrites.has(domain)) {
      this.pendingWrites.set(domain, []);
    }
    this.pendingWrites.get(domain)!.push(record);
  }

  private countForDomain(domain: string): number {
    let count = 0;
    for (const key of this.transitions.keys()) {
      if (key.startsWith(domain + '|')) count++;
    }
    return count;
  }
}

/**
 * Check if a StateDelta matches an expected delta (similarity matching).
 *
 * Passes if ALL expected structural changes are present in actual.
 * Extra changes in actual are ignored (additive noise is OK).
 * Missing expected changes trigger failure.
 */
export function assertDeltaMatch(
  expected: StateDelta,
  actual: StateDelta | null
): boolean {
  if (!actual) return false;

  // Check focus change
  if (expected.focusChanged?.gainedFocus) {
    if (!actual.focusChanged?.gainedFocus) return false;
    if (!signatureMatches(expected.focusChanged.gainedFocus, actual.focusChanged.gainedFocus)) {
      return false;
    }
  }

  // Check URL change
  if (expected.urlChanged) {
    if (!actual.urlChanged) return false;
    if (expected.urlChanged.to !== actual.urlChanged.to) return false;
  }

  // Check aria changes (all expected must be present)
  if (expected.ariaChanges?.length) {
    if (!actual.ariaChanges?.length) return false;
    for (const expectedChange of expected.ariaChanges) {
      const found = actual.ariaChanges.some(ac =>
        ac.attribute === expectedChange.attribute &&
        ac.newValue === expectedChange.newValue &&
        signatureMatches(expectedChange.signature, ac.signature)
      );
      if (!found) return false;
    }
  }

  // Check visibility changes
  if (expected.visibilityChanges?.length) {
    if (!actual.visibilityChanges?.length) return false;
    for (const expectedVis of expected.visibilityChanges) {
      const found = actual.visibilityChanges.some(av =>
        av.appeared === expectedVis.appeared &&
        signatureMatches(expectedVis.signature, av.signature)
      );
      if (!found) return false;
    }
  }

  return true;
}

/**
 * Check if two element signatures refer to the same logical element.
 * data-testid is the strongest anchor; falls back to tagName + other fields.
 */
function signatureMatches(a: ElementSignature, b: ElementSignature): boolean {
  // testId is the strongest anchor
  if (a.testId && b.testId) return a.testId === b.testId;

  // Must share tagName
  if (a.tagName !== b.tagName) return false;

  // Conflicting role or ariaLabel → not the same element
  if (a.role && b.role && a.role !== b.role) return false;
  if (a.ariaLabel && b.ariaLabel && a.ariaLabel !== b.ariaLabel) return false;

  // If textContent is available on both, use it as a tiebreaker
  if (a.textContent && b.textContent) {
    return a.textContent === b.textContent;
  }

  // Same tagName, no conflicting fields → assume match
  return true;
}

/**
 * Build an ActionSignature from a page element for knowledge lookup/recording.
 */
export function buildActionSignature(
  actionType: ActionType,
  element: { tag: string; role?: string; ariaLabel?: string; testId?: string; text: string } | null,
  text?: string,
  key?: string
): ActionSignature {
  return {
    type: actionType,
    signature: element ? {
      tagName: element.tag.toUpperCase(),
      role: element.role || undefined,
      ariaLabel: element.ariaLabel || undefined,
      testId: element.testId || undefined,
      textContent: element.text?.slice(0, 50) || undefined,
    } : {
      tagName: 'UNKNOWN',
    },
    text,
    key,
  };
}
