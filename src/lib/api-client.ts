import type { ApiErrorBody, CloudDocument, DocumentSummary, ReplyEvent, SessionInfo } from './contracts';
import type { ChatTurn, ClipAnnotation } from './markdown';

/**
 * Same-origin cloud API client for MarginTalk SaaS.
 *
 * There is deliberately NO client-side AI configuration here: no base URL, no
 * API key, no model id and no arbitrary fetch proxy. The server owns AI
 * credentials and only exposes fixed, documented endpoints under `/api` and
 * `/auth`. Authentication is a HttpOnly session cookie; every mutation is
 * protected by the session-bound CSRF token returned from `/api/session`.
 *
 * Every response is validated at its own fixed boundary before it becomes a
 * typed value: a malformed 200 is an error, never an empty library or a
 * half-trusted document.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Present when the server could report its authoritative document state. */
  readonly document: CloudDocument | null;

  constructor(status: number, code: string, message: string, document?: CloudDocument | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.document = document ?? null;
  }

  get unauthorized(): boolean {
    return this.status === 401;
  }

  get conflict(): boolean {
    return this.status === 409;
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}

let csrfToken: string | null = null;

/** Remember the CSRF token delivered by `/api/session`; anything else clears it. */
export function setCsrfToken(token: unknown): void {
  csrfToken = typeof token === 'string' && token.trim() ? token.trim() : null;
}

function malformed(kind: string): ApiError {
  return new ApiError(502, `invalid_${kind}_response`, `云端返回的数据无效（${kind}），请刷新后重试。`);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredText(value: unknown, kind: string): string {
  const text = textOf(value);
  if (text === null) throw malformed(kind);
  return text;
}

function timeOf(value: unknown, kind: string): number {
  // Millisecond epochs: finite, non-negative, but not necessarily integral.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw malformed(kind);
  return value;
}

function integerOf(value: unknown, kind: string): number {
  // Revisions, clip counts and character offsets are non-negative integers.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw malformed(kind);
  return value;
}

function parseChatTurn(value: unknown, kind: string): ChatTurn {
  if (typeof value !== 'object' || value === null) throw malformed(kind);
  const turn = value as Record<string, unknown>;
  const role = turn.role;
  if (role !== 'user' && role !== 'ai') throw malformed(kind);
  const parsed: ChatTurn = {
    id: requiredText(turn.id, kind),
    role,
    content: requiredText(turn.content, kind)
  };
  const reasoning = textOf(turn.reasoning);
  if (reasoning !== null) parsed.reasoning = reasoning;
  if (typeof turn.pending === 'boolean') parsed.pending = turn.pending;
  return parsed;
}

function parseClip(value: unknown, kind: string): ClipAnnotation {
  if (typeof value !== 'object' || value === null) throw malformed(kind);
  const clip = value as Record<string, unknown>;
  if (!Array.isArray(clip.messages)) throw malformed(kind);
  return {
    id: requiredText(clip.id, kind),
    color: requiredText(clip.color, kind),
    offset: integerOf(clip.offset, kind),
    anchorSnippet: requiredText(clip.anchorSnippet, kind),
    messages: clip.messages.map((message) => parseChatTurn(message, kind)),
    createdAt: timeOf(clip.createdAt, kind)
  };
}

export function parseCloudDocument(value: unknown): CloudDocument {
  if (typeof value !== 'object' || value === null) throw malformed('document');
  const doc = value as Record<string, unknown>;
  if (!Array.isArray(doc.clips)) throw malformed('document');
  return {
    id: requiredText(doc.id, 'document'),
    name: requiredText(doc.name, 'document'),
    createdAt: timeOf(doc.createdAt, 'document'),
    updatedAt: timeOf(doc.updatedAt, 'document'),
    revision: integerOf(doc.revision, 'document'),
    clipCount: integerOf(doc.clipCount, 'document'),
    markdown: requiredText(doc.markdown, 'document'),
    clips: doc.clips.map((clip) => parseClip(clip, 'document'))
  };
}

function parseDocumentSummary(value: unknown): DocumentSummary {
  if (typeof value !== 'object' || value === null) throw malformed('documents');
  const summary = value as Record<string, unknown>;
  return {
    id: requiredText(summary.id, 'documents'),
    name: requiredText(summary.name, 'documents'),
    createdAt: timeOf(summary.createdAt, 'documents'),
    updatedAt: timeOf(summary.updatedAt, 'documents'),
    revision: integerOf(summary.revision, 'documents'),
    clipCount: integerOf(summary.clipCount, 'documents')
  };
}

/** Best-effort authoritative document carried by an error body; never fatal. */
function lenientDocument(value: unknown): CloudDocument | null {
  try {
    return parseCloudDocument(value);
  } catch {
    return null;
  }
}

/** Turn any non-2xx response into an `ApiError` with a safe, human-readable message. */
async function toApiError(response: Response): Promise<ApiError> {
  let code: string | null = null;
  let message: string | null = null;
  let document: CloudDocument | null = null;
  try {
    const body = await response.clone().json();
    const parsed = body as Partial<ApiErrorBody> | null;
    if (parsed && typeof parsed === 'object') {
      const err = parsed.error;
      if (err && typeof err === 'object') {
        code = textOf(err.code);
        message = textOf(err.message);
      }
      document = lenientDocument(parsed.document);
    }
  } catch {
    // Body was not JSON (proxy error page, empty body, …). Keep the generic message.
  }
  const fallbackMessage =
    response.status === 401
      ? '登录状态已失效，请重新登录。'
      : `请求失败（HTTP ${response.status}）`;
  return new ApiError(
    response.status,
    code ?? 'request_failed',
    message ?? fallbackMessage,
    document
  );
}

function mutationHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return headers;
}

