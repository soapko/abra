/**
 * Playbook store — persistent storage for recorded operation sequences.
 *
 * Playbooks are named sequences of concrete browser operations (click, type, press, etc.)
 * recorded from successful sessions. On return visits, the LLM can reference stored playbooks
 * to execute multi-step interactions without individual LLM calls per step.
 *
 * Coordinates are stored as viewport-relative ratios (0.0-1.0) and recomputed at replay time.
 * Selectors are primary targeting; coordinates are fallback.
 *
 * Storage: JSON file per domain at ~/.abra/domains/{domain}/playbooks.json
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import createDebug from 'debug';

const debug = createDebug('abra:playbook');

// ── Types ──

export interface RelativePosition {
  /** x / viewportWidth (0.0 - 1.0) */
  relX: number;
  /** y / viewportHeight (0.0 - 1.0) */
  relY: number;
  /** Viewport width at recording time */
  viewportWidth: number;
  /** Viewport height at recording time */
  viewportHeight: number;
  /** Scroll offset at recording time */
  scrollX: number;
  /** Scroll offset at recording time */
  scrollY: number;
}

export interface PlaybookOperation {
  type: 'click' | 'type' | 'press' | 'scroll' | 'hover' | 'wait';
  /** Primary targeting — CSS selector */
  selector?: string;
  /** Fallback targeting — relative coordinates from recording */
  position?: RelativePosition;
  /** For 'type' */
  text?: string;
  /** For 'press' */
  key?: string;
  /** For 'scroll' */
  direction?: 'up' | 'down';
  /** For 'scroll' */
  amount?: number;
  /** For 'wait' */
  duration?: number;
}

export interface Playbook {
  id: string;
  name: string;
  domain: string;
  pagePath: string;
  operations: PlaybookOperation[];
  recordedViewport: { width: number; height: number };
  successCount: number;
  failCount: number;
  lastUsed: string;
  createdAt: string;
}

interface PlaybookData {
  domain: string;
  playbooks: Playbook[];
}

/** Operation recorded during execution, before being saved to a playbook */
export interface RecordedOperation {
  type: 'click' | 'type' | 'press' | 'scroll' | 'hover' | 'wait';
  selector?: string;
  position?: RelativePosition;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  duration?: number;
  /** Human-readable description of what was clicked/typed */
  description?: string;
}

// ── Coordinate helpers ──

/**
 * Convert absolute pixel coordinates to viewport-relative ratios.
 */
export function toRelative(
  absX: number,
  absY: number,
  viewport: { width: number; height: number },
  scroll: { x: number; y: number } = { x: 0, y: 0 }
): RelativePosition {
  return {
    relX: absX / viewport.width,
    relY: absY / viewport.height,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    scrollX: scroll.x,
    scrollY: scroll.y,
  };
}

/**
 * Recompute absolute pixel coordinates from a stored relative position
 * using the current viewport dimensions.
 */
export function toAbsolute(
  stored: RelativePosition,
  currentViewport: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: Math.round(stored.relX * currentViewport.width),
    y: Math.round(stored.relY * currentViewport.height),
  };
}

// ── PlaybookStore ──

export class PlaybookStore {
  private dataDir: string;
  private data: Map<string, PlaybookData> = new Map();
  private loadedDomains: Set<string> = new Set();

  constructor(dataDir?: string) {
    this.dataDir = dataDir || join(homedir(), '.abra', 'domains');
  }

  private async ensureDir(domain: string): Promise<void> {
    await mkdir(join(this.dataDir, domain), { recursive: true });
  }

  private filepath(domain: string): string {
    return join(this.dataDir, domain, 'playbooks.json');
  }

