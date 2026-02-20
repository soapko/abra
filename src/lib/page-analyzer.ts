/**
 * Page analyzer module - extracts interactive elements from a page
 */

export interface PageElement {
  // Unique identifier for this element (index-based)
  id: number;
  // Element tag name
  tag: string;
  // Element type (for inputs)
  type?: string;
  // Visible text content
  text: string;
  // Aria label if present
  ariaLabel?: string;
  // Data-testid if present
  testId?: string;
  // Placeholder text (for inputs)
  placeholder?: string;
  // Element role
  role?: string;
  // Link href (for anchor elements)
  href?: string;
  // Best selector to use
  selector: string;
  // Position on page
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  // Whether element is visible
  isVisible: boolean;
  // Whether element is enabled/not disabled
  isEnabled: boolean;
  // Whether element is inside a shadow DOM
  inShadowDom?: boolean;
}

export interface PageState {
  url: string;
  title: string;
  elements: PageElement[];
}

/**
 * JavaScript code to inject into page for extracting interactive elements
 * This runs in the browser context
 */
export const PAGE_ANALYZER_SCRIPT = `
(() => {
  // Extended list of interactive element selectors
  const interactiveSelectors = [
    // Standard interactive elements
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    // ARIA roles
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="option"]',
    '[role="listbox"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    // Clickable elements
    '[onclick]',
    '[data-testid]',
    '[tabindex]:not([tabindex="-1"])',
    // Common patterns for dynamic sites
    '[data-action]',
    '[data-click]',
    '[data-href]',
    '[data-url]',
    // Search result patterns
    'article a',
    '.result a',
    '.search-result a',
    '[class*="result"] a',
    '[class*="Result"] a',
    // Common clickable divs/spans
    '[class*="clickable"]',
    '[class*="Clickable"]',
    '[class*="btn"]',
    '[class*="Btn"]',
    // Custom web components (shadow DOM search boxes)
    'reddit-search-large',
    'faceplate-search-input',
    '[class*="search-bar"]',
    '[class*="SearchBar"]',
    '[class*="search-input"]',
    '[class*="SearchInput"]',
    'form[action*="search"]',
    // Dropdown/autocomplete suggestions
    '[class*="suggestion"]',
    '[class*="Suggestion"]',
    '[class*="autocomplete"]',
    '[class*="Autocomplete"]',
    '[class*="dropdown"] li',
    '[class*="Dropdown"] li',
    '[class*="menu-item"]',
    '[class*="MenuItem"]',
    '[class*="typeahead"]',
    '[class*="Typeahead"]',
    // Reddit-specific search suggestions
    'faceplate-tracker[noun="search_suggest"]',
    '[data-testid*="search"]',
    '[data-testid*="subreddit"]',
    'li[role="presentation"]',
    'ul[role="listbox"] > li'
  ].join(', ');

  const seen = new Set();
  const result = [];
  let idCounter = 0;

  // Get all matching elements from regular DOM
  const elements = document.querySelectorAll(interactiveSelectors);

  // Also search inside shadow roots for ALL interactive elements
  const shadowHosts = document.querySelectorAll('*');
  const shadowElements = [];
  shadowHosts.forEach(host => {
    if (host.shadowRoot) {
      // Search for all interactive elements inside shadow DOM
      const shadowInteractive = host.shadowRoot.querySelectorAll(
        'a[href], button, input, select, textarea, ' +
        '[role="button"], [role="link"], [role="menuitem"], [role="option"], [role="listbox"], ' +
        '[onclick], [data-testid], [tabindex]:not([tabindex="-1"]), ' +
        'li, [class*="suggestion"], [class*="result"], [class*="item"]'
      );
      shadowInteractive.forEach(el => shadowElements.push(el));
    }
  });

  // Search inside portal containers (Radix UI, Floating UI, Headless UI)
  // These are rendered as direct children of document.body via React portals
  const portalSelectors = [
    '[data-radix-popper-content-wrapper]',
    '[data-radix-portal]',
    '[data-radix-menu-content]',
    '[data-radix-select-content]',
    '[data-radix-dropdown-menu-content]',
    '[data-floating-ui-portal]',
    '[data-headlessui-portal]',
    '[role="dialog"]:not([data-testid])',
    '[role="listbox"]',
    '[role="menu"]',
  ];
  const portalElements = [];
  const portalContainers = document.querySelectorAll(portalSelectors.join(', '));
  portalContainers.forEach(container => {
    // Search for interactive elements inside the portal
    const portalInteractive = container.querySelectorAll(interactiveSelectors);
    portalInteractive.forEach(el => portalElements.push(el));
    // Also grab elements that are clickable by role/pattern but not in the main selector list
    const extraInteractive = container.querySelectorAll(
      'div[class*="color"], span[class*="color"], ' +
      'div[data-state], span[data-state], ' +
      'div[data-value], span[data-value], ' +
      '[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], ' +
      '[data-radix-collection-item]'
    );
    extraInteractive.forEach(el => portalElements.push(el));
  });

  // Helper to check if element is truly visible
  const isElementVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    const styles = window.getComputedStyle(el);
    if (styles.visibility === 'hidden') return false;
    if (styles.display === 'none') return false;
    if (styles.opacity === '0') return false;
    if (styles.pointerEvents === 'none') return false;

    // Check if element is within viewport (with some margin)
    if (rect.bottom < -100) return false;
    if (rect.top > window.innerHeight + 500) return false;
    if (rect.right < -100) return false;
    if (rect.left > window.innerWidth + 100) return false;

    return true;
  };

  // Helper to check if selector is unique
  const isUnique = (selector) => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };

  // Helper to escape attribute values for selectors
  const escapeAttr = (val) => val.replace(/"/g, '\\\\"').replace(/\\n/g, ' ');

  // Helper to get unique selector
  const getSelector = (el) => {
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute('data-testid');
    const id = el.id;
    const name = el.getAttribute('name');
    const ariaLabel = el.getAttribute('aria-label');
    const href = el.getAttribute('href');

    // Try ID first (usually unique)
    if (id && !id.match(/^[a-f0-9-]{20,}$/i) && !id.match(/^\\d+$/)) {
      const sel = '#' + CSS.escape(id);
      if (isUnique(sel)) return sel;
    }

    // Try data-testid alone
    if (testId) {
      const sel = '[data-testid="' + escapeAttr(testId) + '"]';
      if (isUnique(sel)) return sel;
    }

    // Try name alone
    if (name) {
      const sel = '[name="' + escapeAttr(name) + '"]';
      if (isUnique(sel)) return sel;
    }

    // Try aria-label alone
    if (ariaLabel && ariaLabel.length < 50) {
      const sel = '[aria-label="' + escapeAttr(ariaLabel) + '"]';
      if (isUnique(sel)) return sel;
    }

    // Try href alone for links
    if (tag === 'a' && href && !href.startsWith('javascript:') && href.length < 150) {
      const sel = 'a[href="' + escapeAttr(href) + '"]';
      if (isUnique(sel)) return sel;
    }

    // Combine testid + href for links (common Reddit pattern)
    if (testId && href && tag === 'a') {
      const sel = 'a[data-testid="' + escapeAttr(testId) + '"][href="' + escapeAttr(href) + '"]';
      if (isUnique(sel)) return sel;
    }

    // Combine testid + text content
    if (testId) {
      const text = (el.textContent || '').trim().slice(0, 30);
      if (text) {
        // Use :has() or text matching via aria-label if available
        const sel = '[data-testid="' + escapeAttr(testId) + '"][aria-label*="' + escapeAttr(text.slice(0, 20)) + '"]';
        if (isUnique(sel)) return sel;
      }
    }

    // Try tag + role + partial text match
    const role = el.getAttribute('role');
    if (role) {
      const sel = tag + '[role="' + role + '"]';
      if (isUnique(sel)) return sel;
    }

    // Generate nth-of-type selector based on parent
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      const index = siblings.indexOf(el) + 1;
      if (siblings.length > 1) {
        // Try parent ID + nth-of-type
        if (parent.id) {
          const sel = '#' + CSS.escape(parent.id) + ' > ' + tag + ':nth-of-type(' + index + ')';
          if (isUnique(sel)) return sel;
        }

        // Try parent testid + nth-of-type
        const parentTestId = parent.getAttribute('data-testid');
        if (parentTestId) {
          const sel = '[data-testid="' + escapeAttr(parentTestId) + '"] > ' + tag + ':nth-of-type(' + index + ')';
          if (isUnique(sel)) return sel;
        }
      }
    }

    // Fallback: tag + classes (may not be unique, but better than nothing)
    let selector = tag;
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.split(' ')
        .filter(c => c && c.length > 2 && c.length < 30 && !c.match(/^[a-z]{1,3}-[a-f0-9]+$/i))
        .slice(0, 2);
      if (classes.length) {
        selector += '.' + classes.map(c => CSS.escape(c)).join('.');
      }
    }

    // Add testid even if not unique - action executor will fallback to coordinates
    if (testId) {
      selector = '[data-testid="' + escapeAttr(testId) + '"]';
    }

    return selector;
  };

  // Combine regular elements, shadow DOM elements, and portal elements
  const allElements = [...elements, ...shadowElements, ...portalElements];

  allElements.forEach((el) => {
    if (!isElementVisible(el)) return;

    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();

    // Create a unique key to avoid duplicates
    const key = tag + ':' + Math.round(rect.x) + ':' + Math.round(rect.y);
    if (seen.has(key)) return;
    seen.add(key);

    // For shadow DOM elements, we need a special selector strategy
    const inShadow = el.getRootNode() !== document;

    const testId = el.getAttribute('data-testid');
    const ariaLabel = el.getAttribute('aria-label');
    const role = el.getAttribute('role');
    const href = tag === 'a' ? el.getAttribute('href') : undefined;

    // Get text content (prefer direct text, avoid nested elements' text)
    let text = '';
    if (tag === 'input' || tag === 'textarea') {
      text = el.value || el.placeholder || '';
    } else if (tag === 'select') {
      const selected = el.options[el.selectedIndex];
      text = selected ? selected.text : '';
    } else {
      // Get direct text content, trimmed
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      const textParts = [];
      let node;
      while (node = walker.nextNode()) {
        const t = node.textContent.trim();
        if (t) textParts.push(t);
      }
      text = textParts.join(' ').slice(0, 150);

      // Fallback to textContent if no text found
      if (!text) {
        text = (el.textContent || '').trim().slice(0, 150);
      }
    }

    // Clean up text
    text = text.replace(/\\s+/g, ' ').trim().slice(0, 100);

    // For shadow DOM elements, selectors won't work - mark for coordinate click
    let selector = '';
    if (inShadow) {
      // Find the shadow host element
      const shadowRoot = el.getRootNode();
      const host = shadowRoot.host;
      if (host) {
        const hostTag = host.tagName.toLowerCase();
        const hostTestId = host.getAttribute('data-testid');
        if (hostTestId) {
          selector = '[data-testid="' + escapeAttr(hostTestId) + '"] >>> ' + tag;
        } else {
          selector = hostTag + ' >>> ' + tag;
        }
      } else {
        selector = '__SHADOW_DOM__:' + tag;  // Mark as needing coordinate click
      }
    } else {
      selector = getSelector(el);
    }

    result.push({
      id: idCounter++,
      tag,
      type: el.type || undefined,
      text,
      ariaLabel: ariaLabel || undefined,
      testId: testId || undefined,
      placeholder: el.placeholder || undefined,
      role: role || undefined,
      href: href || undefined,
      selector,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      isVisible: true,
      isEnabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
      inShadowDom: inShadow || undefined
    });
  });

  // Sort by position (top to bottom, left to right)
  result.sort((a, b) => {
    const yDiff = a.bounds.y - b.bounds.y;
    if (Math.abs(yDiff) > 20) return yDiff;
    return a.bounds.x - b.bounds.x;
  });

  // Re-assign IDs after sorting
  result.forEach((el, i) => el.id = i);

  return {
    url: window.location.href,
    title: document.title,
    elements: result
  };
})()
`;

