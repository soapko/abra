/**
 * Screenshot annotator - overlays numbered labels on interactive elements
 * for vision-based element selection
 */

import type { PageElement } from './page-analyzer.js';

/**
 * CSS styles for element annotations
 */
const ANNOTATION_CSS = `
.abra-annotation-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 999998;
}

.abra-annotation-label {
  position: absolute;
  background: #e63946;
  color: white;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
  font-size: 11px;
  font-weight: bold;
  padding: 2px 5px;
  border-radius: 3px;
  line-height: 1;
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  white-space: nowrap;
}

.abra-annotation-box {
  position: absolute;
  border: 2px solid #e63946;
  border-radius: 3px;
  pointer-events: none;
}
`;

/**
 * Generate the script to inject annotations onto the page
 */
export function getAnnotationScript(elements: PageElement[]): string {
  // Filter to only visible, enabled elements with reasonable bounds
  const annotatable = elements.filter(el =>
    el.isVisible &&
    el.isEnabled &&
    el.bounds.width > 5 &&
    el.bounds.height > 5 &&
    el.bounds.x >= 0 &&
    el.bounds.y >= 0
  );

  const elementsJson = JSON.stringify(annotatable.map(el => ({
    id: el.id,
    x: el.bounds.x,
    y: el.bounds.y,
    width: el.bounds.width,
    height: el.bounds.height,
  })));

  return `
(function() {
  // Remove any existing annotations
  const existing = document.getElementById('abra-annotations');
  if (existing) existing.remove();
  const existingStyle = document.getElementById('abra-annotation-styles');
  if (existingStyle) existingStyle.remove();

  // Add styles
  const style = document.createElement('style');
  style.id = 'abra-annotation-styles';
  style.textContent = ${JSON.stringify(ANNOTATION_CSS)};
  document.head.appendChild(style);

  // Create overlay container
  const overlay = document.createElement('div');
  overlay.id = 'abra-annotations';
  overlay.className = 'abra-annotation-overlay';

  const elements = ${elementsJson};

  elements.forEach(el => {
    // Create bounding box
    const box = document.createElement('div');
    box.className = 'abra-annotation-box';
    box.style.left = el.x + 'px';
    box.style.top = el.y + 'px';
    box.style.width = el.width + 'px';
    box.style.height = el.height + 'px';
    overlay.appendChild(box);

    // Create label
    const label = document.createElement('div');
    label.className = 'abra-annotation-label';
    label.textContent = '[' + el.id + ']';

    // Position label at top-left of element, but keep on screen
    let labelX = el.x;
    let labelY = el.y - 18;

    // If label would be off-screen, position it inside the element
    if (labelY < 0) {
      labelY = el.y + 2;
    }
    if (labelX < 0) {
      labelX = 2;
    }

    label.style.left = labelX + 'px';
    label.style.top = labelY + 'px';
    overlay.appendChild(label);
  });

  document.body.appendChild(overlay);
})();
`;
}

/**
 * Generate the script to remove annotations from the page
 */
export function getRemoveAnnotationScript(): string {
  return `
(function() {
  const overlay = document.getElementById('abra-annotations');
  if (overlay) overlay.remove();
  const style = document.getElementById('abra-annotation-styles');
  if (style) style.remove();
})();
`;
}

/**
 * Format elements for LLM consumption in vision mode
 * Provides a legend of element IDs and their descriptions
 */
export function formatElementLegend(elements: PageElement[]): string {
  const lines: string[] = ['Element Legend:'];

  for (const el of elements) {
    if (!el.isVisible || !el.isEnabled) continue;
    if (el.bounds.width <= 5 || el.bounds.height <= 5) continue;

    const parts: string[] = [`[${el.id}]`];

    // Element type
    if (el.tag === 'a') {
      parts.push('Link');
    } else if (el.tag === 'button' || el.role === 'button') {
      parts.push('Button');
    } else if (el.tag === 'input') {
      parts.push(`Input(${el.type || 'text'})`);
    } else if (el.tag === 'select') {
      parts.push('Dropdown');
    } else if (el.tag === 'textarea') {
      parts.push('TextArea');
    } else {
      parts.push(el.tag);
    }

    // Label/text
    if (el.text) {
      parts.push(`"${el.text.slice(0, 40)}${el.text.length > 40 ? '...' : ''}"`);
    } else if (el.ariaLabel) {
      parts.push(`[${el.ariaLabel}]`);
    } else if (el.placeholder) {
      parts.push(`(${el.placeholder})`);
    } else if (el.testId) {
      parts.push(`{${el.testId}}`);
    }

    // Add position context to help LLM identify elements
    const posDesc = getPositionDescription(el.bounds);
    if (posDesc) {
      parts.push(`@${posDesc}`);
    }

    lines.push('  ' + parts.join(' '));
  }

  return lines.join('\n');
}

/**
 * Get a human-readable position description for an element
 */
function getPositionDescription(bounds: { x: number; y: number; width: number; height: number }): string {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  // Assume standard viewport - adjust if needed
  const viewWidth = 1280;
  const viewHeight = 720;

  let horizontal = '';
  if (centerX < viewWidth * 0.33) horizontal = 'left';
  else if (centerX > viewWidth * 0.67) horizontal = 'right';
  else horizontal = 'center';

  let vertical = '';
  if (centerY < 100) vertical = 'top';
  else if (centerY < 300) vertical = 'upper';
  else if (centerY > viewHeight - 100) vertical = 'bottom';

  if (vertical && horizontal) {
    return `${vertical}-${horizontal}`;
  } else if (vertical) {
    return vertical;
  } else if (horizontal !== 'center') {
    return horizontal;
  }
  return '';
}
