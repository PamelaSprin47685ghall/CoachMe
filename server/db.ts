import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccountUser, CloudDocument, DocumentSummary } from '../src/lib/contracts';
import type { ClipAnnotation } from '../src/lib/markdown';

export interface UserRow {
  id: string;
  amazon_user_id: string;
  name: string;
  email: string | null;
  created_at: number;
}

export interface DocumentRow {
  id: string;
  owner_id: string;
  name: string;
  markdown: string;
  clips_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

const GENERATION_STALE_TIMEOUT_MS = 35 * 60 * 1000; // 35 minutes (> 30-minute AI generation timeout)
const PROCESS_START_TIME = Date.now() - Math.floor(process.uptime() * 1000);
// Leave headroom below the API's 4 MiB JSON request limit so every stored snapshot remains syncable.
export const MAX_ANNOTATION_BYTES = 3 * 1024 * 1024;

export class AnnotationCapacityError extends Error {
  constructor() {
    super('当前文档的批注数据已达到 3 MiB 上限，请删除不再需要的曲别针后继续。');
    this.name = 'AnnotationCapacityError';
  }
}

function serializeClips(clips: ClipAnnotation[]): string {
  const serialized = JSON.stringify(clips);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ANNOTATION_BYTES) throw new AnnotationCapacityError();
  return serialized;
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err) {
      if (err.code === 'ESRCH') return false; // Dead process
      if (err.code === 'EPERM') return true;  // Alive process owned by another user
    }
    return true;
  }
}

