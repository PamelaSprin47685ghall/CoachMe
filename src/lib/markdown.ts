import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Node } from 'unist';

export interface ChatTurn {
  id: string;
  role: 'user' | 'ai';
  content: string; // HTML or text for AI, text for user
  pending?: boolean;
}

export interface ClipAnnotation {
  id: string;
  color: string;
  /** Offset in the clean base Markdown (0..baseMarkdown.length) */
  offset: number;
  /** Context snippet near the clip for display */
  anchorSnippet: string;
  messages: ChatTurn[];
  createdAt: number;
}

export interface ForbiddenInterval {
  start: number;
  end: number;
  reason: string;
}

interface PositionedNode extends Node {
  properties?: Record<string, string>;
}

const ATOMIC_NODE_TYPES: Record<string, true> = {
  inlineMath: true,
  math: true,
  inlineCode: true,
  code: true,
  html: true,
  yaml: true,
  toml: true,
  link: true,
  image: true,
  linkReference: true,
  imageReference: true,
  definition: true,
  footnoteDefinition: true,
  footnoteReference: true
};

/**
 * Compute all intervals in `markdown` where inserting an HTML `<aside>` or clip marker
 * would break Markdown or LaTeX semantics (e.g., inside inlineMath `$...$`, block `$$...$$`,
 * inlineCode `` `...` ``, fenced code blocks, HTML tags, link/image syntax, headings prefix).
 */
export function getForbiddenIntervals(markdown: string): ForbiddenInterval[] {
  const intervals: ForbiddenInterval[] = [];

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkFrontmatter, ['yaml', 'toml']);

  const tree = processor.parse(markdown);

  visit(tree, (rawNode: Node) => {
    const node = rawNode as PositionedNode;
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number') return;

    if (ATOMIC_NODE_TYPES[node.type]) {
      intervals.push({ start, end, reason: node.type });
    } else if (node.type === 'heading') {
      // Protect the `# ` heading prefix so `# Title` doesn't become `#<aside> Title`
      const slice = markdown.slice(start, end);
      const match = slice.match(/^(\s*#{1,6}\s+)/);
      if (match && match[1]) {
        intervals.push({
          start,
          end: start + match[1].length,
          reason: 'heading-prefix'
        });
      }
    } else if (node.type === 'listItem') {
      const slice = markdown.slice(start, end);
      const match = slice.match(/^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/);
      if (match && match[1]) {
        intervals.push({
          start,
          end: start + match[1].length,
          reason: 'list-marker'
        });
      }
    } else if (node.type === 'blockquote') {
      const slice = markdown.slice(start, end);
      const match = slice.match(/^(\s*>\s*)/);
      if (match && match[1]) {
        intervals.push({
          start,
          end: start + match[1].length,
          reason: 'blockquote-prefix'
        });
      }
    } else if (node.type === 'table') {
      // Protect table delimiter rows and pipe boundaries
      intervals.push({ start, end, reason: 'table' });
    }
  });

  // Also regex-guard any raw `$...$` or `$$...$$` or `<...>` in case of edge syntax
  const mathRegex = /\$\$[\s\S]*?\$\$|\$[^\n$]+?\$/g;
  let m: RegExpExecArray | null;
  while ((m = mathRegex.exec(markdown)) !== null) {
    intervals.push({
      start: m.index,
      end: m.index + m[0].length,
      reason: 'math-regex'
    });
  }

  // Merge overlapping or adjacent intervals
  if (intervals.length === 0) return [];
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: ForbiddenInterval[] = [intervals[0]!];
  for (let i = 1; i < intervals.length; i++) {
    const cur = intervals[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start < last.end) {
      if (cur.end > last.end) {
        last.end = cur.end;
        last.reason = `${last.reason}+${cur.reason}`;
      }
    } else {
      merged.push({ ...cur });
    }
  }

  return merged;
}

/**
 * Minimal Avoidance Principle (最小避让原则):
 * Given a target offset in `markdown`, if it falls strictly inside a forbidden interval
 * (like the middle of a math formula `$E = mc^2$` or inline code), snap it to whichever
 * boundary (`interval.start` or `interval.end`) is closer.
 * Also avoids splitting UTF-16 surrogate pairs.
 */
export function resolveSafeOffset(
  markdown: string,
  rawOffset: number
): { offset: number; adjusted: boolean; reason?: string } {
  const clamped = Math.max(0, Math.min(markdown.length, Math.round(rawOffset)));
  const intervals = getForbiddenIntervals(markdown);

  let offset = clamped;
  let adjusted = false;
  let reason: string | undefined;

  for (const interval of intervals) {
    if (offset > interval.start && offset < interval.end) {
      const distStart = offset - interval.start;
      const distEnd = interval.end - offset;
      // Prefer end if equal so clip sits right after the formula/token
      offset = distEnd <= distStart ? interval.end : interval.start;
      adjusted = true;
      reason = interval.reason;
      break;
    }
  }

  // Avoid splitting surrogate pairs
  if (offset > 0 && offset < markdown.length) {
    const prevCode = markdown.charCodeAt(offset - 1);
    const currCode = markdown.charCodeAt(offset);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff && currCode >= 0xdc00 && currCode <= 0xdfff) {
      offset += 1;
      adjusted = true;
    }
  }

  return { offset, adjusted, reason };
}

