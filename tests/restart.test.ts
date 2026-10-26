import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ServerConfig } from '../server/config';
import { createTestEnvironment } from './support/harness';
import { readCloudDocument } from './support/read-document';

interface RestartWorker {
  child: Pick<Bun.Subprocess, 'kill' | 'exited'>;
  origin: string;
}

async function startWorker(config: ServerConfig, endpoints: object): Promise<RestartWorker> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'support/restart-worker.ts')], {
    env: { ...process.env, MARGINTALK_TEST_CONFIG: JSON.stringify(config), MARGINTALK_TEST_AMAZON_ENDPOINTS: JSON.stringify(endpoints) },
    stdout: 'pipe', stderr: 'pipe'
  });
  // Real child-process safety deadline only; readiness is signaled by stdout, never by sleeping.
  const startupTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const reader = child.stdout.getReader();
  let output = '';
  try {
    while (!output.includes('\n')) {
      const part = await reader.read();
      if (part.done) throw new Error(`Restart worker did not start: ${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(part.value);
    }
    const origin = output.split('\n')[0]!.trim();
    if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Unexpected worker origin');
    return { child, origin };
  } finally {
    clearTimeout(startupTimer);
    reader.releaseLock();
  }
}

test('a killed generation keeps its user turn and a new process immediately accepts annotation saves', async () => {
  const env = createTestEnvironment();
  let first: RestartWorker | null = null;
  let second: RestartWorker | null = null;
  try {
    const user = env.client(); await user.login('alice');
    let document = await readCloudDocument(await user.request('/api/documents', 'POST', { name: 'restart.md', markdown: '崩溃重启后继续阅读。' }));
    document = await readCloudDocument(await user.request(`/api/documents/${document.id}`, 'PUT', {
      revision: document.revision,
      clips: [{ id: 'restart-clip', color: '#c85a32', offset: 0, anchorSnippet: '重启', createdAt: 1, messages: [] }]
    }));
    env.app.close();
    env.services.setAIBehavior('hold');
    first = await startWorker(env.config, env.services.amazonEndpoints);
    const path = `/api/documents/${document.id}`;
    const headers = { Origin: env.config.publicURL, Cookie: user.cookieHeader, 'X-CSRF-Token': user.csrfToken!, 'Content-Type': 'application/json' };
    const response = await fetch(first.origin + path + '/reply', {
      method: 'POST', headers,
      body: JSON.stringify({ revision: document.revision, clipId: 'restart-clip', content: '重启时不要丢失这条提问' })
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const initial = await reader.read();
    const persistedEvent = JSON.parse(new TextDecoder().decode(initial.value).replace(/^data:\s*/, ''));
    expect(persistedEvent).toMatchObject({ type: 'document' });
    first.child.kill('SIGKILL');
    await first.child.exited;
    await reader.cancel().catch(() => undefined);
    env.services.releaseAI();
    second = await startWorker(env.config, env.services.amazonEndpoints);
    const restored = await readCloudDocument(await fetch(second.origin + path, { headers }));
    expect(restored.clips[0]?.messages.map((message) => message.role)).toEqual(['user']);
    expect(restored.clips[0]?.messages[0]?.content).toBe('重启时不要丢失这条提问');
    const save = await fetch(second.origin + path, {
      method: 'PUT', headers, body: JSON.stringify({ revision: restored.revision, clips: restored.clips })
    });
    expect(save.status).toBe(200);
    expect((await fetch(second.origin + path, { method: 'DELETE', headers })).status).toBe(200);
  } finally {
    if (first) { first.child.kill('SIGKILL'); await first.child.exited; }
    if (second) { second.child.kill('SIGKILL'); await second.child.exited; }
    env.close();
  }
}, 20_000);
