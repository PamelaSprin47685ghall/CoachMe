import { expect, test } from 'bun:test';
import { renderMarkdownToHtml } from '../src/lib/markdown';
import { normalizeAiHtmlReply } from '../server/ai';

test('untrusted Markdown cannot inject app overlays or scripts while math, code and task items keep rendering', () => {
  const source = '<div class="kami-modal-backdrop" style="position:fixed;inset:0;z-index:99999"><p>原文仍然可读</p></div>\n\n<script>globalThis.__bad=1</script>\n<img src="x" onerror="globalThis.__bad=2">\n\n$E = mc^2$\n\n```html\n<script>这是代码示例</script>\n```\n\n- [x] 完成阅读';
  const { html } = renderMarkdownToHtml(source);
  expect(html).toContain('原文仍然可读');
  expect(html).not.toContain('kami-modal-backdrop');
  expect(html).not.toContain('position:fixed');
  expect(html).not.toContain('onerror');
  expect(html).not.toContain('<script');
  expect(html).toContain('<math');
  expect(html).toContain('<annotation encoding="application/x-tex">E = mc^2</annotation>');
  expect(html).toContain('这是代码示例');
  expect(html).toContain('hljs-');
  const checkbox = html.match(/<input[^>]*>/)?.[0];
  expect(checkbox).toContain('type="checkbox"');
  expect(checkbox).toMatch(/\bdisabled\b/);
});

test('AI HTML cannot borrow app CSS classes or active URLs to impersonate account UI', () => {
  const html = normalizeAiHtmlReply('<div class="kami-modal-backdrop" style="position:fixed"><p>正常批注</p><a href="javascript:alert(1)">链接</a><script>globalThis.__bad=1</script></div>');
  expect(html).toContain('<p>正常批注</p>');
  expect(html).not.toContain('class=');
  expect(html).not.toContain('style=');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('<script');
});