  /**
   * Load playbooks for a domain from disk.
   */
  async load(domain: string): Promise<void> {
    if (this.loadedDomains.has(domain)) return;

    try {
      const content = await readFile(this.filepath(domain), 'utf-8');
      const data = JSON.parse(content) as PlaybookData;
      this.data.set(domain, data);
      debug('Loaded %d playbooks for %s', data.playbooks.length, domain);
    } catch {
      debug('No existing playbooks for domain: %s', domain);
      this.data.set(domain, { domain, playbooks: [] });
    }

    this.loadedDomains.add(domain);
  }

  /**
   * Save playbooks for a domain to disk (atomic write).
   */
  async save(domain: string): Promise<void> {
    const data = this.data.get(domain);
    if (!data) return;

    await this.ensureDir(domain);
    const json = JSON.stringify(data, null, 2);
    await writeFile(this.filepath(domain), json, 'utf-8');
    debug('Saved %d playbooks for %s', data.playbooks.length, domain);
  }

  /**
   * Record a new playbook from a sequence of successful operations.
   */
  record(
    domain: string,
    pagePath: string,
    name: string,
    operations: RecordedOperation[],
    viewport: { width: number; height: number }
  ): Playbook {
    if (!this.data.has(domain)) {
      this.data.set(domain, { domain, playbooks: [] });
    }

    const playbookOps: PlaybookOperation[] = operations.map(op => ({
      type: op.type,
      selector: op.selector,
      position: op.position,
      text: op.text,
      key: op.key,
      direction: op.direction,
      amount: op.amount,
      duration: op.duration,
    }));

    const id = this.generateId(operations);
    const now = new Date().toISOString();

    const playbook: Playbook = {
      id,
      name,
      domain,
      pagePath,
      operations: playbookOps,
      recordedViewport: viewport,
      successCount: 1,
      failCount: 0,
      lastUsed: now,
      createdAt: now,
    };

    this.data.get(domain)!.playbooks.push(playbook);
    debug('Recorded playbook "%s" with %d operations for %s', name, operations.length, domain);

    return playbook;
  }

  /**
   * Find a playbook by name (case-insensitive partial match).
   */
  find(domain: string, name: string): Playbook | null {
    const data = this.data.get(domain);
    if (!data) return null;

    const lower = name.toLowerCase();

    // Exact match first
    const exact = data.playbooks.find(p => p.name.toLowerCase() === lower);
    if (exact) return exact;

    // Partial match
    const partial = data.playbooks.find(p => p.name.toLowerCase().includes(lower));
    return partial || null;
  }

  /**
   * Get all playbooks for a domain.
   */
  getPlaybooks(domain: string): Playbook[] {
    return this.data.get(domain)?.playbooks || [];
  }

  /**
   * Increment success count for a playbook.
   */
  markSuccess(playbook: Playbook): void {
    playbook.successCount++;
    playbook.lastUsed = new Date().toISOString();
  }

  /**
   * Increment failure count for a playbook.
   */
  markFailure(playbook: Playbook): void {
    playbook.failCount++;
    playbook.lastUsed = new Date().toISOString();
  }

  /**
   * Generate a human-readable summary of available playbooks for LLM injection.
   */
  getSummary(domain: string): string {
    const playbooks = this.getPlaybooks(domain);
    if (playbooks.length === 0) return '';

    const lines: string[] = [
      'STORED PLAYBOOKS (from previous visits):',
      'Reference a playbook by name to replay the stored sequence.',
      '',
    ];

    for (const p of playbooks) {
      const reliability = p.successCount + p.failCount > 0
        ? Math.round((p.successCount / (p.successCount + p.failCount)) * 100)
        : 100;

      const opsDesc = p.operations.map(op => {
        switch (op.type) {
          case 'click': return `click "${op.selector || 'element'}"`;
          case 'type': return `type "${op.text}"`;
          case 'press': return `press ${op.key}`;
          case 'scroll': return `scroll ${op.direction}`;
          case 'wait': return `wait ${op.duration}ms`;
          case 'hover': return `hover "${op.selector || 'element'}"`;
          default: return op.type;
        }
      }).join(' → ');

      lines.push(`- "${p.name}" (${p.operations.length} steps, ${reliability}% reliable): ${opsDesc}`);
    }

    lines.push('');
    lines.push('To use a playbook, include it in your operations: {"playbook": "playbook name"}');
    lines.push('You can mix playbook references with inline operations in the same batch.');

    return lines.join('\n');
  }

