import { createHash, randomUUID } from 'node:crypto';

export function createMockServices(port = 0) {
  const codes = new Map<string, { account: string; redirect: string; challenge: string }>();
  const tokens = new Map<string, string>();
  const aiRequests: Array<Record<string, unknown>> = [];
  const firstAIRequest = Promise.withResolvers<void>();
  let mode: 'success' | 'failure' | 'hold' | 'hold-after-reasoning' | 'empty' | 'oversized' | 'large-reasoning' = 'success';
  const pendingReplies = new Set<PromiseWithResolvers<void>>();
  let tokenExchanges = 0;
  let profileRequests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/authorize') {
        const redirect = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        const challenge = url.searchParams.get('code_challenge');
        if (!redirect || !state || !challenge || url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('scope') !== 'profile' || url.searchParams.get('client_id') !== 'test-client') {
          return new Response('Invalid authorization request', { status: 400 });
        }
        const account = url.searchParams.get('account');
        if (account !== 'alice' && account !== 'bob') {
          const alice = new URL(url); alice.searchParams.set('account', 'alice');
          const bob = new URL(url); bob.searchParams.set('account', 'bob');
          const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
          return new Response(`<!doctype html><html><head><title>OAuth protocol fixture</title></head><body><h1>OAuth protocol fixture — not Amazon</h1><p>Choose a test identity for the isolated suite.</p><a href="${escape(alice.href)}">Alice</a><br><a href="${escape(bob.href)}">Bob</a></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        const code = randomUUID();
        codes.set(code, { account, redirect, challenge });
        const callback = new URL(redirect);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        return Response.redirect(callback, 302);
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        tokenExchanges++;
        const body = new URLSearchParams(await request.text());
        const code = body.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
        if (!grant || body.get('grant_type') !== 'authorization_code' || body.get('client_id') !== 'test-client' || body.get('client_secret') !== 'test-secret' || body.get('redirect_uri') !== grant.redirect || challenge !== grant.challenge) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        const token = randomUUID();
        tokens.set(token, grant.account);
        return Response.json({ access_token: token, token_type: 'bearer', expires_in: 3600 });
      }
      if (url.pathname === '/profile') {
        profileRequests++;
        const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
        const account = tokens.get(token);
        if (!account) return Response.json({ error: 'invalid_token' }, { status: 401 });
        return Response.json({ user_id: `amazon-${account}`, name: account === 'alice' ? 'Alice' : 'Bob', email: `${account}@example.com` });
      }
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        if (request.headers.get('Authorization') !== 'Bearer test-ai-secret') {
          return Response.json({ error: { message: 'Authentication failed' } }, { status: 401 });
        }
        const body = await request.json() as Record<string, unknown>;
        aiRequests.push(body);
        if (mode === 'failure') return Response.json({ error: { message: 'private-provider-detail test-ai-secret', type: 'invalid_request_error' } }, { status: 400 });
        const behavior = mode;
        const gate = behavior === 'hold' || behavior === 'hold-after-reasoning' ? Promise.withResolvers<void>() : null;
        if (gate) pendingReplies.add(gate);
        firstAIRequest.resolve();
        const encoder = new TextEncoder();
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) => encoder.encode(`data: ${JSON.stringify({ id: 'fixture-reply', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              if (gate && behavior === 'hold') await gate.promise;
              controller.enqueue(chunk({
                role: 'assistant',
                reasoning_content: behavior === 'large-reasoning' ? 'R'.repeat(100_000) : '先阅读用户的批注，再结合全文与已有对话。'
              }));
              if (gate && behavior === 'hold-after-reasoning') await gate.promise;
              if (behavior === 'empty') {
                controller.enqueue(chunk({}, 'stop'));
              } else if (behavior === 'oversized') {
                controller.enqueue(chunk({ content: 'a'.repeat(20_001) }, 'stop'));
              } else {
                controller.enqueue(chunk({ content: '<p><strong>云端批注：</strong>' }));
                controller.enqueue(chunk({ content: '用户的问题已结合全文处理。</p><script>globalThis.__bad=1</script>' }, 'stop'));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } catch {
              // The browser may cancel a protocol test stream.
            } finally {
              if (gate) pendingReplies.delete(gate);
            }
          }
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.pathname === '/test/ai-requests') return Response.json(aiRequests);
      if (url.pathname === '/test/release-ai' && request.method === 'POST') {
        for (const reply of pendingReplies) reply.resolve();
        return Response.json({ released: true });
      }
      return new Response('Not found', { status: 404 });
    }
  });
  const origin = server.url.origin;
  return {
    origin,
    amazonEndpoints: { authorizationURL: `${origin}/authorize`, tokenURL: `${origin}/token`, profileURL: `${origin}/profile` },
    aiRequests,
    waitForAIRequest() { return firstAIRequest.promise; },
    get tokenExchanges() { return tokenExchanges; },
    get profileRequests() { return profileRequests; },
    setAIBehavior(value: typeof mode) {
      for (const reply of pendingReplies) reply.resolve();
      mode = value;
    },
    releaseAI() { for (const reply of pendingReplies) reply.resolve(); },
    close() { for (const reply of pendingReplies) reply.resolve(); server.stop(true); }
  };
}