/**
 * Find the element at given coordinates (for sight mode)
 * Returns the smallest (most specific) element containing the point
 */
export function findElementAtCoordinates(
  elements: PageElement[],
  x: number,
  y: number
): PageElement | null {
  // Find all elements whose bounding box contains the point
  const hits = elements.filter(el =>
    x >= el.bounds.x &&
    x <= el.bounds.x + el.bounds.width &&
    y >= el.bounds.y &&
    y <= el.bounds.y + el.bounds.height &&
    el.isVisible &&
    el.isEnabled
  );

  if (hits.length === 0) {
    // No exact hit - find nearest element
    let nearest: PageElement | null = null;
    let minDistance = Infinity;

    for (const el of elements) {
      if (!el.isVisible || !el.isEnabled) continue;

      const centerX = el.bounds.x + el.bounds.width / 2;
      const centerY = el.bounds.y + el.bounds.height / 2;
      const distance = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));

      if (distance < minDistance) {
        minDistance = distance;
        nearest = el;
      }
    }

    return nearest;
  }

  // Return the smallest element (most specific)
  return hits.sort((a, b) =>
    (a.bounds.width * a.bounds.height) - (b.bounds.width * b.bounds.height)
  )[0];
}

/**
 * Format page state for LLM consumption
 */
export function formatPageStateForLLM(state: PageState): string {
  const lines: string[] = [
    `Current Page: ${state.title}`,
    `URL: ${state.url}`,
    '',
    'Interactive Elements:',
  ];

  for (const el of state.elements) {
    const parts: string[] = [`[${el.id}]`];

    // Element type description
    if (el.tag === 'a') {
      parts.push('Link:');
    } else if (el.tag === 'button' || el.role === 'button') {
      parts.push('Button:');
    } else if (el.tag === 'input') {
      parts.push(`Input (${el.type || 'text'}):`);
    } else if (el.tag === 'select') {
      parts.push('Dropdown:');
    } else if (el.tag === 'textarea') {
      parts.push('Text area:');
    } else {
      parts.push(`${el.tag}:`);
    }

    // Text or label
    if (el.text) {
      parts.push(`"${el.text}"`);
    } else if (el.ariaLabel) {
      parts.push(`[${el.ariaLabel}]`);
    } else if (el.placeholder) {
      parts.push(`(placeholder: ${el.placeholder})`);
    } else if (el.testId) {
      parts.push(`[testid: ${el.testId}]`);
    }

    // For links, show destination hint
    if (el.href && el.tag === 'a') {
      // Extract domain or path for context
      try {
        const url = new URL(el.href, state.url);
        if (url.hostname !== new URL(state.url).hostname) {
          parts.push(`-> ${url.hostname}`);
        } else {
          parts.push(`-> ${url.pathname.slice(0, 30)}`);
        }
      } catch {
        // Invalid URL, skip
      }
    }

    // Position hint
    if (el.bounds.y < 100) {
      parts.push('(top of page)');
    } else if (el.bounds.y > 800) {
      parts.push('(below fold)');
    }

    if (!el.isEnabled) {
      parts.push('(disabled)');
    }

    lines.push('  ' + parts.join(' '));
  }

  return lines.join('\n');
}
