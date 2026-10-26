import { resolveSafeOffset, type ClipAnnotation } from './markdown';

export interface CaretLookupResult {
  rawOffset: number;
  safeOffset: number;
  adjusted: boolean;
  reason?: string;
}

/**
 * Resolve a viewport pointer coordinate `(clientX, clientY)` inside `container`
 * to a precise character offset in `baseMarkdown`, then apply the minimal avoidance principle
 * (`resolveSafeOffset`) so we never split a math formula (`$...$` / `$$...$$`), code span, etc.
 */
export function resolveMarkdownOffsetFromPoint(
  container: HTMLElement,
  baseMarkdown: string,
  clientX: number,
  clientY: number
): CaretLookupResult {
  // 1. Check if the pointer is inside a rendered KaTeX math element or code element
  const targetEl = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (targetEl && container.contains(targetEl)) {
    const katexContainer = targetEl.closest('.katex, .katex-display') as HTMLElement | null;
    if (katexContainer && container.contains(katexContainer)) {
      const annotatedParent = findClosestSourceAnnotatedElement(katexContainer, container);
      if (annotatedParent) {
        const rect = katexContainer.getBoundingClientRect();
        const isRightHalf = clientX >= rect.left + rect.width / 2;
        const approxOffset = estimateOffsetNearMathElement(
          annotatedParent,
          katexContainer,
          baseMarkdown,
          isRightHalf
        );
        const safe = resolveSafeOffset(baseMarkdown, approxOffset);
        return {
          rawOffset: approxOffset,
          safeOffset: safe.offset,
          adjusted: true,
          reason: safe.reason || 'katex-formula'
        };
      }
    }
  }

  // 2. Use browser CaretPosition / CaretRange at (clientX, clientY)
  const caret = getCaretNodeAndOffset(clientX, clientY);
  if (caret && container.contains(caret.node)) {
    // Check if caret landed inside `.katex`
    const parentEl =
      caret.node.nodeType === Node.ELEMENT_NODE
        ? (caret.node as HTMLElement)
        : caret.node.parentElement;
    const katexEl = parentEl?.closest('.katex, .katex-display') as HTMLElement | null;
    if (katexEl && container.contains(katexEl)) {
      const annotatedParent = findClosestSourceAnnotatedElement(katexEl, container);
      if (annotatedParent) {
        const rect = katexEl.getBoundingClientRect();
        const isRightHalf = clientX >= rect.left + rect.width / 2;
        const approxOffset = estimateOffsetNearMathElement(
          annotatedParent,
          katexEl,
          baseMarkdown,
          isRightHalf
        );
        const safe = resolveSafeOffset(baseMarkdown, approxOffset);
        return {
          rawOffset: approxOffset,
          safeOffset: safe.offset,
          adjusted: true,
          reason: safe.reason || 'katex-formula'
        };
      }
    }

    const mapped = mapDomNodeOffsetToMarkdown(container, baseMarkdown, caret.node, caret.offset);
    if (mapped !== null) {
      const safe = resolveSafeOffset(baseMarkdown, mapped);
      return {
        rawOffset: mapped,
        safeOffset: safe.offset,
        adjusted: safe.adjusted,
        reason: safe.reason
      };
    }
  }

  // 3. Fallback: find closest element with data-md-start / data-md-end by vertical/horizontal distance
  const fallbackOffset = findNearestElementMarkdownOffset(container, baseMarkdown, clientX, clientY);
  const safe = resolveSafeOffset(baseMarkdown, fallbackOffset);
  return {
    rawOffset: fallbackOffset,
    safeOffset: safe.offset,
    adjusted: safe.adjusted,
    reason: safe.reason
  };
}

interface CaretPositionLike {
  offsetNode: Node | null;
  offset: number;
}

