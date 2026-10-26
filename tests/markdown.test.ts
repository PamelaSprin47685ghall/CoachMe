import { describe, expect, test } from 'bun:test';
import {
  resolveSafeOffset,
  serializeClipToAsideHtml,
  buildAiPrompt,
  extractEmbeddedClipsFromMarkdown,
  type ClipAnnotation
} from '../src/lib/markdown';

describe('Markdown minimal avoidance & annotation serialization', () => {
  test('never splits inline math $...$ or block math $$...$$ (minimal avoidance principle)', () => {
    const md = 'Before formula $E = mc^2$ and block:\n\n$$\nH(X) = -\\sum P(x) \\log P(x)\n$$\n\nAfter.';
    const inlineStart = md.indexOf('$E = mc^2$');
    const inlineEnd = inlineStart + '$E = mc^2$'.length;

    // Attempt to place inside "$E = " (closer to start)
    const nearLeft = resolveSafeOffset(md, inlineStart + 2);
    expect(nearLeft.adjusted).toBe(true);
    expect(nearLeft.offset).toBe(inlineStart);

    // Attempt to place inside "mc^2$" (closer to end)
    const nearRight = resolveSafeOffset(md, inlineEnd - 2);
    expect(nearRight.adjusted).toBe(true);
    expect(nearRight.offset).toBe(inlineEnd);

    // Block math check
    const blockStart = md.indexOf('$$');
    const blockEnd = md.lastIndexOf('$$') + 2;
    const midBlock = resolveSafeOffset(md, blockStart + 10);
    expect(midBlock.adjusted).toBe(true);
    expect(midBlock.offset === blockStart || midBlock.offset === blockEnd).toBe(true);
  });

  test('never splits inline code or fenced code blocks', () => {
    const md = 'Call `resolveSafeOffset(md, offset)` in code.';
    const codeStart = md.indexOf('`resolveSafeOffset');
    const codeEnd = md.indexOf('`', codeStart + 1) + 1;

    const insideCode = resolveSafeOffset(md, codeStart + 4);
    expect(insideCode.adjusted).toBe(true);
    expect(insideCode.offset).toBe(codeStart);

    const insideCodeRight = resolveSafeOffset(md, codeEnd - 3);
    expect(insideCodeRight.adjusted).toBe(true);
    expect(insideCodeRight.offset).toBe(codeEnd);
  });

  test('serializes clip to exact <aside class="annotation" data-clip="..."> format with <!--AI_REPLY_PLACEHOLDER-->', () => {
    const clip: ClipAnnotation = {
      id: 'clip-1',
      color: '#d9534f',
      offset: 6,
      anchorSnippet: 'Hello 📎world',
      createdAt: 1000,
      messages: [
        { id: 'm1', role: 'user', content: '为什么这里使用质能方程？' }
      ]
    };

    const html = serializeClipToAsideHtml(clip, 'clip-1');
    expect(html).toContain('<aside class="annotation" data-clip="clip-1"');
    expect(html).toContain('<blockquote>\n    <p>为什么这里使用质能方程？</p>\n    <footer>用户</footer>\n  </blockquote>');
    expect(html).toContain('<blockquote>\n    <!--AI_REPLY_PLACEHOLDER-->\n    <footer>AI</footer>\n  </blockquote>');
    expect(html).toContain('</aside>');
  });

  test('builds AI prompt with full markdown, embedded <aside>, and instructions without breaking math', () => {
    const md = '爱因斯坦提出了 $E = mc^2$ 质能方程。';
    const formulaIdx = md.indexOf('$E = mc^2$');
    // Suppose raw offset was right in the middle of $E = mc^2$
    const safeOffset = resolveSafeOffset(md, formulaIdx + 3).offset;

    const clip: ClipAnnotation = {
      id: 'clip-math',
      color: '#2e7d5b',
      offset: safeOffset,
      anchorSnippet: '提出了 📎$E = mc^2$',
      createdAt: 1000,
      messages: [
        { id: 'u1', role: 'user', content: '请推导这个公式的物理意义' }
      ]
    };

    const { prompt, annotatedMarkdown } = buildAiPrompt(md, [clip], 'clip-math');
    expect(prompt.startsWith('你是一个文档阅读助手，全文如下：')).toBe(true);
    expect(annotatedMarkdown).toContain('$E = mc^2$'); // Formula remains intact!
    expect(annotatedMarkdown).toContain('<!--AI_REPLY_PLACEHOLDER-->');
    expect(prompt).toContain('输出占位符');

    // Also verify round-trip extraction
    const extracted = extractEmbeddedClipsFromMarkdown(annotatedMarkdown);
    expect(extracted.cleanMarkdown).toBe(md);
    expect(extracted.clips.length).toBe(1);
    expect(extracted.clips[0]?.messages[0]?.content).toBe('请推导这个公式的物理意义');
  });
});
