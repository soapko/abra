/**
 * Page content extractor - extracts readable text content from a page
 * for the Observer agent (complementary to page-analyzer.ts which extracts interactive elements)
 */

export interface PageContent {
  url: string;
  title: string;
  headings: Array<{ level: number; text: string }>;
  paragraphs: string[];
  lists: Array<{ items: string[] }>;
  images: Array<{ alt: string }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  rawText: string;
}

/**
 * JavaScript code to inject into page for extracting readable text content.
 * This runs in the browser context.
 */
export const PAGE_CONTENT_SCRIPT = `
(() => {
  // Helper to check if element is visible
  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  };

  // Helper to get clean text from an element
  const cleanText = (text) => (text || '').replace(/\\s+/g, ' ').trim();

  // Extract headings
  const headings = [];
  document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
    if (!isVisible(el)) return;
    const text = cleanText(el.textContent);
    if (!text) return;
    headings.push({
      level: parseInt(el.tagName[1], 10),
      text: text.slice(0, 200)
    });
  });

  // Extract paragraphs from main content areas
  const paragraphs = [];
  const contentSelectors = 'main p, article p, section p, [role="main"] p, .content p, #content p, p';
  const seenTexts = new Set();
  document.querySelectorAll(contentSelectors).forEach(el => {
    if (!isVisible(el)) return;
    const text = cleanText(el.textContent);
    if (!text || text.length < 20) return;
    if (seenTexts.has(text)) return;
    seenTexts.add(text);
    paragraphs.push(text.slice(0, 500));
  });

  // Extract lists
  const lists = [];
  document.querySelectorAll('ul, ol').forEach(el => {
    if (!isVisible(el)) return;
    // Skip nav lists
    const parent = el.closest('nav, header, footer, [role="navigation"]');
    if (parent) return;
    const items = [];
    el.querySelectorAll(':scope > li').forEach(li => {
      const text = cleanText(li.textContent);
      if (text) items.push(text.slice(0, 200));
    });
    if (items.length > 0) {
      lists.push({ items: items.slice(0, 20) });
    }
  });

  // Extract images with alt text
  const images = [];
  document.querySelectorAll('img[alt]').forEach(el => {
    if (!isVisible(el)) return;
    const alt = cleanText(el.getAttribute('alt'));
    if (alt && alt.length > 2) {
      images.push({ alt: alt.slice(0, 200) });
    }
  });

  // Extract tables
  const tables = [];
  document.querySelectorAll('table').forEach(table => {
    if (!isVisible(table)) return;
    const headers = [];
    table.querySelectorAll('thead th, thead td, tr:first-child th').forEach(th => {
      headers.push(cleanText(th.textContent).slice(0, 100));
    });
    const rows = [];
    const bodyRows = table.querySelectorAll('tbody tr, tr');
    // Skip header row if headers were found from first row
    const startIdx = headers.length > 0 && !table.querySelector('thead') ? 1 : 0;
    bodyRows.forEach((tr, idx) => {
      if (idx < startIdx) return;
      if (rows.length >= 10) return; // Cap at 10 rows
      const cells = [];
      tr.querySelectorAll('td, th').forEach(td => {
        cells.push(cleanText(td.textContent).slice(0, 100));
      });
      if (cells.length > 0) rows.push(cells);
    });
    if (headers.length > 0 || rows.length > 0) {
      tables.push({ headers, rows });
    }
  });

  // Extract raw visible text from body (truncated)
  const bodyEl = document.querySelector('main') || document.querySelector('article') || document.body;
  let rawText = '';
  if (bodyEl) {
    const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        // Skip script, style, and hidden elements
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textParts = [];
    let totalLen = 0;
    let node;
    while ((node = walker.nextNode()) && totalLen < 4000) {
      const text = node.textContent.trim();
      if (text.length > 1) {
        textParts.push(text);
        totalLen += text.length;
      }
    }
    rawText = textParts.join(' ').replace(/\\s+/g, ' ').slice(0, 4000);
  }

  return {
    url: window.location.href,
    title: document.title,
    headings,
    paragraphs: paragraphs.slice(0, 30),
    lists: lists.slice(0, 10),
    images: images.slice(0, 20),
    tables: tables.slice(0, 5),
    rawText
  };
})()
`;

/**
 * Format extracted page content into a text prompt for the Observer LLM.
 * Capped at ~6000 chars to keep the observer prompt reasonable.
 */
export function formatPageContentForLLM(content: PageContent): string {
  const parts: string[] = [
    'PAGE CONTENT:',
    `Title: ${content.title}`,
    `URL: ${content.url}`,
  ];

  // Headings
  if (content.headings.length > 0) {
    parts.push('');
    parts.push('Headings:');
    for (const h of content.headings) {
      parts.push(`  ${'#'.repeat(h.level)} ${h.text}`);
    }
  }

  // Paragraphs
  if (content.paragraphs.length > 0) {
    parts.push('');
    parts.push('Visible Text:');
    for (const p of content.paragraphs) {
      parts.push(p);
      parts.push('');
    }
  }

  // Lists
  if (content.lists.length > 0) {
    parts.push('Lists:');
    for (const list of content.lists) {
      for (const item of list.items) {
        parts.push(`  - ${item}`);
      }
      parts.push('');
    }
  }

  // Images
  if (content.images.length > 0) {
    parts.push('Images:');
    for (const img of content.images) {
      parts.push(`  [Image: ${img.alt}]`);
    }
    parts.push('');
  }

  // Tables
  if (content.tables.length > 0) {
    parts.push('Tables:');
    for (const table of content.tables) {
      if (table.headers.length > 0) {
        parts.push(`  | ${table.headers.join(' | ')} |`);
        parts.push(`  | ${table.headers.map(() => '---').join(' | ')} |`);
      }
      for (const row of table.rows) {
        parts.push(`  | ${row.join(' | ')} |`);
      }
      parts.push('');
    }
  }

  // Raw text fallback (if paragraphs didn't capture much)
  if (content.paragraphs.length < 3 && content.rawText.length > 100) {
    parts.push('Raw Page Text:');
    parts.push(content.rawText);
  }

  // Cap total output at ~6000 chars
  let result = parts.join('\n');
  if (result.length > 6000) {
    result = result.slice(0, 5990) + '\n[...]';
  }
  return result;
}
