/**
 * Document writer module - handles CRUD operations for session documents
 */

import { mkdir, readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, extname, basename } from 'path';
import createDebug from 'debug';

const debug = createDebug('abra:documents');

// Maximum document size (100KB)
const MAX_DOCUMENT_SIZE = 100 * 1024;

export interface DocumentInfo {
  filename: string;
  format: 'markdown' | 'json' | 'text';
  sizeBytes: number;
  preview: string;
  sections?: string[];
}

export interface DocumentWriteResult {
  success: boolean;
  error?: string;
  path?: string;
}

export interface DocumentReadResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Sanitize filename to prevent path traversal attacks
 */
function sanitizeFilename(filename: string): string {
  // Remove any path components
  let safe = basename(filename);
  // Remove potentially dangerous characters
  safe = safe.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  // Ensure it's not empty
  if (!safe || safe === '.' || safe === '..') {
    safe = 'document';
  }
  return safe;
}

/**
 * Determine document format from extension
 */
function getFormat(filename: string): 'markdown' | 'json' | 'text' {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.json':
      return 'json';
    default:
      return 'text';
  }
}

/**
 * Extract markdown section headings
 */
function extractMarkdownSections(content: string): string[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const sections: string[] = [];
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    sections.push(match[0].trim());
  }
  return sections;
}

/**
 * Update a specific section in markdown content
 */
function updateMarkdownSection(
  content: string,
  sectionHeading: string,
  newContent: string
): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inTargetSection = false;
  let targetLevel = 0;

  // Determine the heading level of the target section
  const targetMatch = sectionHeading.match(/^(#{1,6})\s/);
  if (targetMatch) {
    targetLevel = targetMatch[1].length;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s/);

    if (inTargetSection) {
      // Check if we've hit another heading of same or higher level
      if (headingMatch && headingMatch[1].length <= targetLevel) {
        inTargetSection = false;
        // Add the new content before this heading
        result.push(sectionHeading);
        result.push(newContent);
        result.push('');
        result.push(line);
      }
      // Skip lines in the target section (they're being replaced)
    } else if (line.trim() === sectionHeading.trim()) {
      inTargetSection = true;
      // Don't add the old heading yet - we'll add it with new content
    } else {
      result.push(line);
    }
  }

  // If we ended while still in the target section, add content at the end
  if (inTargetSection) {
    result.push(sectionHeading);
    result.push(newContent);
  }

  return result.join('\n');
}

export class DocumentWriter {
  private docsDir: string;
  private index: Map<string, DocumentInfo>;
  private lastReadContent: string | null = null;

  constructor(sessionDir: string) {
    this.docsDir = join(sessionDir, 'docs');
    this.index = new Map();
  }

  /**
   * Initialize the document writer and create docs directory
   */
  async initialize(): Promise<void> {
    await mkdir(this.docsDir, { recursive: true });
    await this.refreshIndex();
    debug('DocumentWriter initialized at %s', this.docsDir);
  }

  /**
   * Refresh the document index from filesystem
   */
  private async refreshIndex(): Promise<void> {
    this.index.clear();

    try {
      const files = await readdir(this.docsDir);

      for (const filename of files) {
        const filepath = join(this.docsDir, filename);
        try {
          const stats = await stat(filepath);
          if (!stats.isFile()) continue;

          const content = await readFile(filepath, 'utf-8');
          const format = getFormat(filename);
          const preview = content.slice(0, 200).replace(/\n/g, ' ');

          const info: DocumentInfo = {
            filename,
            format,
            sizeBytes: stats.size,
            preview,
          };

          if (format === 'markdown') {
            info.sections = extractMarkdownSections(content);
          }

          this.index.set(filename, info);
        } catch {
          // Skip files we can't read
        }
      }
    } catch {
      // Directory might not exist yet or be empty
    }

    debug('Index refreshed: %d documents', this.index.size);
  }

