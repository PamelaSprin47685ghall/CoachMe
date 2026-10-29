import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DocumentSummary, SessionInfo } from '../src/lib/contracts';
import { readCloudDocument } from '../tests/support/read-document';

const origin = 'http://127.0.0.1:5174';
const uploadedMarkdown = '# 云端文档\n\n当前时代我们还需要思考吗？\n\n质能关系 $E = mc^2$ 保持完整。\n\n<script>globalThis.__bad = 2</script>\n<img src="invalid-image" onerror="globalThis.__bad = 3">';

async function login(page: Page, account: 'Alice' | 'Bob') {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-btn').click();
  await page.getByRole('link', { name: account, exact: true }).click();
  await page.waitForURL(origin + '/');
  await expect(page.getByTestId('open-library-btn')).toBeEnabled();
  if (await page.getByTestId('library-modal').isVisible()) {
    await page.getByTestId('close-library-btn').click();
  }
}

async function openCloudFile(page: Page, name: string) {
  await page.getByTestId('open-library-btn').click();
  const row = page.getByTestId('cloud-document-row').filter({ hasText: name });
  await row.getByTestId('open-cloud-document-btn').click();
  await expect(page.getByTestId('current-filename')).toContainText(name);
}

test('OAuth login, automatic upload, persistent conversations, multi-session sync, account isolation and file deletion', async ({ page, browser }) => {
  page.on('dialog', (dialog) => dialog.accept());
  const browserFetches: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'fetch' || request.resourceType() === 'xhr') browserFetches.push(request.url());
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('login-btn')).toBeVisible();
  await expect(page.getByTestId('right-annotation-panel')).toHaveCount(0);
  expect((await page.request.get('/api/documents')).status()).toBe(401);
  await login(page, 'Alice');
  await expect(page.getByTestId('settings-apikey-input')).toHaveCount(0);
  await expect(page.getByTestId('settings-baseurl-input')).toHaveCount(0);

  await page.getByTestId('markdown-file-input').setInputFiles({
    name: 'cloud-demo.md', mimeType: 'text/markdown', buffer: Buffer.from(uploadedMarkdown)
  });
  await expect(page.getByTestId('current-filename')).toContainText('cloud-demo.md');
  const library = await (await page.request.get('/api/documents')).json() as { documents: DocumentSummary[] };
  const documentId = library.documents.find((entry) => entry.name === 'cloud-demo.md')?.id;
  expect(documentId).toBeDefined();
  const path = `/api/documents/${documentId}`;
  expect(await page.evaluate(() => Reflect.get(globalThis, '__bad'))).toBeUndefined();

  const math = page.locator('.katex').first();
  await math.scrollIntoViewIfNeeded();
  const box = await math.boundingBox();
  if (!box) throw new Error('Rendered formula is not positioned');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('right-annotation-panel')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.clip-anchor-pin')).toHaveCount(1);
  await page.getByTestId('annotation-input').fill('当前时代我们还需要思考吗？');
  await page.getByTestId('send-annotation-btn').click();
  await expect(page.getByTestId('chat-ai-loading-reasoning')).toContainText('用户的批注');
  await page.request.post('http://127.0.0.1:3102/test/release-ai');
  await expect(page.getByTestId('chat-turn-user')).toHaveCount(1);
  await expect(page.getByTestId('chat-turn-ai')).toHaveCount(1);
  await expect(page.getByTestId('chat-ai-html')).toContainText('云端批注');
  expect(await page.evaluate(() => Reflect.get(globalThis, '__bad'))).toBeUndefined();
  let document = await readCloudDocument(await page.request.get(path));
  expect(document.clips[0]?.messages.map((message) => message.role)).toEqual(['user', 'ai']);

  await page.getByTestId('annotation-input').fill('如何落实到每天的阅读中？');
  await page.getByTestId('annotation-input').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(page.getByTestId('chat-turn-user')).toHaveCount(1);
  await page.getByTestId('annotation-input').press('Control+Enter');
  await expect(page.getByTestId('chat-ai-loading-reasoning')).toContainText('用户的批注');
  await page.request.post('http://127.0.0.1:3102/test/release-ai');
  await expect(page.getByTestId('chat-turn-ai')).toHaveCount(2);
  document = await readCloudDocument(await page.request.get(path));
  expect(document.clips[0]?.messages.map((message) => message.role)).toEqual(['user', 'ai', 'user', 'ai']);
  const vendorRequests = await (await page.request.get('http://127.0.0.1:3102/test/ai-requests')).json() as Array<{ messages: Array<{ content: string }> }>;
  expect(vendorRequests.at(-1)?.messages[0]?.content).not.toMatch(/[<>"']/);
  expect(vendorRequests.at(-1)?.messages[0]?.content).toContain('当前时代我们还需要思考吗？');
  expect(vendorRequests.at(-1)?.messages[0]?.content).toContain('如何落实到每天的阅读中？');
  expect(vendorRequests.at(-1)?.messages[0]?.content).toContain('云端批注');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('open-library-btn')).toBeVisible();
  if (await page.getByTestId('library-modal').isVisible()) await page.getByTestId('close-library-btn').click();
  await openCloudFile(page, 'cloud-demo.md');
  await page.locator('.clip-anchor-pin').click();
  await expect(page.getByTestId('chat-turn-user')).toHaveCount(2);
  await expect(page.getByTestId('chat-turn-ai')).toHaveCount(2);
  await page.getByTestId('close-drawer-btn').click();

  const bobContext = await browser.newContext({ baseURL: origin });
  const bobPage = await bobContext.newPage();
  const otherAliceContext = await browser.newContext({ baseURL: origin });
  const otherAlice = await otherAliceContext.newPage();
  otherAlice.on('dialog', (dialog) => dialog.accept());
  try {
    await login(bobPage, 'Bob');
    const bobLibrary = await (await bobPage.request.get('/api/documents')).json() as { documents: unknown[] };
    expect(bobLibrary.documents).toEqual([]);
    expect((await bobPage.request.get(path)).status()).toBe(404);
    await bobPage.getByTestId('open-library-btn').click();
    await expect(bobPage.getByTestId('cloud-document-row')).toHaveCount(0);

    await login(otherAlice, 'Alice');
    const session = await (await otherAlice.request.get('/api/session')).json() as SessionInfo;
    const current = await readCloudDocument(await otherAlice.request.get(path));
    const remoteClip = { id: 'clip-other-session', offset: current.markdown.length, color: '#3a6ea5', anchorSnippet: '其他会话批注', messages: [], createdAt: Date.now() };
    const synced = await otherAlice.request.put(path, {
      headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken! },
      data: { revision: current.revision, clips: [...current.clips, remoteClip] }
    });
    expect(synced.status()).toBe(200);
    await page.bringToFront();
    await expect(page.locator('.clip-anchor-pin')).toHaveCount(2, { timeout: 12000 });
    await otherAlice.getByTestId('open-library-btn').click();
    const row = otherAlice.getByTestId('cloud-document-row').filter({ hasText: 'cloud-demo.md' });
    await row.getByTestId('delete-cloud-document-btn').click();
    const confirm = otherAlice.getByTestId('confirm-delete-document-btn');
    if (await confirm.isVisible()) await confirm.click();
    await expect(row).toHaveCount(0);
    expect((await otherAlice.request.get(path)).status()).toBe(404);
    await page.bringToFront();
    await expect(page.locator('.clip-anchor-pin')).toHaveCount(0, { timeout: 12000 });
  } finally {
    await bobContext.close(); await otherAliceContext.close();
  }

  await page.getByTestId('open-account-btn').click();
  await page.getByTestId('logout-btn').click();
  await expect(page.getByTestId('login-btn')).toBeVisible();
  expect((await page.request.get('/api/documents')).status()).toBe(401);
  expect(browserFetches.every((url) => new URL(url).origin === origin)).toBe(true);
});