/**
 * Format a single ClipAnnotation as the required semantic HTML `<aside>` block:
 * <aside class="annotation" data-clip="...">
 *   <blockquote>
 *     <p>消息内容</p>
 *     <footer>用户</footer>
 *   </blockquote>
 *   <blockquote>
 *     <!--AI_REPLY_PLACEHOLDER-->
 *     <footer>AI</footer>
 *   </blockquote>
 * </aside>
 */
export function serializeClipToAsideHtml(
  clip: ClipAnnotation,
  activePlaceholderClipId?: string
): string {
  const blocks: string[] = [];

  for (const msg of clip.messages) {
    if (msg.role === 'user') {
      blocks.push(
        [
          '  <blockquote>',
          `    <p>${escapeHtmlText(msg.content)}</p>`,
          '    <footer>用户</footer>',
          '  </blockquote>'
        ].join('\n')
      );
    } else {
      if (msg.pending) {
        blocks.push(
          [
            '  <blockquote>',
            '    <!--AI_REPLY_PLACEHOLDER-->',
            '    <footer>AI</footer>',
            '  </blockquote>'
          ].join('\n')
        );
      } else {
        blocks.push(
          [
            '  <blockquote>',
            `    ${msg.content.trim()}`,
            '    <footer>AI</footer>',
            '  </blockquote>'
          ].join('\n')
        );
      }
    }
  }

  // If the last message in this clip is from the user and hasn't been replied to yet
  const lastMsg = clip.messages[clip.messages.length - 1];
  const needsTrailingPlaceholder =
    (lastMsg && lastMsg.role === 'user') ||
    (activePlaceholderClipId === clip.id && (!lastMsg || lastMsg.role === 'user'));

  if (needsTrailingPlaceholder) {
    blocks.push(
      [
        '  <blockquote>',
        '    <!--AI_REPLY_PLACEHOLDER-->',
        '    <footer>AI</footer>',
        '  </blockquote>'
      ].join('\n')
    );
  }

  return `<aside class="annotation" data-clip="${escapeAttr(clip.id)}" data-color="${escapeAttr(clip.color)}">\n${blocks.join('\n')}\n</aside>`;
}

/**
 * Build the full Markdown string with all `<aside class="annotation" data-clip="...">`
 * blocks inserted at their exact (minimal-avoidance adjusted) offsets in the original Markdown.
 * AI reads this Markdown directly!
 */
export function buildAnnotatedMarkdown(
  baseMarkdown: string,
  clips: ClipAnnotation[],
  activePlaceholderClipId?: string
): string {
  if (clips.length === 0) return baseMarkdown;

  // Sort in descending offset order so earlier offsets remain valid as we splice
  const sorted = [...clips].sort((a, b) => b.offset - a.offset || b.createdAt - a.createdAt);

  let result = baseMarkdown;
  for (const clip of sorted) {
    const safe = resolveSafeOffset(baseMarkdown, clip.offset).offset;
    const asideHtml = serializeClipToAsideHtml(clip, activePlaceholderClipId);
    result = result.slice(0, safe) + asideHtml + result.slice(safe);
  }

  return result;
}

/**
 * Build the exact prompt required by AGENTS.md:
 * "发给 AI 的请求是 你是一个文档阅读助手，全文如下：... 其中把每个曲别针渲染成 HTML 关于对话的语义，
 * 就放置在曲别针处，如果用户刚刚输出的批注还没有回复，就往最后加个 AI 占位符。...
 * 最后告诉 AI，输出占位符处你的批注式回复。整个过程不用工具，也不用多轮对话。...
 * AI 不读 html，AI 只读 MarkDown.插入的曲别针可以是 html in origin markdown.
 * 要求 AI 以轻度格式的 HTML 回复，信息量要大。"
 */
export function buildAiPrompt(
  baseMarkdown: string,
  clips: ClipAnnotation[],
  targetClipId: string
): { prompt: string; annotatedMarkdown: string } {
  const annotatedMarkdown = buildAnnotatedMarkdown(baseMarkdown, clips, targetClipId);
  const prompt = `你是一个文档阅读助手，全文如下：

${annotatedMarkdown}

请输出占位符 <!--AI_REPLY_PLACEHOLDER--> 处你的批注式回复。要求以轻度格式的 HTML 回复（例如可使用 <p>、<ul>、<li>、<strong>、<code>、<em> 等标签，不要包裹 \`\`\`html 代码块，也不要包含外层 <blockquote> 或 <footer>），直接输出占位符处的 HTML 内容，信息量要大、深入透彻。`;

  return { prompt, annotatedMarkdown };
}

