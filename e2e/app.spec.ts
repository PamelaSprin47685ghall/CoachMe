import { test, expect } from '@playwright/test';

test.describe('CoachMe Kami Markdown Annotation Reader', () => {
  test('renders Markdown, hides right panel by default, places paperclip on long-press with math minimal avoidance, and chats with OpenAI-compatible AI', async ({ page }) => {
    interface ChatCompletionPayload {
      messages?: Array<{ content?: string }>;
    }
    let capturedPrompt = '';

    // Intercept OpenAI-compatible /v1/chat/completions endpoint
    await page.route('**/v1/chat/completions', async (route) => {
      const postData = route.request().postDataJSON() as ChatCompletionPayload;
      capturedPrompt = postData.messages?.[0]?.content ?? '';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'chatcmpl-playwright-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<p><strong>AI 深度批注：</strong>质能方程与信息熵在此处保持了完整的 LaTeX 语法边界。</p><ul><li>最小避让原则生效</li><li>高信息密度 HTML 回复</li></ul>'
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
        })
      });
    });

    await page.goto('/');

    // 1. Default right panel is hidden
    await expect(page.getByTestId('markdown-rendered-body')).toBeVisible();
    await expect(page.getByTestId('right-annotation-panel')).toHaveCount(0);

    // 2. Configure custom baseURL and API key
    await page.getByTestId('open-settings-btn').click();
    await page.getByTestId('settings-baseurl-input').fill('http://127.0.0.1:5173/mock-openai/v1');
    await page.getByTestId('settings-apikey-input').fill('sk-playwright-key');
    await page.getByTestId('save-settings-btn').click();

    // 3. Long-press on an inline math formula (.katex) -> progressive 📎 -> places clip & opens right drawer
    const katexEl = page.locator('.katex').first();
    const box = await katexEl.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(180);
    await expect(page.getByTestId('longpress-ghost-clip')).toBeVisible();
    await page.waitForTimeout(450);
    await page.mouse.up();

    await expect(page.getByTestId('right-annotation-panel')).toBeVisible();
    await expect(page.locator('.clip-anchor-pin')).toHaveCount(1);

    // 4. Send user annotation and verify AI HTML reply + single-shot prompt format
    await page.getByTestId('annotation-input').fill('请详细剖析此公式的物理内涵');
    await page.getByTestId('send-annotation-btn').click();

    await expect(page.getByTestId('chat-turn-ai')).toBeVisible();
    await expect(page.getByTestId('chat-ai-html')).toContainText('AI 深度批注');

    const sentPrompt = capturedPrompt;
    expect(sentPrompt.startsWith('你是一个文档阅读助手，全文如下：')).toBe(true);
    expect(sentPrompt).toContain('<aside class="annotation"');
    expect(sentPrompt).toContain('<!--AI_REPLY_PLACEHOLDER-->');
    expect(sentPrompt).toContain('$E = mc^2$');

    // 5. Clicking blank document area hides right panel
    await page.locator('.kami-markdown-body h1').click();
    await expect(page.getByTestId('right-annotation-panel')).toHaveCount(0);

    // 6. Clicking placed paperclip re-opens its conversation
    await page.locator('.clip-anchor-pin').first().click();
    await expect(page.getByTestId('right-annotation-panel')).toBeVisible();
    await expect(page.getByTestId('chat-turn-user')).toContainText('请详细剖析此公式的物理内涵');
  });
});
