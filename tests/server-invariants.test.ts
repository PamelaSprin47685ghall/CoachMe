import { expect, test } from 'bun:test';
import type { ReplyEvent } from '../src/lib/contracts';
import type { ChatTurn, ClipAnnotation } from '../src/lib/markdown';
import { createTestEnvironment } from './support/harness';
import { readCloudDocument } from './support/read-document';

const clip: ClipAnnotation = { id: 'test-clip', color: '#c85a32', offset: 0, anchorSnippet: '正文', createdAt: 1, messages: [] };

test('imported duplicate identifiers and invalid colors cannot create an unsynchronizable cloud document', async () => {
  const env = createTestEnvironment();
  try {
    const user = env.client(); await user.login('alice');
    const source = '<aside class="annotation" data-clip="same" data-color="invalid"><blockquote><p>第一处问题</p><footer>用户</footer></blockquote></aside>\n正文\n<aside class="annotation" data-clip="same"><blockquote><p>第二处问题</p><footer>用户</footer></blockquote></aside>';
    let document = await readCloudDocument(await user.request('/api/documents', 'POST', { name: 'duplicates.md', markdown: source }));
    expect(new Set(document.clips.map((entry) => entry.id)).size).toBe(2);
    expect(new Set(document.clips.flatMap((entry) => entry.messages.map((message) => message.id))).size).toBe(2);
    expect(document.clips.every((entry) => /^#[0-9a-f]{6}$/i.test(entry.color))).toBe(true);
    const path = `/api/documents/${document.id}`;
    const saved = await user.request(path, 'PUT', { revision: document.revision, clips: document.clips });
    expect(saved.status).toBe(200);
    document = await readCloudDocument(saved);
    const untouched = document.clips[1]!.messages;
    const response = await user.request(`${path}/reply`, 'POST', { revision: document.revision, clipId: document.clips[0]!.id, content: '继续第一处对话' });
    await response.text();
    const final = await readCloudDocument(await user.request(path));
    expect(final.clips[0]?.messages).toHaveLength(3);
    expect(final.clips[1]?.messages).toEqual(untouched);
  } finally { env.close(); }
});

test('expanded sanitized AI HTML is rejected before committing an unsavable snapshot', async () => {
  const env = createTestEnvironment();
  try {
    const user = env.client(); await user.login('alice');
    const document = await readCloudDocument(await user.request('/api/documents', 'POST', { name: 'expansion.md', markdown: '正文' }));
    const response = await user.request(`/api/documents/${document.id}`, 'PUT', {
      revision: document.revision,
      clips: [{ ...clip, messages: [{ id: 'oversized-after-escaping', role: 'ai', content: `<p>${'&'.repeat(19_990)}</p>` }] }]
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const unchanged = await readCloudDocument(await user.request(`/api/documents/${document.id}`));
    expect(unchanged.revision).toBe(document.revision);
    expect(unchanged.clips).toEqual([]);
  } finally { env.close(); }
});

test.each([199, 200])('a %i-message history cannot be pushed beyond the supported limit by a reply', async (count) => {
  const env = createTestEnvironment();
  try {
    const user = env.client(); await user.login('alice');
    let document = await readCloudDocument(await user.request('/api/documents', 'POST', { name: 'history-limit.md', markdown: '正文' }));
    const messages: ChatTurn[] = Array.from({ length: count }, (_, index) => ({
      id: `message-${index}`, role: index % 2 === 0 ? 'user' : 'ai', content: index % 2 === 0 ? '问题' : '<p>回复</p>'
    }));
    document = await readCloudDocument(await user.request(`/api/documents/${document.id}`, 'PUT', { revision: document.revision, clips: [{ ...clip, messages }] }));
    const response = await user.request(`/api/documents/${document.id}/reply`, 'POST', { revision: document.revision, clipId: clip.id, content: '容量边界问题' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const current = await readCloudDocument(await user.request(`/api/documents/${document.id}`));
    expect(current.clips[0]?.messages).toHaveLength(count);
    expect(current.revision).toBe(document.revision);
    expect(env.services.aiRequests).toEqual([]);
  } finally { env.close(); }
});

test.each(['empty', 'oversized'] as const)('%s upstream reply never persists a fake or future-unsavable AI turn', async (behavior) => {
  const env = createTestEnvironment();
  try {
    const user = env.client(); await user.login('alice');
    let document = await readCloudDocument(await user.request('/api/documents', 'POST', { name: 'bad-ai.md', markdown: '正文' }));
    document = await readCloudDocument(await user.request(`/api/documents/${document.id}`, 'PUT', { revision: document.revision, clips: [clip] }));
    env.services.setAIBehavior(behavior);
    const response = await user.request(`/api/documents/${document.id}/reply`, 'POST', { revision: document.revision, clipId: clip.id, content: '请回答我的问题' });
    const events = (await response.text()).split('\n\n').filter((part) => part.startsWith('data: ')).map((part) => JSON.parse(part.slice(6)) as ReplyEvent);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    const current = await readCloudDocument(await user.request(`/api/documents/${document.id}`));
    expect(current.clips[0]?.messages.map((message) => message.role)).toEqual(['user']);
    expect(current.clips[0]?.messages[0]?.content).toBe('请回答我的问题');
    expect((await user.request(`/api/documents/${document.id}`, 'PUT', { revision: current.revision, clips: current.clips })).status).toBe(200);
  } finally { env.close(); }
});

test('chunked JSON uploads are stopped at the byte bound instead of being buffered unboundedly', async () => {
  const env = createTestEnvironment();
  try {
    const user = env.client(); await user.login('alice');
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 100) controller.close();
        else controller.enqueue(new Uint8Array(64 * 1024).fill(32));
      },
      cancel() { cancelled = true; }
    });
    const response = await env.app.fetch(new Request(env.config.publicURL + '/api/documents', {
      method: 'POST',
      headers: { Origin: env.config.publicURL, Cookie: user.cookieHeader, 'X-CSRF-Token': user.csrfToken!, 'Content-Type': 'application/json' },
      body
    }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(100);
    const library = await (await user.request('/api/documents')).json() as { documents: unknown[] };
    expect(library.documents).toEqual([]);
  } finally { env.close(); }
});

test('accepted annotation snapshots stay below the sync transport budget, even after generated reasoning grows', async () => {
  const env = createTestEnvironment();
  try {
    const user = env.client(); await user.login('alice');
    let document = await readCloudDocument(await user.request('/api/documents', 'POST', { name: 'total-budget.md', markdown: '正文' }));
    const messages: ChatTurn[] = Array.from({ length: 31 }, (_, index) => ({
      id: `history-${index}`, role: 'ai', content: '<p>历史回答</p>', reasoning: 'R'.repeat(100_000)
    }));
    document = await readCloudDocument(await user.request(`/api/documents/${document.id}`, 'PUT', {
      revision: document.revision, clips: [{ ...clip, messages }]
    }));
    const path = `/api/documents/${document.id}`;
    const tooLarge = await user.request(path, 'PUT', {
      revision: document.revision,
      clips: [{ ...clip, messages: [...messages, { id: 'too-large', role: 'ai', content: '<p>多一条</p>', reasoning: 'R'.repeat(100_000) }] }]
    });
    expect(tooLarge.status).toBe(413);
    const rejectedSnapshot = await readCloudDocument(await user.request(path));
    expect(rejectedSnapshot.revision).toBe(document.revision);
    expect(rejectedSnapshot.clips[0]?.messages).toHaveLength(31);

    env.services.setAIBehavior('large-reasoning');
    const response = await user.request(`${path}/reply`, 'POST', {
      revision: document.revision, clipId: clip.id, content: '生成后也必须能继续同步'
    });
    const events = (await response.text()).split('\n\n').filter((part) => part.startsWith('data: ')).map((part) => JSON.parse(part.slice(6)) as ReplyEvent);
    expect(events.some((event) => event.type === 'error' && event.error.code === 'annotation_limit')).toBe(true);
    const current = await readCloudDocument(await user.request(path));
    expect(current.clips[0]?.messages).toHaveLength(32);
    expect(current.clips[0]?.messages.at(-1)?.role).toBe('user');
    expect((await user.request(path, 'PUT', { revision: current.revision, clips: current.clips })).status).toBe(200);
  } finally { env.close(); }
});

test('cancelled replies retain the saved question and release the document for a later conversation', async () => {
  const env = createTestEnvironment();
  try {
    const user = env.client(); await user.login('alice');
    let document = await readCloudDocument(await user.request('/api/documents', 'POST', { name: 'cancel.md', markdown: '正文' }));
    document = await readCloudDocument(await user.request(`/api/documents/${document.id}`, 'PUT', { revision: document.revision, clips: [clip] }));
    const path = `/api/documents/${document.id}`;
    env.services.setAIBehavior('hold');
    const interrupted = await user.request(`${path}/reply`, 'POST', { revision: document.revision, clipId: clip.id, content: '中断时保留的问题' });
    const reader = interrupted.body!.getReader();
    await reader.read();
    await env.services.waitForAIRequest();
    await reader.cancel();
    const savedQuestion = await readCloudDocument(await user.request(path));
    expect(savedQuestion.clips[0]?.messages.map((message) => message.role)).toEqual(['user']);
    expect(savedQuestion.clips[0]?.messages[0]?.content).toBe('中断时保留的问题');
    env.services.setAIBehavior('success');
    const resumed = await user.request(`${path}/reply`, 'POST', { revision: savedQuestion.revision, clipId: clip.id, content: '继续这个对话' });
    expect(resumed.status).toBe(200);
    await resumed.text();
    const final = await readCloudDocument(await user.request(path));
    expect(final.clips[0]?.messages.map((message) => message.role)).toEqual(['user', 'user', 'ai']);
    expect(final.clips[0]?.messages.filter((message) => message.content === '中断时保留的问题')).toHaveLength(1);
  } finally { env.close(); }
});