/** Returns the parsed JSON body (`null` for empty/no-content), never a guessed shape. */
async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new ApiError(0, 'network_error', '网络连接失败，请检查网络后重试。');
  }
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return null;
  const body = await response.text();
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    throw malformed('body');
  }
}

function objectAtBoundary(payload: unknown, kind: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw malformed(kind);
  }
  return payload as Record<string, unknown>;
}

export async function fetchSession(): Promise<SessionInfo> {
  const payload = objectAtBoundary(await requestJson('/api/session'), 'session');
  const rawUser = payload.user;
  let user: SessionInfo['user'] = null;
  if (rawUser !== null && rawUser !== undefined) {
    if (typeof rawUser !== 'object') throw malformed('session');
    const account = rawUser as Record<string, unknown>;
    user = {
      id: requiredText(account.id, 'session'),
      name: textOf(account.name) ?? '已登录用户',
      email: typeof account.email === 'string' ? account.email : null
    };
  }
  if (typeof payload.authConfigured !== 'boolean' || typeof payload.aiConfigured !== 'boolean') {
    throw malformed('session');
  }
  const csrf = textOf(payload.csrfToken);
  setCsrfToken(csrf);
  return {
    user,
    csrfToken: csrf,
    authConfigured: payload.authConfigured,
    aiConfigured: payload.aiConfigured
  };
}

export async function logout(): Promise<void> {
  await requestJson('/api/logout', { method: 'POST', headers: mutationHeaders() });
  setCsrfToken(null);
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const payload = objectAtBoundary(await requestJson('/api/documents'), 'documents');
  if (!Array.isArray(payload.documents)) throw malformed('documents');
  return payload.documents.map(parseDocumentSummary);
}

/** Upload raw Markdown (with any embedded `<aside>` annotations); the server extracts clips. */
export async function createDocument(name: string, markdown: string): Promise<CloudDocument> {
  const payload = objectAtBoundary(
    await requestJson('/api/documents', {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ name, markdown })
    }),
    'document'
  );
  return parseCloudDocument(payload.document);
}

export async function getDocument(id: string): Promise<CloudDocument> {
  const payload = objectAtBoundary(
    await requestJson(`/api/documents/${encodeURIComponent(id)}`),
    'document'
  );
  return parseCloudDocument(payload.document);
}

/** Whole annotation snapshot, guarded by the client-known monotonic revision. */
export async function updateDocument(
  id: string,
  revision: number,
  clips: ClipAnnotation[]
): Promise<CloudDocument> {
  const payload = objectAtBoundary(
    await requestJson(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify({ revision, clips })
    }),
    'document'
  );
  return parseCloudDocument(payload.document);
}

