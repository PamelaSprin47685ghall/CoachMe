import type { ClipAnnotation } from './markdown';

export interface AccountUser {
  id: string;
  name: string;
  email: string | null;
}

export interface SessionInfo {
  user: AccountUser | null;
  csrfToken: string | null;
  authConfigured: boolean;
  aiConfigured: boolean;
}

export interface DocumentSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  clipCount: number;
}

export interface CloudDocument extends DocumentSummary {
  markdown: string;
  clips: ClipAnnotation[];
}

export interface ApiErrorBody {
  error: { code: string; message: string };
  document?: CloudDocument;
}

export type ReplyEvent =
  | { type: 'document'; document: CloudDocument; prompt: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; document: CloudDocument }
  | { type: 'error'; error: ApiErrorBody['error']; document?: CloudDocument };
