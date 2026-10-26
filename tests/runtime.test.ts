import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeFetch } from '../runtime';
import { createTestEnvironment } from './support/harness';
import { readCloudDocument } from './support/read-document';

test('production serves only built public assets and never private server config or account database paths', async () => {
  const env = createTestEnvironment();
  const directory = mkdtempSync(join(tmpdir(), 'margintalk-static-'));
  const dist = join(directory, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>MarginTalk</title>');
  writeFileSync(join(dist, 'assets', 'app-hashed.js'), 'console.log("public");');
  writeFileSync(join(dist, '.env'), 'secret-in-dotfile');
  writeFileSync(join(directory, 'margintalk.config.toml'), 'private-server-secret');
  const handle = createRuntimeFetch(env.app.fetch, dist, 'https://reader.example.com');
  try {
    const html = await handle(new Request('https://reader.example.com/'));
    expect(html.status).toBe(200);
    expect(html.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(html.headers.get('Content-Security-Policy')).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(html.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const asset = await handle(new Request('https://reader.example.com/assets/app-hashed.js'));
    expect(asset.headers.get('Cache-Control')).toContain('immutable');
    const session = await handle(new Request('https://reader.example.com/api/session'));
    expect(session.headers.get('Cache-Control')).toBe('no-store');
    expect(await session.json()).toMatchObject({ user: null });
    for (const path of ['/assets', '/assets/', '/margintalk.config.toml', '/.env', '/%2e%2e%2fmargintalk.config.toml', '/..%5cmargintalk.config.toml', '/server/app.ts', '/data/margintalk.sqlite']) {
      const response = await handle(new Request(`https://reader.example.com${path}`));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('private-server-secret');
    }
  } finally {
    env.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production wrapper preserves SSE cache controls and exposes the persisted user turn before the provider responds', async () => {
  const env = createTestEnvironment();
  try {
    const user = env.client(); await user.login('alice');
    let document = await readCloudDocument(await user.request('/api/documents', 'POST', { name: 'stream.md', markdown: '正文' }));
    document = await readCloudDocument(await user.request(`/api/documents/${document.id}`, 'PUT', {
      revision: document.revision,
      clips: [{ id: 'stream-clip', color: '#c85a32', offset: 0, anchorSnippet: '正文', createdAt: 1, messages: [] }]
    }));
    env.services.setAIBehavior('hold');
    const handle = createRuntimeFetch(env.app.fetch, '/unused-static-root', env.config.publicURL);
    const response = await handle(new Request(`${env.config.publicURL}/api/documents/${document.id}/reply`, {
      method: 'POST',
      headers: { Origin: env.config.publicURL, Cookie: user.cookieHeader, 'X-CSRF-Token': user.csrfToken!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: document.revision, clipId: 'stream-clip', content: '请阅读这条批注' })
    }));
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Cache-Control')).toContain('no-transform');
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    const reader = response.body!.getReader();
    const first = await reader.read();
    const firstEvent = JSON.parse(new TextDecoder().decode(first.value).replace(/^data:\s*/, ''));
    expect(firstEvent).toMatchObject({ type: 'document', document: { id: document.id } });
    await env.services.waitForAIRequest();
    env.services.releaseAI();
    while (!(await reader.read()).done) { /* Finish the persisted reply before closing the test app. */ }
    const final = await readCloudDocument(await user.request(`/api/documents/${document.id}`));
    expect(final.clips[0]?.messages.map((message) => message.role)).toEqual(['user', 'ai']);
  } finally { env.close(); }
});
