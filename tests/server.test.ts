import { expect, test } from 'bun:test';
import type { DocumentSummary, ReplyEvent, SessionInfo } from '../src/lib/contracts';
import type { ClipAnnotation } from '../src/lib/markdown';
import { createTestEnvironment } from './support/harness';
import { readCloudDocument } from './support/read-document';

const markdown = '# 云端阅读\n\n原文讨论如何在 AI 时代保持独立思考。';
const clip: ClipAnnotation = {
  id: 'clip-test', color: '#c85a32', offset: 8, anchorSnippet: '原文讨论', messages: [], createdAt: 1
};

function replyEvents(text: string): ReplyEvent[] {
  return text.split('\n\n').filter((part) => part.startsWith('data: ')).map((part) => JSON.parse(part.slice(6)) as ReplyEvent);
}

test('OAuth code exchange with PKCE establishes distinct persistent accounts and logout revokes the session', async () => {
  const env = createTestEnvironment();
  try {
    const anonymous = env.client();
    const initial = await (await anonymous.request('/api/session')).json() as SessionInfo;
    expect(initial.user).toBeNull();
    expect(initial.csrfToken).toBeNull();
    expect((await anonymous.request('/api/documents')).status).toBe(401);
    const alice = env.client();
    const bob = env.client();
    const aliceSession = await alice.login('alice');
    const bobSession = await bob.login('bob');
    expect(aliceSession.user?.name).toBe('Alice');
    expect(bobSession.user?.name).toBe('Bob');
    expect(aliceSession.user?.id).not.toBe(bobSession.user?.id);
    expect(env.services.tokenExchanges).toBe(2);
    expect(env.services.profileRequests).toBe(2);
    const publicSession = JSON.stringify(aliceSession);
    expect(publicSession).not.toContain('test-ai-secret');
    expect(publicSession).not.toContain('test-secret');
    env.restart();
    const restored = await (await alice.request('/api/session')).json() as SessionInfo;
    expect(restored.user?.id).toBe(aliceSession.user?.id);
    const oldCookie = alice.cookieHeader;
    expect((await alice.request('/api/logout', 'POST')).ok).toBe(true);
    expect((await alice.request('/api/documents', 'GET', undefined, { Cookie: oldCookie })).status).toBe(401);
    const loggedOut = await (await alice.request('/api/session')).json() as SessionInfo;
    expect(loggedOut.user).toBeNull();
  } finally { env.close(); }
});

test('uploading annotated Markdown restores history, stores revisions across restarts, lists and deletes cloud files', async () => {
  const env = createTestEnvironment();
  try {
    const alice = env.client(); await alice.login('alice');
    const imported = '# 导入\n\n正文<aside class="annotation">\n<blockquote><p>A &amp; B？</p><footer>用户</footer></blockquote>\n<blockquote><p>历史回答。</p><footer>AI</footer></blockquote>\n</aside>结束。';
    const upload = await alice.request('/api/documents', 'POST', { name: 'reading.md', markdown: imported });
    expect(upload.status).toBe(201);
    let document = await readCloudDocument(upload);
    expect(document.markdown).toBe('# 导入\n\n正文结束。');
    expect(document.clips[0]?.messages.map((message) => message.content)).toEqual(['A & B？', '<p>历史回答。</p>']);
    const importedClip = document.clips[0]!;
    const save = await alice.request(`/api/documents/${document.id}`, 'PUT', {
      revision: document.revision,
      clips: [...document.clips, { ...clip, id: 'clip-new', offset: document.markdown.length }]
    });
    expect(save.status).toBe(200);
    const saved = await readCloudDocument(save);
    expect(saved.revision).toBeGreaterThan(document.revision);
    document = saved;
    env.restart();
    const restored = await readCloudDocument(await alice.request(`/api/documents/${document.id}`));
    expect(restored.clips.map((entry) => entry.id)).toEqual([importedClip.id, 'clip-new']);
    const library = await (await alice.request('/api/documents')).json() as { documents: DocumentSummary[] };
    expect(library.documents.map((entry) => entry.id)).toEqual([document.id]);
    expect(library.documents[0]?.clipCount).toBe(2);
    expect((await alice.request(`/api/documents/${document.id}`, 'DELETE')).ok).toBe(true);
    expect((await alice.request(`/api/documents/${document.id}`)).status).toBe(404);
    const afterDeletion = await (await alice.request('/api/documents')).json() as { documents: unknown[] };
    expect(afterDeletion.documents).toEqual([]);
    env.restart();
    expect((await alice.request(`/api/documents/${document.id}`)).status).toBe(404);
  } finally { env.close(); }
});