export async function deleteDocument(id: string): Promise<void> {
  await requestJson(`/api/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: mutationHeaders()
  });
}

/** Validate one decoded SSE `data:` payload against the documented reply protocol. */
export function parseReplyEvent(data: string): ReplyEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new ApiError(502, 'invalid_stream_event', 'AI 回复流数据无效，请重试。');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ApiError(502, 'invalid_stream_event', 'AI 回复流数据无效，请重试。');
  }
  const event = payload as Record<string, unknown>;
  const badEvent = () => new ApiError(502, 'invalid_stream_event', 'AI 回复流数据无效，请重试。');

  switch (event.type) {
    case 'document': {
      let document: CloudDocument;
      try {
        document = parseCloudDocument(event.document);
      } catch {
        throw badEvent();
      }
      const prompt = textOf(event.prompt);
      if (prompt === null) throw badEvent();
      return { type: 'document', document, prompt };
    }
    case 'reasoning':
    case 'text': {
      const delta = textOf(event.delta);
      if (delta === null) throw badEvent();
      return { type: event.type, delta };
    }
    case 'done': {
      try {
        return { type: 'done', document: parseCloudDocument(event.document) };
      } catch {
        throw badEvent();
      }
    }
    case 'error': {
      const err = event.error;
      if (typeof err !== 'object' || err === null) throw badEvent();
      const fields = err as Record<string, unknown>;
      const code = textOf(fields.code) ?? 'reply_failed';
      const message = textOf(fields.message) ?? 'AI 批注生成失败，请重试。';
      const document = event.document === undefined || event.document === null
        ? undefined
        : lenientDocument(event.document);
      return document === undefined || document === null
        ? { type: 'error', error: { code, message } }
        : { type: 'error', error: { code, message }, document };
    }
    default:
      throw badEvent();
  }
}

/**
 * Ask the server to append one user turn and stream the AI reply as SSE.
 *
 * The server is authoritative for the user turn: it persists the turn and then
 * emits a `document` event, so callers must NOT append a local user message.
 * Frames are split incrementally for both LF and CRLF terminators, unknown or
 * malformed data aborts the stream, and reaching EOF without a terminal `done`
 * / `error` event is an error rather than a silent success. Aborting is the
 * caller's cancellation and always resolves quietly.
 */
export async function streamReply(params: {
  documentId: string;
  revision: number;
  clipId: string;
  content: string;
  signal: AbortSignal;
  onEvent: (event: ReplyEvent) => void;
}): Promise<void> {
  const { documentId, revision, clipId, content, signal, onEvent } = params;

  let response: Response;
  try {
    response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/reply`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: mutationHeaders(),
      body: JSON.stringify({ revision, clipId, content }),
      signal
    });
  } catch {
    if (signal.aborted) return;
    throw new ApiError(0, 'network_error', '无法连接云端回复服务，请稍后重试。');
  }

  if (!response.ok) throw await toApiError(response);
  if (!response.body) throw new ApiError(501, 'stream_unsupported', '当前浏览器不支持流式回复。');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let carriedCR = false;
  let terminal = false;
  let reachedEnd = false;

  // One frame can carry several `data:` lines; SSE comment lines (`: ping`) are
  // keep-alive framing. Anything else that is not valid JSON or not a known
  // ReplyEvent aborts the stream instead of being skipped.
  const dispatchFrame = (frame: string): void => {
    for (const line of frame.split('\n')) {
      if (!line) continue;
      if (line.startsWith(':')) continue;
      if (!line.startsWith('data:')) {
        throw new ApiError(502, 'invalid_stream_frame', 'AI 回复流格式无效，请重试。');
      }
      const data = line.slice('data:'.length).trim();
      if (!data) continue;
      const event = parseReplyEvent(data);
      if (event.type === 'done' || event.type === 'error') terminal = true;
      onEvent(event);
      if (terminal) return;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      if (signal.aborted) return;
      let chunk: string = (carriedCR ? '\r' : '') + decoder.decode(value, { stream: true });
      carriedCR = chunk.endsWith('\r');
      if (carriedCR) chunk = chunk.slice(0, -1);
      chunk = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      buffer += chunk;
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (frame.trim()) dispatchFrame(frame);
        if (terminal) break;
        separator = buffer.indexOf('\n\n');
      }
      if (terminal) break;
    }
    if (!terminal) {
      const tail = (carriedCR ? '\r' : '') + decoder.decode();
      buffer += tail.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (buffer.trim()) dispatchFrame(buffer);
    }
  } catch (err) {
    if (signal.aborted) return;
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, 'stream_interrupted', 'AI 回复连接中断，请重试。');
  } finally {
    if (!reachedEnd) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original error when cancellation of an already-failed body also fails.
      }
    }
    reader.releaseLock();
  }

  if (signal.aborted) return;
  if (!terminal) {
    throw new ApiError(0, 'stream_incomplete', 'AI 回复连接已结束但未完成，请检查已保存的批注后再继续。');
  }
}
