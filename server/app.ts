import { AnnotationCapacityError, DatabaseStore } from './db';
import type { ServerConfig } from './config';
import type {
  AccountUser,
  ApiErrorBody,
  CloudDocument,
  DocumentSummary,
  ReplyEvent,
  SessionInfo
} from '../src/lib/contracts';
import {
  buildAiPrompt,
  extractEmbeddedClipsFromMarkdown,
  type ClipAnnotation,
  type ChatTurn
} from '../src/lib/markdown';
import {
  streamAiAnnotationReply,
  normalizeAiHtmlReply,
  MAX_CONTENT_LENGTH,
  MAX_REASONING_LENGTH
} from './ai';

export interface AppDependencies {
  fetch?: typeof fetch;
  amazonEndpoints?: {
    authorizationURL: string;
    tokenURL: string;
    profileURL: string;
  };
}

export interface AppInstance {
  fetch: (req: Request) => Promise<Response>;
  close: () => void;
  db: DatabaseStore;
}

const OFFICIAL_AMAZON_ENDPOINTS = {
  authorizationURL: 'https://www.amazon.com/ap/oa',
  tokenURL: 'https://api.amazon.com/auth/o2/token',
  profileURL: 'https://api.amazon.com/user/profile'
};

const SESSION_COOKIE_NAME = 'mt_session';
const OAUTH_COOKIE_NAME = 'mt_oauth_browser';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const MAX_DOCUMENT_NAME_LENGTH = 200;
const MAX_MARKDOWN_LENGTH = 2_000_000;
const MAX_CLIPS_COUNT = 500;
const MAX_MESSAGES_PER_CLIP = 200;
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const DEFAULT_PALETTE = ['#d97757', '#4a7c59', '#3d6b99', '#8e5ea2', '#c28b38', '#b85450'];

const ALLOWED_CLIP_KEYS: Record<string, true> = {
  id: true,
  color: true,
  offset: true,
  anchorSnippet: true,
  messages: true,
  createdAt: true
};

const ALLOWED_MSG_KEYS: Record<string, true> = {
  id: true,
  role: true,
  content: true,
  reasoning: true,
  pending: true
};

// --- Crypto helpers ---

function randomBase64Url(byteCount = 32): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256Base64Url(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return toBase64Url(hashBuffer);
}

// --- Cookie helpers ---

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  const pairs = header.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const rawVal = pair.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(rawVal);
      } catch {
        cookies[key] = rawVal;
      }
    }
  }
  return cookies;
}