test('another account cannot list, read, modify, delete or generate replies for an owned document', async () => {
  const env = createTestEnvironment();
  try {
    const alice = env.client(); await alice.login('alice');
    const bob = env.client(); await bob.login('bob');
    const document = await readCloudDocument(await alice.request('/api/documents', 'POST', { name: 'private.md', markdown }));
    const bobLibrary = await (await bob.request('/api/documents')).json() as { documents: unknown[] };
    expect(bobLibrary.documents).toEqual([]);
    const path = `/api/documents/${document.id}`;
    expect((await bob.request(path)).status).toBe(404);
    expect((await bob.request(path, 'PUT', { revision: document.revision, clips: [clip] })).status).toBe(404);
    expect((await bob.request(path, 'DELETE')).status).toBe(404);
    expect((await bob.request(`${path}/reply`, 'POST', { revision: document.revision, clipId: clip.id, content: '读取私有文件' })).status).toBe(404);
    expect((await alice.request(path)).status).toBe(200);
    expect(env.services.aiRequests).toEqual([]);
  } finally { env.close(); }
});

test('CSRF checks and strict request schemas prevent cross-origin mutation and arbitrary AI passthrough', async () => {
  const env = createTestEnvironment();
  try {
    const alice = env.client(); await alice.login('alice');
    const document = await readCloudDocument(await alice.request('/api/documents', 'POST', { name: 'private.md', markdown }));
    const path = `/api/documents/${document.id}`;
    expect((await alice.request(path, 'DELETE', undefined, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await alice.request(path, 'DELETE', undefined, { 'X-CSRF-Token': '' })).status).toBe(403);
    expect((await alice.request(path, 'PUT', { revision: document.revision, clips: [clip], ownerId: 'other' })).status).toBe(400);
    expect((await alice.request(`${path}/reply`, 'POST', { revision: document.revision, clipId: clip.id, content: '问题', baseURL: 'http://127.0.0.1/private', apiKey: 'client-key', prompt: 'client prompt', model: 'client-model' })).status).toBe(400);
    expect((await alice.request('/__margintalk_ai_proxy/v1/chat/completions', 'POST', {})).status).toBe(404);
    expect(env.services.aiRequests).toEqual([]);
    expect((await alice.request(path)).status).toBe(200);
  } finally { env.close(); }
});

test('OAuth state is browser-bound, one-time and HTTPS cookies are secure', async () => {
  const env = createTestEnvironment();
  try {
    const owner = env.client();
    const start = await owner.request('/auth/amazon');
    const authorization = new URL(start.headers.get('location')!);
    authorization.searchParams.set('account', 'alice');
    const provider = await fetch(authorization, { redirect: 'manual' });
    const callback = provider.headers.get('location')!;
    const stranger = env.client();
    expect((await stranger.request(callback)).headers.get('location')).toMatch(/\/\?auth_error=/);
    const strangerSession = await (await stranger.request('/api/session')).json() as SessionInfo;
    expect(strangerSession.user).toBeNull();
    expect(env.services.tokenExchanges).toBe(0);
    const wrongState = new URL(callback); wrongState.searchParams.set('state', 'incorrect');
    expect((await owner.request(wrongState.href)).headers.get('location')).toMatch(/\/\?auth_error=/);
    expect(env.services.tokenExchanges).toBe(0);
    const alice = env.client(); await alice.login('alice');
    const beforeReplay = env.services.tokenExchanges;
    expect((await alice.request(alice.lastCallback!, 'GET', undefined, { Cookie: alice.lastOAuthCookies })).headers.get('location')).toMatch(/\/\?auth_error=/);
    expect(env.services.tokenExchanges).toBe(beforeReplay);
    env.config.publicURL = 'https://margintalk.example.com'; env.restart();
    const secureStart = await env.app.fetch(new Request('https://margintalk.example.com/auth/amazon'));
    const cookie = secureStart.headers.getSetCookie().join(';');
    expect(cookie).toMatch(/\bHttpOnly\b/i);
    expect(cookie).toMatch(/\bSecure\b/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  } finally { env.close(); }
});

test('AI uses stored Markdown and dialogue, streams reasoning, persists sanitized replies and preserves unanswered turns on failure', async () => {
  const env = createTestEnvironment();
  try {
    const alice = env.client(); await alice.login('alice');
    let document = await readCloudDocument(await alice.request('/api/documents', 'POST', { name: 'chat.md', markdown }));
    document = await readCloudDocument(await alice.request(`/api/documents/${document.id}`, 'PUT', { revision: document.revision, clips: [clip] }));
    const path = `/api/documents/${document.id}`;
    const reply = await alice.request(`${path}/reply`, 'POST', { revision: document.revision, clipId: clip.id, content: '当前时代我们还需要思考吗？' });
    expect(reply.status).toBe(200);
    const events = replyEvents(await reply.text());
    expect(events.some((event) => event.type === 'reasoning' && event.delta.includes('用户的批注'))).toBe(true);
    const completed = events.find((event) => event.type === 'done');
    if (!completed || completed.type !== 'done') throw new Error('Reply did not finish');
    document = completed.document;
    expect(document.clips[0]?.messages.map((message) => message.role)).toEqual(['user', 'ai']);
    expect(document.clips[0]?.messages[0]?.content).toBe('当前时代我们还需要思考吗？');
    expect(document.clips[0]?.messages[1]?.content).toContain('云端批注');
    expect(document.clips[0]?.messages[1]?.content).not.toContain('<script');
    expect(document.clips[0]?.messages[1]?.reasoning).toContain('用户的批注');
    const request = env.services.aiRequests[0] as { model: string; messages: Array<{ content: string }>; tools?: unknown };
    expect(request.model).toBe('test-model');
    expect(request.messages[0]?.content).not.toMatch(/[<>"']/);
    expect(request.messages[0]?.content).toContain('当前时代我们还需要思考吗？');
    expect(request.messages[0]?.content).toContain('&lt;aside class=&quot;annotation&quot;&gt;');
    expect(request.tools).toBeUndefined();
    const followup = replyEvents(await (await alice.request(`${path}/reply`, 'POST', { revision: document.revision, clipId: clip.id, content: '如何实践？' })).text());
    const second = followup.find((event) => event.type === 'done');
    if (!second || second.type !== 'done') throw new Error('Follow-up did not finish');
    document = second.document;
    expect(document.clips[0]?.messages.map((message) => message.role)).toEqual(['user', 'ai', 'user', 'ai']);
    const secondRequest = env.services.aiRequests[1] as { messages: Array<{ content: string }> };
    expect(secondRequest.messages[0]?.content).toContain('当前时代我们还需要思考吗？');
    expect(secondRequest.messages[0]?.content).toContain('云端批注');
    expect(secondRequest.messages[0]?.content).toContain('如何实践？');
    env.services.setAIBehavior('failure');
    const failed = replyEvents(await (await alice.request(`${path}/reply`, 'POST', { revision: document.revision, clipId: clip.id, content: '失败时不要丢掉我的批注' })).text());
    expect(failed.some((event) => event.type === 'error')).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('test-ai-secret');
    expect(JSON.stringify(failed)).not.toContain('private-provider-detail');
    const persisted = await readCloudDocument(await alice.request(path));
    expect(persisted.clips[0]?.messages.at(-1)?.content).toBe('失败时不要丢掉我的批注');
    expect(persisted.clips[0]?.messages.filter((message) => message.role === 'ai')).toHaveLength(2);
  } finally { env.close(); }
});

test('revision conflicts and in-flight replies prevent losing another session’s annotation changes', async () => {
  const env = createTestEnvironment();
  try {
    const alice = env.client(); await alice.login('alice');
    let document = await readCloudDocument(await alice.request('/api/documents', 'POST', { name: 'concurrent.md', markdown }));
    const oldRevision = document.revision;
    const path = `/api/documents/${document.id}`;
    document = await readCloudDocument(await alice.request(path, 'PUT', { revision: document.revision, clips: [clip] }));
    expect((await alice.request(path, 'PUT', { revision: oldRevision, clips: [] })).status).toBe(409);
    env.services.setAIBehavior('hold');
    const response = await alice.request(`${path}/reply`, 'POST', { revision: document.revision, clipId: clip.id, content: '思考中的问题' });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    const latest = await readCloudDocument(await alice.request(path));
    expect((await alice.request(path, 'PUT', { revision: latest.revision, clips: [] })).status).toBe(409);
    expect((await alice.request(path, 'DELETE')).status).toBe(409);
    expect((await alice.request(`${path}/reply`, 'POST', { revision: latest.revision, clipId: clip.id, content: '并发问题' })).status).toBe(409);
    await env.services.waitForAIRequest();
    env.services.releaseAI();
    while (!(await reader.read()).done) { /* Consume completion so cleanup observes a settled request. */ }
    const final = await readCloudDocument(await alice.request(path));
    expect(final.clips[0]?.messages.map((message) => message.role)).toEqual(['user', 'ai']);
    expect((await alice.request(path, 'DELETE')).status).toBe(200);
  } finally { env.close(); }
});