interface DocumentWithCaretApis {
  caretPositionFromPoint?: (x: number, y: number) => CaretPositionLike | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

function getCaretNodeAndOffset(
  clientX: number,
  clientY: number
): { node: Node; offset: number } | null {
  const doc = document as unknown as DocumentWithCaretApis;
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (pos && pos.offsetNode) {
      return { node: pos.offsetNode, offset: pos.offset };
    }
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range: Range | null = doc.caretRangeFromPoint(clientX, clientY);
    if (range && range.startContainer) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  }
  return null;
}

function findClosestSourceAnnotatedElement(
  el: HTMLElement | null,
  container: HTMLElement
): HTMLElement | null {
  let curr = el;
  while (curr && curr !== container && container.contains(curr)) {
    if (curr.hasAttribute('data-md-start') && curr.hasAttribute('data-md-end')) {
      return curr;
    }
    curr = curr.parentElement;
  }
  return null;
}

function estimateOffsetNearMathElement(
  annotatedParent: HTMLElement,
  katexEl: HTMLElement,
  baseMarkdown: string,
  preferAfter: boolean
): number {
  const mdStart = Number(annotatedParent.getAttribute('data-md-start') || 0);
  const mdEnd = Number(annotatedParent.getAttribute('data-md-end') || baseMarkdown.length);
  const slice = baseMarkdown.slice(mdStart, mdEnd);

  // Count which index of `.katex` this element is inside annotatedParent
  const allKatex = Array.from(annotatedParent.querySelectorAll('.katex-display, :not(.katex-display) > .katex'));
  const normalizedTarget = katexEl.classList.contains('katex-display')
    ? katexEl
    : (katexEl.closest('.katex-display') as HTMLElement) || katexEl;
  const mathIndex = Math.max(0, allKatex.indexOf(normalizedTarget));

  const mathRegex = /\$\$[\s\S]*?\$\$|\$[^\n$]+?\$/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = mathRegex.exec(slice)) !== null) {
    if (idx === mathIndex) {
      const formulaMid = mdStart + m.index + Math.floor(m[0].length / 2);
      // Return a point slightly left or right of midpoint inside the formula so resolveSafeOffset
      // snaps it cleanly to the formula's start or end boundary with adjusted=true
      return preferAfter
        ? Math.min(mdStart + m.index + m[0].length - 1, Math.max(mdStart + m.index + 1, formulaMid + 1))
        : Math.max(mdStart + m.index + 1, formulaMid - 1);
    }
    idx++;
  }

  return preferAfter ? mdEnd : mdStart;
}

function mapDomNodeOffsetToMarkdown(
  container: HTMLElement,
  baseMarkdown: string,
  node: Node,
  domOffset: number
): number | null {
  const startEl =
    node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  const annotatedEl = findClosestSourceAnnotatedElement(startEl, container);
  if (!annotatedEl) return null;

  const mdStart = Number(annotatedEl.getAttribute('data-md-start'));
  const mdEnd = Number(annotatedEl.getAttribute('data-md-end'));
  if (Number.isNaN(mdStart) || Number.isNaN(mdEnd)) return null;

  const mdSlice = baseMarkdown.slice(mdStart, mdEnd);

  if (node.nodeType === Node.TEXT_NODE) {
    const textContent = node.textContent || '';
    const clampedDomOffset = Math.max(0, Math.min(textContent.length, domOffset));

    // Try exact substring match of this text node within the element's Markdown slice
    if (textContent.length > 0) {
      // Find how many identical text nodes precede this one inside annotatedEl
      const occurrenceOffset = findTextNodeOffsetInMdSlice(
        annotatedEl,
        node as Text,
        clampedDomOffset,
        mdSlice
      );
      if (occurrenceOffset !== null) {
        return mdStart + occurrenceOffset;
      }
    }
  }

  // Fallback to proportional character progress inside annotatedEl
  const { charsBefore, totalChars } = measureDomTextProgress(annotatedEl, node, domOffset);
  if (totalChars <= 0) return mdStart;
  const ratio = Math.max(0, Math.min(1, charsBefore / totalChars));
  return mdStart + Math.round(ratio * (mdEnd - mdStart));
}