/**
 * Parse any existing `<aside class="annotation" data-clip="...">...</aside>` blocks
 * already embedded in a loaded Markdown file so re-opening annotated Markdown files works seamlessly.
 */
export function extractEmbeddedClipsFromMarkdown(rawMarkdown: string): {
  cleanMarkdown: string;
  clips: ClipAnnotation[];
} {
  const asideRegex = /<aside\s+class="annotation"\s+data-clip="([^"]+)"(?:\s+data-color="([^"]+)")?\s*>([\s\S]*?)<\/aside>/g;
  const clips: ClipAnnotation[] = [];
  let cleanMarkdown = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const palette = ['#d97757', '#4a7c59', '#3d6b99', '#8e5ea2', '#c28b38', '#b85450'];

  while ((match = asideRegex.exec(rawMarkdown)) !== null) {
    cleanMarkdown += rawMarkdown.slice(lastIndex, match.index);
    const clipOffset = cleanMarkdown.length;
    const clipId = match[1] || `clip-${clips.length + 1}`;
    const clipColor = match[2] || palette[clips.length % palette.length]!;
    const innerHtml = match[3] || '';

    const messages: ChatTurn[] = [];
    const bqRegex = /<blockquote>([\s\S]*?)<footer>\s*(用户|AI)\s*<\/footer>\s*<\/blockquote>/g;
    let bqMatch: RegExpExecArray | null;
    let turnIdx = 0;
    while ((bqMatch = bqRegex.exec(innerHtml)) !== null) {
      const bodyRaw = (bqMatch[1] || '').trim();
      const speaker = bqMatch[2];
      if (bodyRaw.includes('<!--AI_REPLY_PLACEHOLDER-->')) continue;
      if (speaker === '用户') {
        const pMatch = bodyRaw.match(/^<p>([\s\S]*?)<\/p>$/);
        const text = pMatch ? unescapeHtmlText(pMatch[1]!) : unescapeHtmlText(bodyRaw);
        messages.push({
          id: `${clipId}-m-${turnIdx++}`,
          role: 'user',
          content: text
        });
      } else {
        messages.push({
          id: `${clipId}-m-${turnIdx++}`,
          role: 'ai',
          content: bodyRaw
        });
      }
    }

    clips.push({
      id: clipId,
      color: clipColor,
      offset: clipOffset,
      anchorSnippet: getSnippetAround(cleanMarkdown, clipOffset),
      messages,
      createdAt: Date.now() + clips.length
    });

    lastIndex = match.index + match[0].length;
  }

  cleanMarkdown += rawMarkdown.slice(lastIndex);
  for (const clip of clips) {
    clip.anchorSnippet = getSnippetAround(cleanMarkdown, clip.offset);
  }

  return { cleanMarkdown, clips };
}

export function getSnippetAround(markdown: string, offset: number, radius = 28): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(markdown.length, offset + radius);
  const before = markdown.slice(start, offset).replace(/\s+/g, ' ').trim();
  const after = markdown.slice(offset, end).replace(/\s+/g, ' ').trim();
  const combined = `${before}📎${after}`.trim();
  return combined || '文档起始处';
}

/**
 * Rehype plugin that attaches `data-md-start` and `data-md-end` attributes to every HTML element
 * that has source position information from the Markdown AST, enabling accurate DOM-to-Markdown
 * character offset mapping during long-press!
 */
function rehypeSourceOffsets() {
  return (tree: Node) => {
    visit(tree, 'element', (rawNode: Node) => {
      const node = rawNode as PositionedNode;
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      node.properties = node.properties || {};
      if (typeof start === 'number') {
        node.properties['data-md-start'] = String(start);
      }
      if (typeof end === 'number') {
        node.properties['data-md-end'] = String(end);
      }
    });
  };
}

/**
 * Render Markdown to HTML with KaTeX math, GFM, syntax highlighting, and source offset annotations.
 */
export function renderMarkdownToHtml(baseMarkdown: string): {
  html: string;
  intervals: ForbiddenInterval[];
} {
  const intervals = getForbiddenIntervals(baseMarkdown);

  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSourceOffsets)
    .use(rehypeKatex)
    .use(rehypeHighlight, { detect: true, ignoreMissing: true })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .processSync(baseMarkdown);

  return {
    html: String(file),
    intervals
  };
}

function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeHtmlText(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
