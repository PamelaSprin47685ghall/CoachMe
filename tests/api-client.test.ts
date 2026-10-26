import { expect, spyOn, test } from 'bun:test';
import { getDocument, listDocuments, setCsrfToken, streamReply } from '../src/lib/api-client';
import type { CloudDocument, ReplyEvent } from '../src/lib/contracts';

const document: CloudDocument = {
  id: 'doc-stream', name: 'stream.md', markdown: '正文', revision: 2, createdAt: 1, updatedAt: 2, clipCount: 1,
  clips: [{ id: 'clip-stream', color: '#c85a32', offset: 0, anchorSnippet: '正文', createdAt: 1, messages: [{ id: 'user-1', role: 'user', content: '用户已经提问' }] }]
};

const replyParams = { documentId: document.id, revision: document.revision, clipId: 'clip-stream', content: '用户已经提问', signal: new AbortController().signal };
const preconnect = globalThis.fetch.preconnect;

function fetchRespondingWith(response: () => Response): typeof fetch {
  return Object.assign(async () => response(), { preconnect });
}

test('SSE decoding preserves multibyte reasoning and dialogue across byte-sized CRLF fragments', async () => {
  const final: CloudDocument = { ...document, revision: 3, clips: [{ ...document.clips[0]!, messages: [...document.clips[0]!.messages, { id: 'ai-1', role: 'ai', content: '<p>完整回答</p>' }] }] };
  const wire: ReplyEvent[] = [
    { type: 'document', document, prompt: '转义后的全文' },
    { type: 'reasoning', delta: '思考📎中文' },
    { type: 'text', delta: '<p>完整回答</p>' },
    { type: 'done', document: final }
  ];
  const bytes = new TextEncoder().encode(': keep-alive\r\n\r\n' + wire.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(offset, ++offset));
  } });
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchRespondingWith(() => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
  const events: ReplyEvent[] = [];
  try {
    await streamReply({ ...replyParams, onEvent: (event) => events.push(event) });
    expect(events).toEqual(wire);
  } finally { request.mockRestore(); setCsrfToken(null); }
});

test('an interrupted stream retains received user state but is never reported as a completed AI reply', async () => {
  const body = `data: ${JSON.stringify({ type: 'document', document, prompt: '全文' })}\n\ndata: ${JSON.stringify({ type: 'reasoning', delta: '尚未完成' })}\n\n`;
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchRespondingWith(() => new Response(body)));
  const events: ReplyEvent[] = [];
  try {
    await expect(streamReply({ ...replyParams, onEvent: (event) => events.push(event) })).rejects.toMatchObject({ code: 'stream_incomplete' });
    expect(events.map((event) => event.type)).toEqual(['document', 'reasoning']);
  } finally { request.mockRestore(); setCsrfToken(null); }
});

test('malformed stream data cancels the body instead of leaving an unread generation running', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {invalid-json}\n\n')); },
    cancel() { cancelled = true; }
  });
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchRespondingWith(() => new Response(body)));
  const events: ReplyEvent[] = [];
  try {
    await expect(streamReply({ ...replyParams, onEvent: (event) => events.push(event) })).rejects.toMatchObject({ code: 'invalid_stream_event' });
    expect(events).toEqual([]);
    expect(cancelled).toBe(true);
  } finally { request.mockRestore(); setCsrfToken(null); }
});

test('malformed successful JSON cannot become an empty library or a half-trusted document', async () => {
  let body: unknown = { documents: 'invalid' };
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchRespondingWith(() => Response.json(body)));
  try {
    await expect(listDocuments()).rejects.toMatchObject({ code: 'invalid_documents_response' });
    body = { document: { id: 'looks-real', markdown: '正文' } };
    await expect(getDocument('looks-real')).rejects.toMatchObject({ code: 'invalid_document_response' });
  } finally { request.mockRestore(); setCsrfToken(null); }
});