function findTextNodeOffsetInMdSlice(
  annotatedEl: HTMLElement,
  targetTextNode: Text,
  charIndexInText: number,
  mdSlice: string
): number | null {
  const fullText = targetTextNode.textContent || '';
  if (!fullText.trim()) return null;

  // Walk text nodes in annotatedEl (skipping .katex internals and injected clip badges)
  const walker = document.createTreeWalker(annotatedEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('.katex, .clip-anchor-pin')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let searchFrom = 0;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const txt = current.textContent || '';
    const pos = mdSlice.indexOf(txt, searchFrom);
    if (current === targetTextNode) {
      if (pos !== -1) {
        return pos + charIndexInText;
      }
      // Try matching prefix around charIndexInText
      const prefix = txt.slice(0, charIndexInText);
      if (prefix.length >= 2) {
        const prefixPos = mdSlice.indexOf(prefix, searchFrom);
        if (prefixPos !== -1) {
          return prefixPos + prefix.length;
        }
      }
      break;
    }
    if (pos !== -1) {
      searchFrom = pos + txt.length;
    }
  }

  return null;
}

function measureDomTextProgress(
  root: HTMLElement,
  targetNode: Node,
  targetOffset: number
): { charsBefore: number; totalChars: number } {
  let charsBefore = 0;
  let totalChars = 0;
  let found = false;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('.clip-anchor-pin')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let current: Node | null;
  while ((current = walker.nextNode())) {
    const len = (current.textContent || '').length;
    if (current === targetNode) {
      charsBefore = totalChars + Math.min(len, targetOffset);
      found = true;
    }
    totalChars += len;
  }

  if (!found) {
    charsBefore = totalChars;
  }

  return { charsBefore, totalChars };
}

function findNearestElementMarkdownOffset(
  container: HTMLElement,
  baseMarkdown: string,
  clientX: number,
  clientY: number
): number {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>('[data-md-start][data-md-end]'));
  if (candidates.length === 0) return baseMarkdown.length;

  let bestEl = candidates[0]!;
  let bestDist = Infinity;

  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const dist = Math.hypot(dx, dy);
    if (dist <= bestDist) {
      bestDist = dist;
      bestEl = el;
    }
  }

  const rect = bestEl.getBoundingClientRect();
  const mdStart = Number(bestEl.getAttribute('data-md-start') || 0);
  const mdEnd = Number(bestEl.getAttribute('data-md-end') || baseMarkdown.length);
  if (clientX <= rect.left + rect.width * 0.3) return mdStart;
  if (clientX >= rect.left + rect.width * 0.7) return mdEnd;
  const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0.5;
  return mdStart + Math.round(ratio * (mdEnd - mdStart));
}

/**
 * Inject interactive paperclip (`📎`) badges into the already-rendered Markdown container DOM
 * at each clip's exact Markdown offset without mutating or breaking KaTeX/code blocks.
 */
export function mountPaperclipsIntoDom(
  container: HTMLElement,
  baseMarkdown: string,
  clips: ClipAnnotation[],
  selectedClipId: string | null,
  onSelectClip: (clipId: string) => void
): void {
  // Remove any previously mounted pins and merge split text nodes back together
  container.querySelectorAll('.clip-anchor-pin').forEach((el) => el.remove());
  container.normalize();

  for (const clip of clips) {
    const pin = createPaperclipBadgeElement(clip, clip.id === selectedClipId, onSelectClip);
    insertBadgeAtMarkdownOffset(container, baseMarkdown, clip.offset, pin);
  }
}