function serializeCookie(name: string, val: string, options: {
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  secure?: boolean;
  path?: string;
}): string {
  const parts: string[] = [`${name}=${encodeURIComponent(val)}`];
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

// --- Response helpers ---

function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

function errorResponse(status: number, code: string, message: string, document?: CloudDocument): Response {
  const body: ApiErrorBody = {
    error: { code, message },
    ...(document ? { document } : {})
  };
  return jsonResponse(body, status);
}

export function createApp(config: ServerConfig, dependencies: AppDependencies = {}): AppInstance {
  const db = new DatabaseStore(config.databasePath);
  const customFetch = dependencies.fetch ?? fetch;
  const amazonEndpoints = dependencies.amazonEndpoints ?? OFFICIAL_AMAZON_ENDPOINTS;

  const publicUrlParsed = new URL(config.publicURL);
  const publicOrigin = publicUrlParsed.origin;
  const isHttps = publicUrlParsed.protocol === 'https:';

  const isAuthConfigured = Boolean(
    config.amazon.clientId.trim() && config.amazon.clientSecret.trim()
  );
  const isAiConfigured = Boolean(
    config.ai.baseURL.trim() && config.ai.apiKey.trim() && config.ai.model.trim()
  );

  let isAppClosed = false;
  const activeInstanceTokens = new Map<string, string>(); // documentId -> token
  const activeAbortControllers = new Set<AbortController>();

  async function resolveSession(req: Request): Promise<{ user: AccountUser; csrfToken: string; tokenHash: string } | null> {
    const cookies = parseCookies(req.headers.get('cookie'));
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) return null;

    const tokenHash = await sha256Base64Url(token);
    const session = db.getSession(tokenHash);
    if (!session) return null;

    return {
      user: session.user,
      csrfToken: session.csrfToken,
      tokenHash
    };
  }

  function verifyMutationOrigin(req: Request): boolean {
    const origin = req.headers.get('origin');
    if (!origin) return false;
    return origin.toLowerCase() === publicOrigin.toLowerCase();
  }

  function verifyCsrf(req: Request, sessionCsrfToken: string): boolean {
    const headerToken = req.headers.get('x-csrf-token');
    return Boolean(headerToken && headerToken === sessionCsrfToken);
  }

  async function readStrictJson(req: Request): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_JSON_BODY_BYTES) {
      return { ok: false, response: errorResponse(413, 'payload_too_large', 'Request payload exceeds 4MiB limit') };
    }

    if (!req.body) {
      return { ok: false, response: errorResponse(400, 'missing_body', 'Request body is required') };
    }

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_JSON_BODY_BYTES) {
            await reader.cancel('payload_too_large');
            return { ok: false, response: errorResponse(413, 'payload_too_large', 'Request payload exceeds 4MiB limit') };
          }
          chunks.push(value);
        }
      }
    } catch {
      return { ok: false, response: errorResponse(400, 'read_error', 'Failed to read request body stream') };
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(combined);
    } catch {
      return { ok: false, response: errorResponse(400, 'invalid_encoding', 'Request body must be valid UTF-8') };
    }

    try {
      const parsed = JSON.parse(text);
      return { ok: true, data: parsed };
    } catch {
      return { ok: false, response: errorResponse(400, 'invalid_json', 'Malformed JSON in request body') };
    }
  }

  // --- Handlers ---

  async function handleGetSession(req: Request): Promise<Response> {
    const session = await resolveSession(req);
    const sessionInfo: SessionInfo = {
      user: session ? session.user : null,
      csrfToken: session ? session.csrfToken : null,
      authConfigured: isAuthConfigured,
      aiConfigured: isAiConfigured
    };
    return jsonResponse(sessionInfo);
  }

  async function handleLogout(req: Request): Promise<Response> {
    if (!verifyMutationOrigin(req)) {
      return errorResponse(403, 'cross_origin_denied', 'Cross-origin request denied');
    }
    const session = await resolveSession(req);
    if (!session) {
      return errorResponse(401, 'unauthorized', 'Authentication required');
    }
    if (!verifyCsrf(req, session.csrfToken)) {
      return errorResponse(403, 'csrf_invalid', 'Invalid or missing CSRF token');
    }

    db.deleteSession(session.tokenHash);

    const clearCookie = serializeCookie(SESSION_COOKIE_NAME, '', {
      path: '/',
      maxAge: 0,
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps
    });

    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearCookie });
  }

  async function handleAuthAmazon(): Promise<Response> {
    if (!isAuthConfigured) {
      return jsonResponse({ error: { code: 'auth_not_configured', message: 'Amazon OAuth is not configured on this server' } }, 503);
    }

    const state = randomBase64Url(32);
    const browserSecret = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64); // 43..128 chars base64url

    const stateHash = await sha256Base64Url(state);
    const browserHash = await sha256Base64Url(browserSecret);
    const codeChallenge = await sha256Base64Url(codeVerifier);

    db.saveOAuthState({
      stateHash,
      browserHash,
      codeVerifier,
      ttlMs: OAUTH_STATE_TTL_MS
    });

    const redirectUri = `${publicOrigin}/auth/amazon/callback`;
    const authUrl = new URL(amazonEndpoints.authorizationURL);
    authUrl.searchParams.set('client_id', config.amazon.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'profile');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    const browserCookie = serializeCookie(OAUTH_COOKIE_NAME, browserSecret, {
      path: '/auth/amazon/callback',
      maxAge: 600, // 10 minutes
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl.toString(),
        'Set-Cookie': browserCookie
      }
    });
  }

  async function handleAuthAmazonCallback(req: Request, url: URL): Promise<Response> {
    const errorParam = url.searchParams.get('error');
    if (errorParam) {
      return Response.redirect(`${publicOrigin}/?auth_error=access_denied`, 302);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      return Response.redirect(`${publicOrigin}/?auth_error=missing_code`, 302);
    }

    const cookies = parseCookies(req.headers.get('cookie'));
    const browserSecret = cookies[OAUTH_COOKIE_NAME];
    if (!browserSecret) {
      return Response.redirect(`${publicOrigin}/?auth_error=missing_browser_cookie`, 302);
    }

    const stateHash = await sha256Base64Url(state);
    const browserHash = await sha256Base64Url(browserSecret);

    // Strictly atomic consume with DELETE RETURNING
    const consumed = db.consumeOAuthState(stateHash, browserHash);
    if (!consumed) {
      return Response.redirect(`${publicOrigin}/?auth_error=invalid_state`, 302);
    }

    const clearOAuthCookie = serializeCookie(OAUTH_COOKIE_NAME, '', {
      path: '/auth/amazon/callback',
      maxAge: 0,
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps
    });

    // Exchange authorization code for access token with PKCE code_verifier (with timeout)
    const redirectUri = `${publicOrigin}/auth/amazon/callback`;
    const tokenParams = new URLSearchParams();
    tokenParams.set('grant_type', 'authorization_code');
    tokenParams.set('code', code);
    tokenParams.set('client_id', config.amazon.clientId);
    tokenParams.set('client_secret', config.amazon.clientSecret);
    tokenParams.set('redirect_uri', redirectUri);
    tokenParams.set('code_verifier', consumed.codeVerifier);

    let tokenJson: Record<string, unknown> | null = null;
    try {
      const tokenRes = await customFetch(amazonEndpoints.tokenURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        body: tokenParams.toString(),
        signal: AbortSignal.timeout(15_000)
      });
      if (!tokenRes.ok) {
        return Response.redirect(`${publicOrigin}/?auth_error=exchange_failed`, 302);
      }
      tokenJson = (await tokenRes.json()) as Record<string, unknown>;
    } catch {
      return Response.redirect(`${publicOrigin}/?auth_error=exchange_failed`, 302);
    }

    const accessToken = typeof tokenJson?.['access_token'] === 'string' ? tokenJson['access_token'] : null;
    if (!accessToken) {
      return Response.redirect(`${publicOrigin}/?auth_error=exchange_failed`, 302);
    }

    // Retrieve Amazon user profile (with timeout)
    let profileJson: Record<string, unknown> | null = null;
    try {
      const profileRes = await customFetch(amazonEndpoints.profileURL, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        signal: AbortSignal.timeout(15_000)
      });
      if (!profileRes.ok) {
        return Response.redirect(`${publicOrigin}/?auth_error=profile_failed`, 302);
      }
      profileJson = (await profileRes.json()) as Record<string, unknown>;
    } catch {
      return Response.redirect(`${publicOrigin}/?auth_error=profile_failed`, 302);
    }

    // Never store access token. Identify user strictly by verified Amazon user_id
    const amazonUserId =
      typeof profileJson?.['user_id'] === 'string'
        ? profileJson['user_id']
        : typeof profileJson?.['sub'] === 'string'
          ? profileJson['sub']
          : null;

    if (!amazonUserId) {
      return Response.redirect(`${publicOrigin}/?auth_error=profile_failed`, 302);
    }

    const name =
      typeof profileJson?.['name'] === 'string' && profileJson['name'].trim()
        ? profileJson['name'].trim()
        : 'Amazon User';
    const email =
      typeof profileJson?.['email'] === 'string' && profileJson['email'].trim()
        ? profileJson['email'].trim()
        : null;

    const user = db.upsertAmazonUser({ amazonUserId, name, email });

    // Rotate/clear any existing session token for this browser
    const existingSessionToken = cookies[SESSION_COOKIE_NAME];
    if (existingSessionToken) {
      const oldHash = await sha256Base64Url(existingSessionToken);
      db.deleteSession(oldHash);
    }

    // Create fresh session
    const sessionToken = randomBase64Url(32);
    const csrfToken = randomBase64Url(32);
    const sessionTokenHash = await sha256Base64Url(sessionToken);

    db.createSession({
      tokenHash: sessionTokenHash,
      userId: user.id,
      csrfToken,
      ttlMs: SESSION_TTL_MS
    });

    const sessionCookie = serializeCookie(SESSION_COOKIE_NAME, sessionToken, {
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps
    });

    const headers = new Headers();
    headers.set('Location', `${publicOrigin}/`);
    headers.append('Set-Cookie', sessionCookie);
    headers.append('Set-Cookie', clearOAuthCookie);

    return new Response(null, {
      status: 302,
      headers
    });
  }

  // --- Document CRUD ---

  async function handleListDocuments(req: Request): Promise<Response> {
    const session = await resolveSession(req);
    if (!session) {
      return errorResponse(401, 'unauthorized', 'Authentication required');
    }

    const documents: DocumentSummary[] = db.listDocuments(session.user.id);
    return jsonResponse({ documents });
  }

  async function handleCreateDocument(req: Request): Promise<Response> {
    if (!verifyMutationOrigin(req)) {
      return errorResponse(403, 'cross_origin_denied', 'Cross-origin request denied');
    }
    const session = await resolveSession(req);
    if (!session) {
      return errorResponse(401, 'unauthorized', 'Authentication required');
    }
    if (!verifyCsrf(req, session.csrfToken)) {
      return errorResponse(403, 'csrf_invalid', 'Invalid or missing CSRF token');
    }

    const bodyResult = await readStrictJson(req);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.data;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse(400, 'invalid_body', 'Request body must be an object');
    }

    const keys = Object.keys(body);
    const hasOnlyExpectedKeys = keys.every((k) => k === 'name' || k === 'markdown');
    if (!hasOnlyExpectedKeys || !('name' in body) || !('markdown' in body)) {
      return errorResponse(400, 'invalid_body', 'Strict { name: string, markdown: string } required');
    }

    const rawName = (body as Record<string, unknown>).name;
    const rawMarkdown = (body as Record<string, unknown>).markdown;

    if (typeof rawName !== 'string') {
      return errorResponse(400, 'invalid_name', 'Document name must be a string');
    }
    const name = rawName.trim();
    if (!name || name.length > MAX_DOCUMENT_NAME_LENGTH) {
      return errorResponse(400, 'invalid_name', `Document name must be between 1 and ${MAX_DOCUMENT_NAME_LENGTH} characters`);
    }

    if (typeof rawMarkdown !== 'string') {
      return errorResponse(400, 'invalid_markdown', 'Markdown must be a string');
    }
    if (rawMarkdown.length > MAX_MARKDOWN_LENGTH) {
      return errorResponse(413, 'markdown_too_large', 'Markdown document exceeds maximum allowed length');
    }

    // Extract any existing embedded aside annotations from the uploaded Markdown
    const { cleanMarkdown, clips: rawClips } = extractEmbeddedClipsFromMarkdown(rawMarkdown);

    if (rawClips.length > MAX_CLIPS_COUNT) {
      return errorResponse(400, 'invalid_clips', `Imported document exceeds maximum allowed limit of ${MAX_CLIPS_COUNT} clips`);
    }

    // Validate and normalize imported clips preserving all history without truncation
    const normalizedClips: ClipAnnotation[] = [];
    for (let i = 0; i < rawClips.length; i++) {
      const c = rawClips[i]!;

      // Normalize color to valid palette if invalid hex
      const color = HEX_COLOR_REGEX.test(c.color) ? c.color : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]!;

      // Validate offset strictly within cleanMarkdown bounds
      if (
        typeof c.offset !== 'number' ||
        !Number.isInteger(c.offset) ||
        c.offset < 0 ||
        c.offset > cleanMarkdown.length
      ) {
        return errorResponse(400, 'invalid_clip', 'Imported clip offset out of document bounds');
      }

      const anchorSnippet = typeof c.anchorSnippet === 'string' && c.anchorSnippet.length <= 500
        ? c.anchorSnippet
        : '📎';

      if (!Array.isArray(c.messages)) {
        return errorResponse(400, 'invalid_clip', 'Imported clip messages must be an array');
      }

      if (c.messages.length > MAX_MESSAGES_PER_CLIP) {
        return errorResponse(400, 'invalid_clip', `Imported clip exceeds maximum allowed limit of ${MAX_MESSAGES_PER_CLIP} messages`);
      }

      const normalizedMessages: ChatTurn[] = [];
      for (let j = 0; j < c.messages.length; j++) {
        const m = c.messages[j]!;

        if (m.role !== 'user' && m.role !== 'ai') {
          return errorResponse(400, 'invalid_message', 'Imported message role must be "user" or "ai"');
        }

        if (typeof m.content !== 'string') {
          return errorResponse(400, 'invalid_message', 'Imported message content must be a string');
        }

        if (m.content.length > MAX_CONTENT_LENGTH) {
          return errorResponse(400, 'invalid_message', `Imported message content exceeds maximum allowed length of ${MAX_CONTENT_LENGTH} characters`);
        }

        let content = m.content;
        if (m.role === 'ai') {
          content = normalizeAiHtmlReply(content);
          if (content.length > MAX_CONTENT_LENGTH) {
            return errorResponse(400, 'invalid_message', `Sanitized imported AI content exceeds maximum allowed length of ${MAX_CONTENT_LENGTH} characters`);
          }
        }

        let reasoning: string | undefined;
        if (m.reasoning !== undefined) {
          if (typeof m.reasoning !== 'string' || m.reasoning.length > MAX_REASONING_LENGTH) {
            return errorResponse(400, 'invalid_message', `Imported message reasoning exceeds maximum allowed length of ${MAX_REASONING_LENGTH} characters`);
          }
          reasoning = m.reasoning;
        }

        normalizedMessages.push({
          id: `turn-${crypto.randomUUID()}`,
          role: m.role,
          content,
          ...(reasoning !== undefined ? { reasoning } : {})
        });
      }

      normalizedClips.push({
        id: `clip-${crypto.randomUUID()}`,
        color,
        offset: c.offset,
        anchorSnippet,
        messages: normalizedMessages,
        createdAt: typeof c.createdAt === 'number' && Number.isFinite(c.createdAt) && c.createdAt > 0
          ? c.createdAt
          : Date.now() + i
      });
    }

    const document = db.createDocument({
      ownerId: session.user.id,
      name,
      markdown: cleanMarkdown,
      clips: normalizedClips
    });

    return jsonResponse({ document }, 201);
  }

  async function handleGetDocument(req: Request, documentId: string): Promise<Response> {
    const session = await resolveSession(req);
    if (!session) {
      return errorResponse(401, 'unauthorized', 'Authentication required');
    }

    const document = db.getDocument(session.user.id, documentId);
    if (!document) {
      return errorResponse(404, 'document_not_found', 'Document not found or access denied');
    }

    return jsonResponse({ document });
  }

  async function handleUpdateDocument(req: Request, documentId: string): Promise<Response> {
    if (!verifyMutationOrigin(req)) {
      return errorResponse(403, 'cross_origin_denied', 'Cross-origin request denied');
    }
    const session = await resolveSession(req);
    if (!session) {
      return errorResponse(401, 'unauthorized', 'Authentication required');
    }
    if (!verifyCsrf(req, session.csrfToken)) {
      return errorResponse(403, 'csrf_invalid', 'Invalid or missing CSRF token');
    }

    // Parse request body first
    const bodyResult = await readStrictJson(req);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.data;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse(400, 'invalid_body', 'Request body must be an object');
    }

    const keys = Object.keys(body);
    const hasOnlyExpectedKeys = keys.every((k) => k === 'revision' || k === 'clips');
    if (!hasOnlyExpectedKeys || !('revision' in body) || !('clips' in body)) {
      return errorResponse(400, 'invalid_body', 'Strict { revision: number, clips: ClipAnnotation[] } required');
    }

    const rawRevision = (body as Record<string, unknown>).revision;
    const rawClips = (body as Record<string, unknown>).clips;

    if (typeof rawRevision !== 'number' || !Number.isInteger(rawRevision) || rawRevision < 1) {
      return errorResponse(400, 'invalid_revision', 'Revision must be a positive integer');
    }
    if (!Array.isArray(rawClips)) {
      return errorResponse(400, 'invalid_clips', 'Clips must be an array');
    }
    if (rawClips.length > MAX_CLIPS_COUNT) {
      return errorResponse(400, 'invalid_clips', `Maximum of ${MAX_CLIPS_COUNT} clips exceeded`);
    }

    // Load existing document to validate offsets against markdown length
    const existing = db.getDocument(session.user.id, documentId);
    if (!existing) {
      return errorResponse(404, 'document_not_found', 'Document not found or access denied');
    }

    // Validate clips array structure strictly
    const clipIds = new Set<string>();
    const messageIds = new Set<string>();
    const clips: ClipAnnotation[] = [];

    for (const c of rawClips) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        return errorResponse(400, 'invalid_clip', 'Clip items must be objects');
      }
      const clipObj = c as Record<string, unknown>;
      const cKeys = Object.keys(clipObj);
      if (!cKeys.every((k) => ALLOWED_CLIP_KEYS[k])) {
        return errorResponse(400, 'invalid_clip', 'Clip contains unknown properties');
      }

      if (typeof clipObj.id !== 'string' || !clipObj.id || clipObj.id.length > 100) {
        return errorResponse(400, 'invalid_clip', 'Clip id must be a string between 1 and 100 characters');
      }
      if (clipIds.has(clipObj.id)) {
        return errorResponse(400, 'invalid_clip', `Duplicate clip id: ${clipObj.id}`);
      }
      clipIds.add(clipObj.id);

      if (typeof clipObj.color !== 'string' || !HEX_COLOR_REGEX.test(clipObj.color)) {
        return errorResponse(400, 'invalid_clip', 'Clip color must be a valid hex color');
      }

      if (
        typeof clipObj.offset !== 'number' ||
        !Number.isInteger(clipObj.offset) ||
        clipObj.offset < 0 ||
        clipObj.offset > existing.markdown.length
      ) {
        return errorResponse(400, 'invalid_clip', 'Clip offset must be a finite integer within document markdown bounds');
      }

      if (typeof clipObj.anchorSnippet !== 'string' || clipObj.anchorSnippet.length > 500) {
        return errorResponse(400, 'invalid_clip', 'Clip anchorSnippet must be a string up to 500 characters');
      }

      if (typeof clipObj.createdAt !== 'number' || !Number.isFinite(clipObj.createdAt) || clipObj.createdAt <= 0) {
        return errorResponse(400, 'invalid_clip', 'Clip createdAt must be a positive timestamp');
      }

      if (!Array.isArray(clipObj.messages)) {
        return errorResponse(400, 'invalid_clip', 'Clip messages must be an array');
      }
      if (clipObj.messages.length > MAX_MESSAGES_PER_CLIP) {
        return errorResponse(400, 'invalid_clip', `Maximum of ${MAX_MESSAGES_PER_CLIP} messages per clip exceeded`);
      }

      const messages: ChatTurn[] = [];
      for (const m of clipObj.messages) {
        if (!m || typeof m !== 'object' || Array.isArray(m)) {
          return errorResponse(400, 'invalid_message', 'Message items must be objects');
        }
        const msgObj = m as Record<string, unknown>;
        const mKeys = Object.keys(msgObj);
        if (!mKeys.every((k) => ALLOWED_MSG_KEYS[k])) {
          return errorResponse(400, 'invalid_message', 'Message contains unknown properties');
        }

        if (typeof msgObj.id !== 'string' || !msgObj.id || msgObj.id.length > 100) {
          return errorResponse(400, 'invalid_message', 'Message id must be a string between 1 and 100 characters');
        }
        if (messageIds.has(msgObj.id)) {
          return errorResponse(400, 'invalid_message', `Duplicate message id: ${msgObj.id}`);
        }
        messageIds.add(msgObj.id);

        if (msgObj.role !== 'user' && msgObj.role !== 'ai') {
          return errorResponse(400, 'invalid_message', 'Message role must be "user" or "ai"');
        }

        if (typeof msgObj.content !== 'string' || msgObj.content.length > MAX_CONTENT_LENGTH) {
          return errorResponse(400, 'invalid_message', `Message content exceeds maximum allowed length of ${MAX_CONTENT_LENGTH} characters`);
        }

        let content = msgObj.content;
        if (msgObj.role === 'ai') {
          content = normalizeAiHtmlReply(content);
          // Enforce post-normalization length constraint (prevents entity expansion attacks)
          if (content.length > MAX_CONTENT_LENGTH) {
            return errorResponse(400, 'invalid_message', `Sanitized AI message content exceeds maximum allowed length of ${MAX_CONTENT_LENGTH} characters`);
          }
        }

        let reasoning: string | undefined;
        if (msgObj.reasoning !== undefined) {
          if (typeof msgObj.reasoning !== 'string' || msgObj.reasoning.length > MAX_REASONING_LENGTH) {
            return errorResponse(400, 'invalid_message', `Message reasoning exceeds maximum allowed length of ${MAX_REASONING_LENGTH} characters`);
          }
          reasoning = msgObj.reasoning;
        }

        let pending: boolean | undefined;
        if (msgObj.pending !== undefined) {
          if (typeof msgObj.pending !== 'boolean') {
            return errorResponse(400, 'invalid_message', 'Message pending must be a boolean');
          }
          pending = msgObj.pending;
        }

        messages.push({
          id: msgObj.id,
          role: msgObj.role,
          content,
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(pending !== undefined ? { pending } : {})
        });
      }

      clips.push({
        id: clipObj.id,
        color: clipObj.color,
        offset: clipObj.offset,
        anchorSnippet: clipObj.anchorSnippet,
        messages,
        createdAt: clipObj.createdAt
      });
    }

    // Atomic update inside transaction: checks generation lock and expected revision
    const updateResult = db.updateClipsSnapshot({
      ownerId: session.user.id,
      documentId,
      expectedRevision: rawRevision,
      clips
    });

    if (!updateResult.ok) {
      if (updateResult.busy) {
        return errorResponse(409, 'document_busy', 'Document has an active AI generation in progress', updateResult.document);
      }
      if (updateResult.conflict) {
        return errorResponse(409, 'revision_conflict', 'Document revision conflict', updateResult.document);
      }
      return errorResponse(404, 'document_not_found', 'Document not found');
    }

    return jsonResponse({ document: updateResult.document });
  }

  async function handleDeleteDocument(req: Request, documentId: string): Promise<Response> {
    if (!verifyMutationOrigin(req)) {
      return errorResponse(403, 'cross_origin_denied', 'Cross-origin request denied');
    }
    const session = await resolveSession(req);
    if (!session) {
      return errorResponse(401, 'unauthorized', 'Authentication required');
    }
    if (!verifyCsrf(req, session.csrfToken)) {
      return errorResponse(403, 'csrf_invalid', 'Invalid or missing CSRF token');
    }

    // Atomic deletion inside transaction: checks generation lock and deletes document
    const deleteResult = db.deleteDocument(session.user.id, documentId);
    if (!deleteResult.ok) {
      if (deleteResult.busy) {
        return errorResponse(409, 'document_busy', 'Cannot delete document while AI generation is in progress', deleteResult.document);
      }
      return errorResponse(404, 'document_not_found', 'Document not found or access denied');
    }

    return jsonResponse({ ok: true });
  }

  // --- Reply SSE Endpoint ---

  async function handleReply(req: Request, documentId: string): Promise<Response> {
    if (!verifyMutationOrigin(req)) {
      return errorResponse(403, 'cross_origin_denied', 'Cross-origin request denied');
    }
    const session = await resolveSession(req);
    if (!session) {
      return errorResponse(401, 'unauthorized', 'Authentication required');
    }
    if (!verifyCsrf(req, session.csrfToken)) {
      return errorResponse(403, 'csrf_invalid', 'Invalid or missing CSRF token');
    }

    if (!isAiConfigured) {
      return errorResponse(503, 'ai_not_configured', 'AI service is not configured on this server');
    }

    const bodyResult = await readStrictJson(req);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.data;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse(400, 'invalid_body', 'Request body must be an object');
    }

    const keys = Object.keys(body);
    const hasOnlyExpectedKeys = keys.every((k) => k === 'revision' || k === 'clipId' || k === 'content');
    if (!hasOnlyExpectedKeys || !('revision' in body) || !('clipId' in body) || !('content' in body)) {
      return errorResponse(400, 'invalid_body', 'Strict { revision: number, clipId: string, content: string } required');
    }

    const rawRevision = (body as Record<string, unknown>).revision;
    const rawClipId = (body as Record<string, unknown>).clipId;
    const rawContent = (body as Record<string, unknown>).content;

    if (typeof rawRevision !== 'number' || !Number.isInteger(rawRevision) || rawRevision < 1) {
      return errorResponse(400, 'invalid_revision', 'Revision must be a positive integer');
    }
    if (typeof rawClipId !== 'string' || !rawClipId || rawClipId.length > 100) {
      return errorResponse(400, 'invalid_clip_id', 'clipId must be a string between 1 and 100 characters');
    }
    if (typeof rawContent !== 'string') {
      return errorResponse(400, 'invalid_content', 'Message content must be a string');
    }
    const content = rawContent.trim();
    if (!content) {
      return errorResponse(400, 'empty_content', 'Message content cannot be empty');
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return errorResponse(413, 'content_too_large', `Message content exceeds maximum allowed length of ${MAX_CONTENT_LENGTH}`);
    }

    // Load document to prepare user turn and check admission capacity
    const doc = db.getDocument(session.user.id, documentId);
    if (!doc) {
      return errorResponse(404, 'document_not_found', 'Document not found or access denied');
    }

    const targetClip = doc.clips.find((c) => c.id === rawClipId);
    if (!targetClip) {
      return errorResponse(404, 'clip_not_found', `Clip with id "${rawClipId}" does not exist in this document`, doc);
    }

    // Reject admission before persisting if target history lacks capacity for both user and AI turns
    if (targetClip.messages.length + 2 > MAX_MESSAGES_PER_CLIP) {
      return errorResponse(400, 'clip_full', `Clip cannot accept new messages (maximum capacity of ${MAX_MESSAGES_PER_CLIP} turns reached)`, doc);
    }

    const userTurnId = `turn-${crypto.randomUUID()}`;
    const updatedClips: ClipAnnotation[] = doc.clips.map((c) => {
      if (c.id !== rawClipId) return c;
      return {
        ...c,
        messages: [
          ...c.messages,
          {
            id: userTurnId,
            role: 'user' as const,
            content
          }
        ]
      };
    });

    // Atomically claim generation lock and persist user turn in a single transaction
    const claimResult = db.claimGenerationAndPersistUserTurn({
      ownerId: session.user.id,
      documentId,
      clipId: rawClipId,
      expectedRevision: rawRevision,
      updatedClips
    });

    if (!claimResult.ok) {
      if (claimResult.busy) {
        return errorResponse(409, 'document_busy', 'Document has an active AI generation in progress', claimResult.document);
      }
      if (claimResult.conflict) {
        return errorResponse(409, 'revision_conflict', 'Document revision conflict', claimResult.document);
      }
      if (claimResult.clipFull) {
        return errorResponse(400, 'clip_full', `Clip cannot accept new messages (maximum capacity of ${MAX_MESSAGES_PER_CLIP} turns reached)`, claimResult.document);
      }
      if (claimResult.clipNotFound) {
        return errorResponse(404, 'clip_not_found', `Clip with id "${rawClipId}" does not exist in this document`, claimResult.document);
      }
      return errorResponse(404, 'document_not_found', 'Document not found or access denied');
    }

    const persistedUserDoc = claimResult.document;
    const generationToken = claimResult.token;

    // Track active token for this app instance
    activeInstanceTokens.set(documentId, generationToken);

    // Build prompt once for both client document event and AI stream
    const { prompt: clientPrompt } = buildAiPrompt(
      persistedUserDoc.markdown,
      persistedUserDoc.clips,
      rawClipId
    );

    // Prepare SSE stream
    const encoder = new TextEncoder();
    let isClosed = false;
    let isAborted = false;

    const userAbortController = new AbortController();
    activeAbortControllers.add(userAbortController);

    const generationTimeoutSignal = AbortSignal.timeout(180_000); // 3 minutes max for AI generation
    const combinedSignal = AbortSignal.any([userAbortController.signal, generationTimeoutSignal]);

    let lockReleased = false;
    const releaseLock = () => {
      if (lockReleased) return;
      lockReleased = true;
      if (activeInstanceTokens.get(documentId) === generationToken) activeInstanceTokens.delete(documentId);
      activeAbortControllers.delete(userAbortController);
      if (!isAppClosed) db.releaseGeneration(documentId, generationToken);
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const sendEvent = (event: ReplyEvent) => {
          if (isClosed || isAborted || isAppClosed) return;
          try {
            const wire = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(wire));
          } catch {
            // Controller closed
          }
        };

        let currentDocumentState = persistedUserDoc;

        try {
          // Send document event IMMEDIATELY before awaiting AI upstream
          sendEvent({
            type: 'document',
            document: persistedUserDoc,
            prompt: clientPrompt
          });

          // Start AI streaming with pre-built prompt
          const aiStream = streamAiAnnotationReply({
            prompt: clientPrompt,
            aiConfig: config.ai,
            fetch: customFetch,
            abortSignal: combinedSignal
          });

          let generatorNext = await aiStream.next();
          while (!generatorNext.done) {
            if (isAborted || isAppClosed) break;
            const chunk = generatorNext.value;
            if (chunk.type === 'reasoning') {
              sendEvent({ type: 'reasoning', delta: chunk.delta });
            } else if (chunk.type === 'text') {
              sendEvent({ type: 'text', delta: chunk.delta });
            }
            generatorNext = await aiStream.next();
          }

          if (isAborted || isAppClosed) return;
          if (!generatorNext.done) throw new Error('AI stream ended without a completed result');

          const finalResult = generatorNext.value;

          if (
            finalResult.htmlReply.length > MAX_CONTENT_LENGTH ||
            (finalResult.reasoningText && finalResult.reasoningText.length > MAX_REASONING_LENGTH)
          ) {
            sendEvent({
              type: 'error',
              error: {
                code: 'ai_response_too_large',
                message: 'AI response exceeded maximum allowed length'
              },
              document: currentDocumentState
            });
            return;
          }

          const aiTurnId = `turn-${crypto.randomUUID()}`;

          // Append AI reply to the target clip
          const finalClips: ClipAnnotation[] = currentDocumentState.clips.map((c) => {
            if (c.id !== rawClipId) return c;
            return {
              ...c,
              messages: [
                ...c.messages,
                {
                  id: aiTurnId,
                  role: 'ai' as const,
                  content: finalResult.htmlReply,
                  reasoning: finalResult.reasoningText || undefined
                }
              ]
            };
          });

          if (isAppClosed) return;

          // Atomically persist AI reply and release generation lock
          const finalizedDoc = db.persistAiReply({
            ownerId: session.user.id,
            documentId,
            updatedClips: finalClips,
            token: generationToken
          });

          if (finalizedDoc) {
            currentDocumentState = finalizedDoc;
            sendEvent({ type: 'done', document: finalizedDoc });
          } else {
            sendEvent({
              type: 'error',
              error: { code: 'persist_failed', message: 'Failed to persist completed AI reply (generation lock expired)' },
              document: currentDocumentState
            });
          }
        } catch (err) {
          const capacityExceeded = err instanceof AnnotationCapacityError;
          const safeMessage = capacityExceeded
            ? err.message
            : combinedSignal.aborted
              ? 'AI generation timed out or was cancelled'
              : 'AI response generation failed. Please try again.';

          sendEvent({
            type: 'error',
            error: {
              code: capacityExceeded ? 'annotation_limit' : 'ai_generation_error',
              message: safeMessage
            },
            document: currentDocumentState
          });
        } finally {
          releaseLock();
          if (!isClosed && !isAborted && !isAppClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch {
              // Ignored
            }
          }
        }
      },
      cancel() {
        isAborted = true;
        userAbortController.abort();
        releaseLock();
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      }
    });
  }

  // --- Router ---

  async function handleRequest(req: Request): Promise<Response> {
    if (isAppClosed) {
      return errorResponse(503, 'server_closed', 'Server is shutting down');
    }

    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    // Unknown non-api / non-auth paths
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/auth/')) {
      return errorResponse(404, 'not_found', 'Route not found');
    }

    // Session endpoint
    if (pathname === '/api/session' && method === 'GET') {
      return handleGetSession(req);
    }

    // Logout endpoint
    if (pathname === '/api/logout' && method === 'POST') {
      return handleLogout(req);
    }

    // Amazon OAuth routes
    if (pathname === '/auth/amazon' && method === 'GET') {
      return handleAuthAmazon();
    }
    if (pathname === '/auth/amazon/callback' && method === 'GET') {
      return handleAuthAmazonCallback(req, url);
    }

    // Documents collection
    if (pathname === '/api/documents') {
      if (method === 'GET') {
        return handleListDocuments(req);
      }
      if (method === 'POST') {
        return handleCreateDocument(req);
      }
      return errorResponse(405, 'method_not_allowed', 'Method not allowed');
    }

    // Reply route: /api/documents/:id/reply
    const replyMatch = pathname.match(/^\/api\/documents\/([^/]+)\/reply$/);
    if (replyMatch) {
      if (method === 'POST') {
        let documentId: string;
        try {
          documentId = decodeURIComponent(replyMatch[1]!);
        } catch {
          return errorResponse(400, 'invalid_path', 'Invalid URI encoding in path parameter');
        }
        return handleReply(req, documentId);
      }
      return errorResponse(405, 'method_not_allowed', 'Method not allowed');
    }

    // Document resource: /api/documents/:id
    const docMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (docMatch) {
      let documentId: string;
      try {
        documentId = decodeURIComponent(docMatch[1]!);
      } catch {
        return errorResponse(400, 'invalid_path', 'Invalid URI encoding in path parameter');
      }

      if (method === 'GET') {
        return handleGetDocument(req, documentId);
      }
      if (method === 'PUT') {
        return handleUpdateDocument(req, documentId);
      }
      if (method === 'DELETE') {
        return handleDeleteDocument(req, documentId);
      }
      return errorResponse(405, 'method_not_allowed', 'Method not allowed');
    }

    return errorResponse(404, 'not_found', 'API route not found');
  }

  return {
    fetch: async (request) => {
      try {
        return await handleRequest(request);
      } catch (error) {
        if (error instanceof AnnotationCapacityError) {
          return errorResponse(413, 'annotation_limit', error.message);
        }
        throw error;
      }
    },
    close: () => {
      isAppClosed = true;
      for (const ac of activeAbortControllers) {
        ac.abort();
      }
      activeAbortControllers.clear();
      for (const [docId, token] of activeInstanceTokens) {
        db.releaseGeneration(docId, token);
      }
      activeInstanceTokens.clear();
      db.close();
    },
    db
  };
}
