/**
 * Speech bubble overlay - shows persona's thoughts near the cursor
 */

/**
 * CSS styles for the speech bubble
 */
const SPEECH_BUBBLE_CSS = `
.abra-speech-bubble {
  position: fixed;
  z-index: 999999;
  max-width: 300px;
  padding: 12px 16px;
  background: rgba(0, 0, 0, 0.85);
  color: white;
  border-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  pointer-events: none;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.abra-speech-bubble.visible {
  opacity: 1;
  transform: translateY(0);
}

.abra-speech-bubble::before {
  content: '';
  position: absolute;
  bottom: -8px;
  left: 20px;
  width: 0;
  height: 0;
  border-left: 8px solid transparent;
  border-right: 8px solid transparent;
  border-top: 8px solid rgba(0, 0, 0, 0.85);
}

.abra-speech-bubble .persona-name {
  font-weight: 600;
  color: #4fc3f7;
  margin-bottom: 4px;
  font-size: 12px;
}

.abra-speech-bubble .thought-text {
  color: white;
}

.abra-speech-bubble .cursor-char {
  display: inline-block;
  width: 2px;
  height: 14px;
  background: white;
  margin-left: 2px;
  animation: blink 0.8s infinite;
}

.abra-speech-bubble .thinking-dots {
  display: inline-flex;
  gap: 4px;
  padding: 2px 0;
}

.abra-speech-bubble .thinking-dots span {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 50%;
  animation: dot-bounce 1.4s ease-in-out infinite;
}

.abra-speech-bubble .thinking-dots span:nth-child(2) {
  animation-delay: 0.2s;
}

.abra-speech-bubble .thinking-dots span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

@keyframes dot-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
`;

/**
 * JavaScript to inject for speech bubble functionality
 */
const SPEECH_BUBBLE_JS = `
window.__abraSpeechBubble = {
  element: null,
  textElement: null,
  currentText: '',
  targetText: '',
  isTyping: false,
  typeInterval: null,
  personaName: 'Persona',

  init(personaName) {
    this.personaName = personaName;

    // Add styles
    if (!document.getElementById('abra-speech-bubble-styles')) {
      const style = document.createElement('style');
      style.id = 'abra-speech-bubble-styles';
      style.textContent = ${JSON.stringify(SPEECH_BUBBLE_CSS)};
      document.head.appendChild(style);
    }

    // Remove any existing orphaned bubble element
    const existing = document.querySelector('.abra-speech-bubble');
    if (existing) existing.remove();

    // Always create a fresh bubble element
    this.element = document.createElement('div');
    this.element.className = 'abra-speech-bubble';
    this.element.innerHTML = \`
      <div class="persona-name">\${this.personaName} thinks...</div>
      <div class="thought-text"></div>
    \`;
    document.body.appendChild(this.element);
    this.textElement = this.element.querySelector('.thought-text');
  },

  _ensureAttached() {
    // Self-heal: if element was detached by SPA navigation or framework re-render
    if (!this.element || !document.body.contains(this.element)) {
      this.init(this.personaName);
    }
  },

  show(text, x, y) {
    this._ensureAttached();
    if (!this.element) return;

    this.targetText = text;

    // Position bubble above the target point
    const bubbleWidth = 300;
    const bubbleHeight = 80;

    let posX = x - bubbleWidth / 2;
    let posY = y - bubbleHeight - 30;

    // Keep on screen
    posX = Math.max(10, Math.min(window.innerWidth - bubbleWidth - 10, posX));
    posY = Math.max(10, posY);

    // If would be off top, show below instead
    if (posY < 10) {
      posY = y + 30;
      this.element.style.setProperty('--arrow-position', 'top');
    }

    this.element.style.left = posX + 'px';
    this.element.style.top = posY + 'px';
    this.element.classList.add('visible');

    // Start typewriter effect
    this.startTyping();
  },

  startTyping() {
    if (this.typeInterval) {
      clearInterval(this.typeInterval);
    }

    this.currentText = '';
    this.isTyping = true;
    let charIndex = 0;

    this.typeInterval = setInterval(() => {
      if (charIndex < this.targetText.length) {
        this.currentText += this.targetText[charIndex];
        this.textElement.innerHTML = this.currentText + '<span class="cursor-char"></span>';
        charIndex++;
      } else {
        this.isTyping = false;
        this.textElement.innerHTML = this.currentText;
        clearInterval(this.typeInterval);
        this.typeInterval = null;
      }
    }, 30);
  },

  showThinking(x, y) {
    this._ensureAttached();
    if (!this.element) return;

    // Position bubble
    const bubbleWidth = 300;
    const bubbleHeight = 80;

    let posX = x - bubbleWidth / 2;
    let posY = y - bubbleHeight - 30;

    posX = Math.max(10, Math.min(window.innerWidth - bubbleWidth - 10, posX));
    posY = Math.max(10, posY);

    if (posY < 10) {
      posY = y + 30;
    }

    this.element.style.left = posX + 'px';
    this.element.style.top = posY + 'px';
    this.element.classList.add('visible');

    // Show animated dots
    if (this.typeInterval) {
      clearInterval(this.typeInterval);
      this.typeInterval = null;
    }
    this.currentText = '';
    this.targetText = '';
    this.textElement.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';
  },

  hide() {
    if (this.element) {
      this.element.classList.remove('visible');
    }
    if (this.typeInterval) {
      clearInterval(this.typeInterval);
      this.typeInterval = null;
    }
  },

  move(x, y) {
    this._ensureAttached();
    if (!this.element) return;

    const bubbleWidth = 300;
    const bubbleHeight = 80;

    let posX = x - bubbleWidth / 2;
    let posY = y - bubbleHeight - 30;

    posX = Math.max(10, Math.min(window.innerWidth - bubbleWidth - 10, posX));
    posY = Math.max(10, posY);

    this.element.style.left = posX + 'px';
    this.element.style.top = posY + 'px';
  },

  destroy() {
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
    if (this.typeInterval) {
      clearInterval(this.typeInterval);
    }
    const style = document.getElementById('abra-speech-bubble-styles');
    if (style) style.remove();
  }
};
`;

/**
 * Get the script to inject for initializing the speech bubble
 */
export function getInitScript(personaName: string): string {
  return `
    ${SPEECH_BUBBLE_JS}
    window.__abraSpeechBubble.init(${JSON.stringify(personaName)});
  `;
}

/**
 * Get the script to show a thought at a specific position
 */
export function getShowScript(thought: string, x: number, y: number): string {
  return `window.__abraSpeechBubble.show(${JSON.stringify(thought)}, ${x}, ${y})`;
}

/**
 * Get the script to show a "thinking..." animation at a specific position
 */
export function getShowThinkingScript(x: number, y: number): string {
  return `window.__abraSpeechBubble.showThinking(${x}, ${y})`;
}

/**
 * Get the script to hide the speech bubble
 */
export function getHideScript(): string {
  return `window.__abraSpeechBubble.hide()`;
}

/**
 * Get the script to move the speech bubble
 */
export function getMoveScript(x: number, y: number): string {
  return `window.__abraSpeechBubble.move(${x}, ${y})`;
}

/**
 * Get the script to destroy/cleanup the speech bubble
 */
export function getDestroyScript(): string {
  return `window.__abraSpeechBubble.destroy()`;
}