function createPaperclipBadgeElement(
  clip: ClipAnnotation,
  isSelected: boolean,
  onSelectClip: (clipId: string) => void
): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `clip-anchor-pin ${isSelected ? 'is-selected' : ''}`;
  btn.dataset.clipId = clip.id;
  btn.dataset.clipOffset = String(clip.offset);
  btn.style.setProperty('--clip-color', clip.color);
  btn.title = `查看批注 (${clip.messages.length} 条对话)`;
  btn.innerHTML = `<span class="clip-emoji" aria-hidden="true">📎</span><span class="clip-count">${clip.messages.length}</span>`;

  btn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectClip(clip.id);
  });

  return btn;
}

function insertBadgeAtMarkdownOffset(
  container: HTMLElement,
  baseMarkdown: string,
  targetOffset: number,
  badgeEl: HTMLElement
): void {
  const annotatedEls = Array.from(
    container.querySelectorAll<HTMLElement>('[data-md-start][data-md-end]')
  );

  // Find the smallest (most specific) element whose [mdStart, mdEnd] contains targetOffset
  let bestEl: HTMLElement | null = null;
  let bestSpan = Infinity;

  for (const el of annotatedEls) {
    const start = Number(el.getAttribute('data-md-start'));
    const end = Number(el.getAttribute('data-md-end'));
    if (targetOffset >= start && targetOffset <= end) {
      const span = end - start;
      if (span <= bestSpan) {
        bestSpan = span;
        bestEl = el;
      }
    }
  }

  if (!bestEl) {
    // Find nearest element before or after targetOffset
    for (const el of annotatedEls) {
      const start = Number(el.getAttribute('data-md-start'));
      if (start >= targetOffset) {
        el.prepend(badgeEl);
        return;
      }
    }
    container.appendChild(badgeEl);
    return;
  }

  const elStart = Number(bestEl.getAttribute('data-md-start'));
  const elEnd = Number(bestEl.getAttribute('data-md-end'));
  const mdSlice = baseMarkdown.slice(elStart, elEnd);
  const relOffset = Math.max(0, Math.min(mdSlice.length, targetOffset - elStart));

  // If relOffset is right at start or end of a code/math element, place outside it
  if (bestEl.tagName === 'CODE' || bestEl.tagName === 'PRE' || bestEl.classList.contains('katex')) {
    if (relOffset === 0 && bestEl.parentNode) {
      bestEl.parentNode.insertBefore(badgeEl, bestEl);
      return;
    }
    if (bestEl.parentNode) {
      bestEl.parentNode.insertBefore(badgeEl, bestEl.nextSibling);
      return;
    }
  }

  // Try to locate the exact text node position inside `bestEl`
  const walker = document.createTreeWalker(bestEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('.katex, .clip-anchor-pin, code, pre')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let searchFrom = 0;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const textNode = current as Text;
    const txt = textNode.textContent || '';
    if (!txt) continue;

    const pos = mdSlice.indexOf(txt, searchFrom);
    if (pos !== -1) {
      const startInSlice = pos;
      const endInSlice = pos + txt.length;
      if (relOffset >= startInSlice && relOffset <= endInSlice) {
        const splitIndex = relOffset - startInSlice;
        const afterNode = textNode.splitText(splitIndex);
        afterNode.parentNode?.insertBefore(badgeEl, afterNode);
        return;
      }
      searchFrom = endInSlice;
    }
  }

  // Check if targetOffset matches the end of a child element (like inline math or inline code)
  const childElements = Array.from(bestEl.children) as HTMLElement[];
  for (const child of childElements) {
    const cEnd = Number(child.getAttribute('data-md-end'));
    const cStart = Number(child.getAttribute('data-md-start'));
    if (cStart === targetOffset) {
      child.parentNode?.insertBefore(badgeEl, child);
      return;
    }
    if (cEnd === targetOffset) {
      child.parentNode?.insertBefore(badgeEl, child.nextSibling);
      return;
    }
  }

  // If targetOffset is closer to start of bestEl, prepend; otherwise append
  if (relOffset === 0) {
    bestEl.prepend(badgeEl);
  } else {
    bestEl.appendChild(badgeEl);
  }
}
