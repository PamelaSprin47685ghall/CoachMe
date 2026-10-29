import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:5174';

test('encyclopedia drafting: left sidebar, auto-close, live stream on reader, then annotate', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-btn').click();
  await page.getByRole('link', { name: 'Alice', exact: true }).click();
  await page.waitForURL(origin + '/');
  await expect(page.getByTestId('open-library-btn')).toBeEnabled();
  if (await page.getByTestId('library-modal').isVisible()) await page.getByTestId('close-library-btn').click();

  // Opening Markdown now lives in the cloud library.
  await page.getByTestId('open-library-btn').click();
  await expect(page.getByTestId('library-modal').getByTestId('open-file-btn')).toBeVisible();
  await page.getByTestId('close-library-btn').click();

  // Desktop: the left sidebar takes space and reflows the reader.
  const readerBefore = await page.getByTestId('left-reader-pane').boundingBox();
  await page.getByTestId('open-wiki-btn').click();
  const panel = page.getByTestId('left-wiki-panel');
  await expect(panel).toBeVisible();
  const readerAfter = await page.getByTestId('left-reader-pane').boundingBox();
  const panelBox = await panel.boundingBox();
  expect(panelBox!.x).toBeLessThan(5);
  expect(readerAfter!.x).toBeGreaterThan(readerBefore!.x + 200);

  const input = page.getByTestId('wiki-prompt-input');
  await input.fill('量子纠缠');
  await input.press('Enter'); // newline, not send
  await expect(panel).toBeVisible();
  await input.type('侧重历史');
  await input.press('Control+Enter');

  await expect(panel).toHaveCount(0); // auto-closed
  await expect(page.getByTestId('wiki-live-reasoning')).toContainText('先阅读');
  await expect(page.getByTestId('markdown-rendered-body')).toBeHidden();
  await page.request.post('http://127.0.0.1:3102/test/release-ai');

  await expect(page.getByTestId('wiki-live')).toHaveCount(0);
  await expect(page.getByTestId('current-filename')).toContainText('量子纠缠');
  await expect(page.getByTestId('markdown-rendered-body')).toBeVisible();
  await expect(page.getByTestId('markdown-rendered-body')).toContainText('云端批注');
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync-state', 'clean');
  expect(await page.evaluate(() => Reflect.get(globalThis, '__bad'))).toBeUndefined();

  // Empty input + 「AI」 button: the AI annotates on its own, no blank user bubble; one reply per press.
  const para = page.getByTestId('markdown-rendered-body').locator('p').first();
  const box = await para.boundingBox();
  if (!box) throw new Error('paragraph not positioned');
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('right-annotation-panel')).toBeVisible();
  await page.mouse.up();
  const aiBtn = page.getByTestId('send-annotation-btn');
  await expect(page.getByTestId('annotation-input')).toHaveValue('');
  await expect(aiBtn).toBeEnabled();
  await expect(aiBtn.locator('.ai-glyph')).toHaveText('AI');
  await aiBtn.click();
  await expect(page.getByTestId('chat-ai-loading-reasoning')).toContainText('先阅读');
  await page.request.post('http://127.0.0.1:3102/test/release-ai');
  await expect(page.getByTestId('chat-turn-ai')).toHaveCount(1);
  await page.getByTestId('annotation-input').focus();
  await page.keyboard.press('Control+Enter'); // empty Ctrl+Enter behaves like the button
  await expect(page.getByTestId('chat-ai-loading')).toBeVisible();
  await page.request.post('http://127.0.0.1:3102/test/release-ai');
  await expect(page.getByTestId('chat-turn-ai')).toHaveCount(2);
  await expect(page.getByTestId('chat-turn-user')).toHaveCount(0);
  const requests = await (await page.request.get('http://127.0.0.1:3102/test/ai-requests')).json() as Array<{ messages: Array<{ content: string }> }>;
  expect(requests.at(-1)?.messages[0]?.content).toContain('AI_REPLY_PLACEHOLDER');
  // A typed annotation clears the composer immediately on send.
  await page.getByTestId('annotation-input').fill('请补充一个反例 ');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('annotation-input')).toHaveValue('');
  await expect(page.getByTestId('chat-ai-loading')).toBeVisible();
  await page.request.post('http://127.0.0.1:3102/test/release-ai');
  await expect(page.getByTestId('chat-turn-ai')).toHaveCount(3);
  await expect(page.getByTestId('chat-turn-user')).toHaveCount(1);
  await expect(page.getByTestId('annotation-input')).toHaveValue('');
  await page.screenshot({ path: '/tmp/wiki-desktop.png' });
  await page.getByTestId('close-drawer-btn').click();

  // Mobile: the same drawer is an overlay with a backdrop.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('open-wiki-btn').click();
  await expect(page.getByTestId('mobile-wiki-backdrop')).toBeVisible();
  await expect(page.getByTestId('wiki-prompt-input')).toHaveValue('');
  const mobileBox = await page.getByTestId('left-wiki-panel').boundingBox();
  expect(mobileBox!.x).toBeLessThan(2);
  expect(mobileBox!.width).toBeGreaterThan(300);
  await page.screenshot({ path: '/tmp/wiki-mobile.png' });
  await page.getByTestId('mobile-wiki-backdrop').click({ position: { x: 380, y: 400 } });
  await expect(page.getByTestId('left-wiki-panel')).toHaveCount(0);
});