  /**
   * Expand a playbook reference into concrete operations.
   * Returns the operations with coordinates recomputed for the current viewport.
   */
  expand(
    domain: string,
    playbookName: string,
    currentViewport: { width: number; height: number }
  ): { operations: PlaybookOperation[]; playbook: Playbook } | null {
    const playbook = this.find(domain, playbookName);
    if (!playbook) return null;

    // Recompute coordinates for current viewport
    const operations = playbook.operations.map(op => {
      if (!op.position) return op;
      const abs = toAbsolute(op.position, currentViewport);
      return {
        ...op,
        position: {
          ...op.position,
          // Store the recomputed absolute position for execution
          relX: abs.x / currentViewport.width,
          relY: abs.y / currentViewport.height,
          viewportWidth: currentViewport.width,
          viewportHeight: currentViewport.height,
          scrollX: op.position.scrollX,
          scrollY: op.position.scrollY,
        },
      };
    });

    return { operations, playbook };
  }

  /**
   * Post-session stitching: analyze an action log and create playbooks
   * from consecutive operations that form causal chains.
   *
   * A causal chain is detected when action N's target is a container element
   * and action N+1 interacts with an element inside that container
   * (or when two actions target elements in close proximity).
   *
   * For V1, we use a simpler heuristic: group consecutive operations
   * that are all on the same page path into sequences of 2+.
   */
  stitchFromLog(
    domain: string,
    pagePath: string,
    log: RecordedOperation[],
    viewport: { width: number; height: number }
  ): Playbook[] {
    if (log.length < 2) return [];

    const created: Playbook[] = [];

    // Group consecutive operations into candidate playbooks
    // Split on: different page paths would happen via URL change bail,
    // so the log is already scoped to one page path.
    // We group into sequences of 2-6 operations.
    const maxGroupSize = 6;

    for (let start = 0; start < log.length; start++) {
      // Find the longest group starting at this index
      const end = Math.min(start + maxGroupSize, log.length);
      const group = log.slice(start, end);

      if (group.length < 2) continue;

      // Generate a name from the operations
      const name = this.autoName(group);

      // Check if we already have a playbook with a similar name
      const existing = this.find(domain, name);
      if (existing) {
        this.markSuccess(existing);
        continue;
      }

      const playbook = this.record(domain, pagePath, name, group, viewport);
      created.push(playbook);

      // Skip ahead past this group
      start = end - 1;
    }

    debug('Stitched %d playbooks from %d operations', created.length, log.length);
    return created;
  }

  /**
   * Auto-generate a playbook name from its operations.
   */
  autoName(operations: RecordedOperation[]): string {
    const parts = operations
      .filter(op => op.type !== 'wait')
      .map(op => {
        if (op.description) return op.description;
        switch (op.type) {
          case 'click': return `click ${op.selector?.slice(0, 30) || 'element'}`;
          case 'type': return `type "${op.text?.slice(0, 20) || ''}"`;
          case 'press': return `press ${op.key || 'key'}`;
          case 'scroll': return `scroll ${op.direction || 'down'}`;
          case 'hover': return `hover ${op.selector?.slice(0, 30) || 'element'}`;
          default: return op.type;
        }
      })
      .slice(0, 3);

    return parts.join(' → ');
  }

  /**
   * Generate a deterministic ID from operations.
   */
  private generateId(operations: RecordedOperation[]): string {
    const content = operations.map(op =>
      `${op.type}:${op.selector || ''}:${op.text || ''}:${op.key || ''}`
    ).join('|');
    return createHash('sha256').update(content).digest('hex').slice(0, 12);
  }
}