  /**
   * Create a new document
   */
  async create(filename: string, content: string): Promise<DocumentWriteResult> {
    const safeFilename = sanitizeFilename(filename);
    const filepath = join(this.docsDir, safeFilename);

    debug('Creating document: %s', safeFilename);

    // Check size limit
    if (Buffer.byteLength(content, 'utf-8') > MAX_DOCUMENT_SIZE) {
      return {
        success: false,
        error: `Content exceeds maximum size of ${MAX_DOCUMENT_SIZE} bytes`,
      };
    }

    // Validate JSON if applicable
    const format = getFormat(safeFilename);
    if (format === 'json') {
      try {
        JSON.parse(content);
      } catch (err) {
        return {
          success: false,
          error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    try {
      await writeFile(filepath, content, 'utf-8');
      await this.refreshIndex();
      return { success: true, path: filepath };
    } catch (err) {
      return {
        success: false,
        error: `Failed to create document: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Read an existing document
   */
  async read(filename: string): Promise<DocumentReadResult> {
    const safeFilename = sanitizeFilename(filename);
    const filepath = join(this.docsDir, safeFilename);

    debug('Reading document: %s', safeFilename);

    try {
      const content = await readFile(filepath, 'utf-8');
      this.lastReadContent = content;
      return { success: true, content };
    } catch (err) {
      return {
        success: false,
        error: `Failed to read document: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Update an existing document (or a specific section for markdown)
   */
  async update(
    filename: string,
    content: string,
    section?: string
  ): Promise<DocumentWriteResult> {
    const safeFilename = sanitizeFilename(filename);
    const filepath = join(this.docsDir, safeFilename);

    debug('Updating document: %s (section: %s)', safeFilename, section || 'entire file');

    // Check size limit
    if (Buffer.byteLength(content, 'utf-8') > MAX_DOCUMENT_SIZE) {
      return {
        success: false,
        error: `Content exceeds maximum size of ${MAX_DOCUMENT_SIZE} bytes`,
      };
    }

    try {
      let finalContent = content;

      // If section is specified and it's a markdown file, update only that section
      if (section) {
        const format = getFormat(safeFilename);
        if (format === 'markdown') {
          const existingContent = await readFile(filepath, 'utf-8');
          finalContent = updateMarkdownSection(existingContent, section, content);
        } else if (format === 'json') {
          // For JSON, treat section as a JSON path (simple key for now)
          const existingContent = await readFile(filepath, 'utf-8');
          const obj = JSON.parse(existingContent);
          obj[section] = JSON.parse(content);
          finalContent = JSON.stringify(obj, null, 2);
        }
      }

      // Validate JSON if applicable
      const format = getFormat(safeFilename);
      if (format === 'json' && !section) {
        try {
          JSON.parse(finalContent);
        } catch (err) {
          return {
            success: false,
            error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      await writeFile(filepath, finalContent, 'utf-8');
      await this.refreshIndex();
      return { success: true, path: filepath };
    } catch (err) {
      return {
        success: false,
        error: `Failed to update document: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Append content to an existing document
   */
  async append(filename: string, content: string): Promise<DocumentWriteResult> {
    const safeFilename = sanitizeFilename(filename);
    const filepath = join(this.docsDir, safeFilename);

    debug('Appending to document: %s', safeFilename);

    try {
      let existingContent = '';
      try {
        existingContent = await readFile(filepath, 'utf-8');
      } catch {
        // File doesn't exist yet, that's fine
      }

      const newContent = existingContent + content;

      // Check size limit
      if (Buffer.byteLength(newContent, 'utf-8') > MAX_DOCUMENT_SIZE) {
        return {
          success: false,
          error: `Content would exceed maximum size of ${MAX_DOCUMENT_SIZE} bytes`,
        };
      }

      await writeFile(filepath, newContent, 'utf-8');
      await this.refreshIndex();
      return { success: true, path: filepath };
    } catch (err) {
      return {
        success: false,
        error: `Failed to append to document: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get the current document index
   */
  getIndex(): DocumentInfo[] {
    return Array.from(this.index.values());
  }

  /**
   * Get the last read document content (for LLM context)
   */
  getLastReadContent(): string | null {
    return this.lastReadContent;
  }

  /**
   * Clear the last read content
   */
  clearLastReadContent(): void {
    this.lastReadContent = null;
  }

  /**
   * Format the document index for LLM consumption
   */
  formatIndexForLLM(): string {
    const docs = this.getIndex();

    if (docs.length === 0) {
      return 'No documents created yet.';
    }

    const lines: string[] = [];
    for (const doc of docs) {
      const sizeKB = (doc.sizeBytes / 1024).toFixed(1);
      lines.push(`- ${doc.filename} (${doc.format}, ${sizeKB}KB)`);
      if (doc.sections && doc.sections.length > 0) {
        lines.push(`  Sections: ${doc.sections.join(', ')}`);
      }
      lines.push(`  Preview: ${doc.preview.slice(0, 100)}...`);
    }

    return lines.join('\n');
  }
}