export class DatabaseStore {
  readonly db: Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath, { create: true });
    this.db.run('PRAGMA journal_mode = WAL;');
    this.db.run('PRAGMA foreign_keys = ON;');
    this.initSchema();
    this.cleanStaleGenerations();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        amazon_user_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        email TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        browser_hash TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        markdown TEXT NOT NULL,
        clips_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);

      CREATE TABLE IF NOT EXISTS generations (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        token TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        pid INTEGER NOT NULL DEFAULT 0
      );
    `);

    try {
      this.db.run('ALTER TABLE generations ADD COLUMN pid INTEGER NOT NULL DEFAULT 0;');
    } catch {
      // Column already exists
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignored
    }
  }

  // --- Users & Sessions ---

  upsertAmazonUser(params: { amazonUserId: string; name: string; email: string | null }): AccountUser {
    const now = Date.now();
    const existing = this.db.query<UserRow, [string]>(
      'SELECT id, amazon_user_id, name, email, created_at FROM users WHERE amazon_user_id = ?'
    ).get(params.amazonUserId);

    if (existing) {
      if (existing.name !== params.name || existing.email !== params.email) {
        this.db.prepare(
          'UPDATE users SET name = ?, email = ? WHERE id = ?'
        ).run(params.name, params.email, existing.id);
      }
      return {
        id: existing.id,
        name: params.name,
        email: params.email
      };
    }

    const newId = crypto.randomUUID();
    this.db.prepare(
      'INSERT INTO users (id, amazon_user_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(newId, params.amazonUserId, params.name, params.email, now);

    return {
      id: newId,
      name: params.name,
      email: params.email
    };
  }

  createSession(params: { tokenHash: string; userId: string; csrfToken: string; ttlMs: number }): void {
    const now = Date.now();
    const expiresAt = now + params.ttlMs;
    this.db.prepare(
      'INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(params.tokenHash, params.userId, params.csrfToken, now, expiresAt);
  }

  getSession(tokenHash: string): { user: AccountUser; csrfToken: string } | null {
    const now = Date.now();
    const row = this.db.query<
      {
        token_hash: string;
        csrf_token: string;
        expires_at: number;
        user_id: string;
        name: string;
        email: string | null;
      },
      [string, number]
    >(`
      SELECT s.token_hash, s.csrf_token, s.expires_at, u.id AS user_id, u.name, u.email
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash, now);

    if (!row) {
      return null;
    }

    return {
      user: {
        id: row.user_id,
        name: row.name,
        email: row.email
      },
      csrfToken: row.csrf_token
    };
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  // --- OAuth States (one-time, browser-bound, PKCE) ---

  saveOAuthState(params: {
    stateHash: string;
    browserHash: string;
    codeVerifier: string;
    ttlMs: number;
  }): void {
    const now = Date.now();
    const expiresAt = now + params.ttlMs;
    this.db.prepare(
      'INSERT INTO oauth_states (state_hash, browser_hash, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(params.stateHash, params.browserHash, params.codeVerifier, now, expiresAt);
  }

  /**
   * Strictly atomic consume with DELETE ... RETURNING.
   * Ensures exactly one caller can ever consume a state hash.
   */
  consumeOAuthState(stateHash: string, browserHash: string): { codeVerifier: string } | null {
    const now = Date.now();
    const row = this.db.query<
      { browser_hash: string; code_verifier: string; expires_at: number },
      [string]
    >(
      'DELETE FROM oauth_states WHERE state_hash = ? RETURNING browser_hash, code_verifier, expires_at'
    ).get(stateHash);

    if (!row) {
      return null;
    }

    if (row.expires_at <= now) {
      return null;
    }

    if (row.browser_hash !== browserHash) {
      return null;
    }

    return { codeVerifier: row.code_verifier };
  }

  // --- Documents ---

  /**
   * Selects only summary columns plus SQLite json_array_length(clips_json)
   * avoiding allocating large full document markdown and JSON blobs per summary row.
   */
  listDocuments(ownerId: string): DocumentSummary[] {
    const rows = this.db.query<
      {
        id: string;
        name: string;
        created_at: number;
        updated_at: number;
        revision: number;
        clip_count: number | null;
      },
      [string]
    >(`
      SELECT id, name, created_at, updated_at, revision,
             COALESCE(json_array_length(clips_json), 0) AS clip_count
      FROM documents
      WHERE owner_id = ?
      ORDER BY updated_at DESC
    `).all(ownerId);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      clipCount: row.clip_count ?? 0
    }));
  }

  getDocument(ownerId: string, documentId: string): CloudDocument | null {
    const row = this.db.query<DocumentRow, [string, string]>(
      'SELECT id, owner_id, name, markdown, clips_json, revision, created_at, updated_at FROM documents WHERE owner_id = ? AND id = ?'
    ).get(ownerId, documentId);

    if (!row) return null;
    return this.hydrateCloudDocument(row);
  }

  createDocument(params: {
    ownerId: string;
    name: string;
    markdown: string;
    clips: ClipAnnotation[];
  }): CloudDocument {
    const id = crypto.randomUUID();
    const now = Date.now();
    const revision = 1;
    const clipsJson = serializeClips(params.clips);

    this.db.prepare(`
      INSERT INTO documents (id, owner_id, name, markdown, clips_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, params.ownerId, params.name, params.markdown, clipsJson, revision, now, now);

    return {
      id,
      name: params.name,
      markdown: params.markdown,
      clips: params.clips,
      revision,
      createdAt: now,
      updatedAt: now,
      clipCount: params.clips.length
    };
  }

  /**
   * Atomic update of clips snapshot with generation-lock check and revision CAS.
   */
  updateClipsSnapshot(params: {
    ownerId: string;
    documentId: string;
    expectedRevision: number;
    clips: ClipAnnotation[];
  }): { ok: true; document: CloudDocument } | { ok: false; busy?: boolean; conflict?: boolean; document?: CloudDocument } {
    const tx = this.db.transaction(() => {
      this.cleanStaleGenerations();

      const busyRow = this.db.query<{ document_id: string }, [string]>(
        'SELECT document_id FROM generations WHERE document_id = ?'
      ).get(params.documentId);

      const existingRow = this.db.query<DocumentRow, [string, string]>(
        'SELECT id, owner_id, name, markdown, clips_json, revision, created_at, updated_at FROM documents WHERE owner_id = ? AND id = ?'
      ).get(params.ownerId, params.documentId);

      if (!existingRow) {
        return { ok: false as const, conflict: false };
      }

      const existingDoc = this.hydrateCloudDocument(existingRow);

      if (busyRow) {
        return { ok: false as const, busy: true, document: existingDoc };
      }

      if (existingRow.revision !== params.expectedRevision) {
        return { ok: false as const, conflict: true, document: existingDoc };
      }

      const now = Date.now();
      const nextRevision = existingRow.revision + 1;
      const clipsJson = serializeClips(params.clips);

      const res = this.db.prepare(`
        UPDATE documents
        SET clips_json = ?, revision = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND revision = ?
      `).run(clipsJson, nextRevision, now, params.documentId, params.ownerId, params.expectedRevision);

      if (res.changes === 0) {
        return { ok: false as const, conflict: true, document: existingDoc };
      }

      return {
        ok: true as const,
        document: {
          id: existingDoc.id,
          name: existingDoc.name,
          markdown: existingDoc.markdown,
          clips: params.clips,
          revision: nextRevision,
          createdAt: existingDoc.createdAt,
          updatedAt: now,
          clipCount: params.clips.length
        }
      };
    });

    return tx.immediate();
  }

  /**
   * Atomic deletion: checks generation lock and deletes document inside a transaction.
   */
  deleteDocument(ownerId: string, documentId: string): { ok: true } | { ok: false; busy?: boolean; notFound?: boolean; document?: CloudDocument } {
    const tx = this.db.transaction(() => {
      this.cleanStaleGenerations();

      const busyRow = this.db.query<{ document_id: string }, [string]>(
        'SELECT document_id FROM generations WHERE document_id = ?'
      ).get(documentId);

      const existingRow = this.db.query<DocumentRow, [string, string]>(
        'SELECT id, owner_id, name, markdown, clips_json, revision, created_at, updated_at FROM documents WHERE owner_id = ? AND id = ?'
      ).get(ownerId, documentId);

      if (!existingRow) {
        return { ok: false as const, notFound: true };
      }

      const existingDoc = this.hydrateCloudDocument(existingRow);

      if (busyRow) {
        return { ok: false as const, busy: true, document: existingDoc };
      }

      this.db.prepare('DELETE FROM documents WHERE id = ? AND owner_id = ?').run(documentId, ownerId);
      return { ok: true as const };
    });

    return tx.immediate();
  }

  // --- Generation locks & Reply persistence ---

  isDocumentBusy(documentId: string): boolean {
    this.cleanStaleGenerations();
    const row = this.db.query<{ document_id: string }, [string]>(
      'SELECT document_id FROM generations WHERE document_id = ?'
    ).get(documentId);
    return Boolean(row);
  }

  /**
   * Atomically claims the generation lock AND persists the user turn in a single transaction.
   * Guarantees that lock acquisition, revision check, capacity check, and user turn persistence never race.
   */
  claimGenerationAndPersistUserTurn(params: {
    ownerId: string;
    documentId: string;
    clipId: string;
    expectedRevision: number;
    updatedClips: ClipAnnotation[];
  }): {
    ok: true;
    token: string;
    document: CloudDocument;
  } | {
    ok: false;
    busy?: boolean;
    conflict?: boolean;
    notFound?: boolean;
    clipNotFound?: boolean;
    clipFull?: boolean;
    document?: CloudDocument;
  } {
    const tx = this.db.transaction(() => {
      this.cleanStaleGenerations();

      const existingRow = this.db.query<DocumentRow, [string, string]>(
        'SELECT id, owner_id, name, markdown, clips_json, revision, created_at, updated_at FROM documents WHERE owner_id = ? AND id = ?'
      ).get(params.ownerId, params.documentId);

      if (!existingRow) {
        return { ok: false as const, notFound: true };
      }

      const existingDoc = this.hydrateCloudDocument(existingRow);

      const busyRow = this.db.query<{ document_id: string }, [string]>(
        'SELECT document_id FROM generations WHERE document_id = ?'
      ).get(params.documentId);

      if (busyRow) {
        return { ok: false as const, busy: true, document: existingDoc };
      }

      if (existingRow.revision !== params.expectedRevision) {
        return { ok: false as const, conflict: true, document: existingDoc };
      }

      const targetClip = existingDoc.clips.find((c) => c.id === params.clipId);
      if (!targetClip) {
        return { ok: false as const, clipNotFound: true, document: existingDoc };
      }

      // Check capacity for both user and AI turns (max 200 messages)
      if (targetClip.messages.length + 2 > 200) {
        return { ok: false as const, clipFull: true, document: existingDoc };
      }

      const now = Date.now();
      const token = crypto.randomUUID();
      const nextRevision = existingRow.revision + 1;
      const clipsJson = serializeClips(params.updatedClips);

      const updateRes = this.db.prepare(`
        UPDATE documents
        SET clips_json = ?, revision = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND revision = ?
      `).run(clipsJson, nextRevision, now, params.documentId, params.ownerId, params.expectedRevision);

      if (updateRes.changes === 0) {
        return { ok: false as const, conflict: true, document: existingDoc };
      }

      this.db.prepare(`
        INSERT INTO generations (document_id, owner_id, token, started_at, pid)
        VALUES (?, ?, ?, ?, ?)
      `).run(params.documentId, params.ownerId, token, now, process.pid);

      return {
        ok: true as const,
        token,
        document: {
          id: existingDoc.id,
          name: existingDoc.name,
          markdown: existingDoc.markdown,
          clips: params.updatedClips,
          revision: nextRevision,
          createdAt: existingDoc.createdAt,
          updatedAt: now,
          clipCount: params.updatedClips.length
        }
      };
    });

    return tx.immediate();
  }

  /**
   * Atomically persists the completed AI turn and releases the generation lock,
   * verifying that the generation lock token still matches.
   */
  persistAiReply(params: {
    ownerId: string;
    documentId: string;
    updatedClips: ClipAnnotation[];
    token: string;
  }): CloudDocument | null {
    const tx = this.db.transaction(() => {
      // Verify the generation lock is still held by this specific token
      const lockRow = this.db.query<{ token: string }, [string]>(
        'SELECT token FROM generations WHERE document_id = ?'
      ).get(params.documentId);

      if (!lockRow || lockRow.token !== params.token) {
        // Lock expired or stolen by newer operation
        return null;
      }

      const existingRow = this.db.query<DocumentRow, [string, string]>(
        'SELECT id, owner_id, name, markdown, clips_json, revision, created_at, updated_at FROM documents WHERE owner_id = ? AND id = ?'
      ).get(params.ownerId, params.documentId);

      if (!existingRow) {
        this.db.prepare('DELETE FROM generations WHERE document_id = ? AND token = ?').run(params.documentId, params.token);
        return null;
      }

      const now = Date.now();
      const nextRevision = existingRow.revision + 1;
      const clipsJson = serializeClips(params.updatedClips);

      this.db.prepare(`
        UPDATE documents
        SET clips_json = ?, revision = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(clipsJson, nextRevision, now, params.documentId, params.ownerId);

      // Release generation lock
      this.db.prepare('DELETE FROM generations WHERE document_id = ? AND token = ?').run(params.documentId, params.token);

      return {
        id: existingRow.id,
        name: existingRow.name,
        markdown: existingRow.markdown,
        clips: params.updatedClips,
        revision: nextRevision,
        createdAt: existingRow.created_at,
        updatedAt: now,
        clipCount: params.updatedClips.length
      };
    });

    return tx.immediate();
  }

  /**
   * Release generation lock safely, scoped to specific generation token if provided.
   */
  releaseGeneration(documentId: string, token?: string): void {
    if (token) {
      this.db.prepare('DELETE FROM generations WHERE document_id = ? AND token = ?').run(documentId, token);
    } else {
      this.db.prepare('DELETE FROM generations WHERE document_id = ?').run(documentId);
    }
  }

  /**
   * Prune locks that are either:
   * 1. Older than 35 minutes (hard timeout).
   * 2. Owned by our current PID but started before this process started (previous process crashed with same PID).
   * 3. Owned by a dead PID on the local host (ESRCH error from kill 0).
   * Keeps locks owned by alive processes.
   */
  cleanStaleGenerations(): void {
    const now = Date.now();
    const hardTimeoutThreshold = now - GENERATION_STALE_TIMEOUT_MS;

    const rows = this.db.query<{ document_id: string; token: string; pid: number; started_at: number }, []>(
      'SELECT document_id, token, pid, started_at FROM generations'
    ).all();

    for (const row of rows) {
      const isExpired = row.started_at < hardTimeoutThreshold;
      const isReusedDeadPid = row.pid === process.pid && row.started_at < PROCESS_START_TIME;
      const isDeadPid = row.pid > 0 && !isPidAlive(row.pid);

      if (isExpired || isReusedDeadPid || isDeadPid) {
        this.db.prepare('DELETE FROM generations WHERE document_id = ? AND token = ?').run(row.document_id, row.token);
      }
    }
  }

  private hydrateCloudDocument(row: DocumentRow): CloudDocument {
    let clips: ClipAnnotation[] = [];
    try {
      const parsed = JSON.parse(row.clips_json);
      if (Array.isArray(parsed)) {
        clips = parsed;
      }
    } catch {
      clips = [];
    }

    return {
      id: row.id,
      name: row.name,
      markdown: row.markdown,
      clips,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clipCount: clips.length
    };
  }
}
