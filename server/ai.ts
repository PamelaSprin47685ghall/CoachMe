import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import sanitizeHtml from 'sanitize-html';

export const MAX_CONTENT_LENGTH = 20_000;
export const MAX_REASONING_LENGTH = 100_000;

/**
 * Apply user-configured reasoning/thinking level string (`reasoningEffort`) to an
 * OpenAI-compatible request body.
 *
 * - Empty string: leaves request untouched.
 * - Boolean-like strings (`"true"` / `"false"` / `"1"` / `"0"` / `"on"` / `"off"`):
 *   sets `enable_thinking` boolean (DashScope / Qwen / CTYun) and `thinking: { type: "enabled" | "disabled" }` (Zhipu GLM).
 * - Custom JSON object string (e.g. `{"enable_thinking":true,"thinking_budget":4096}`):
 *   merges parsed keys into the request body.
 * - Reasoning level strings (e.g. `"low"` / `"medium"` / `"high"` / `"max"` / `"minimal"`):
 *   sets `reasoning_effort: level`, `enable_thinking: true`, and `thinking: { type: "enabled" }` (unless `"none"` / `"disabled"`,
 *   which sets `enable_thinking: false`).
 */
export function applyReasoningEffortToRequestBody(
  args: Record<string, unknown>,
  rawReasoningEffort: string
): Record<string, unknown> {
  const effort = rawReasoningEffort.trim();
  if (!effort) return args;

  if (effort.startsWith('{') && effort.endsWith('}')) {
    try {
      const parsed: unknown = JSON.parse(effort);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...args, ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Fall through to string handling
    }
  }

  const lower = effort.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'enabled' || lower === 'enable') {
    return {
      ...args,
      enable_thinking: true,
      thinking: { type: 'enabled' }
    };
  }
  if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'disabled' || lower === 'disable') {
    return {
      ...args,
      enable_thinking: false,
      thinking: { type: 'disabled' }
    };
  }
  if (lower === 'none') {
    return {
      ...args,
      reasoning_effort: effort,
      enable_thinking: false,
      thinking: { type: 'disabled' }
    };
  }

  // Standard effort levels like "low", "medium", "high", "max" or provider-specific strings
  return {
    ...args,
    reasoning_effort: effort,
    enable_thinking: true,
    thinking: { type: 'enabled' }
  };
}

/**
 * Clean and sanitize AI HTML response so it is light-formatted HTML without outer code fences
 * or outer <blockquote> / <footer> wrappers.
 * Returns empty string if the input is empty or contains no content.
 */
export function normalizeAiHtmlReply(rawText: string): string {
  let cleaned = rawText.trim();
  if (!cleaned) return '';

  // Strip ```html ... ``` code fences if the model wrapped its output
  const fenceMatch = cleaned.match(/^```(?:html|xml)?\s*\n([\s\S]*?)\n?```$/i);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }

  // Strip outer <aside> or <blockquote> wrapper if the model echoed the container
  const bqMatch = cleaned.match(/^<blockquote>([\s\S]*?)(?:<footer>\s*AI\s*<\/footer>)?\s*<\/blockquote>$/i);
  if (bqMatch && bqMatch[1]) {
    cleaned = bqMatch[1].trim();
  }

  // Remove any leftover <!--AI_REPLY_PLACEHOLDER--> comment
  cleaned = cleaned.replace(/<!--\s*AI_REPLY_PLACEHOLDER\s*-->/g, '').trim();

  if (!cleaned) return '';

  // If plain text without HTML tags was returned, wrap paragraphs in <p>
  if (!/<[a-z][\s\S]*>/i.test(cleaned)) {
    cleaned = cleaned
      .split(/\n{2,}/)
      .map((para) => `<p>${escapeTextForHtml(para.trim()).replace(/\n/g, '<br/>')}</p>`)
      .join('\n');
  }

  const sanitized = sanitizeHtml(cleaned, {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre',
      'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'h5', 'span', 'div',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'sup', 'sub', 'mark', 'a'
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (tagName, attribs) => {
        return {
          tagName,
          attribs: {
            ...attribs,
            rel: 'noopener noreferrer'
          }
        };
      }
    }
  });

  return sanitized.trim();
}

function escapeTextForHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Logs only a generic provider failure classification for the AI SDK `onError` observer.
 * Never logs the full error object, `requestBodyValues` (which contains the private
 * document prompt), vendor URL, response body, or Authorization header.
 */
function logProviderErrorSafely(error: unknown): void {
  if (error && typeof error === 'object') {
    const name = 'name' in error && typeof error.name === 'string' ? error.name : 'AIProviderError';
    const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : null;
    if (statusCode !== null) {
      console.error(`AI provider request failed: ${name} (status ${statusCode})`);
    } else {
      console.error(`AI provider request failed: ${name}`);
    }
    return;
  }
  console.error('AI provider request failed: unknown error');
}

export interface AiStreamParams {
  prompt: string;
  aiConfig: {
    baseURL: string;
    apiKey: string;
    model: string;
    reasoningEffort: string;
  };
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
}

export type AiStreamChunk =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string };

/**
 * Execute AI streaming call against configured OpenAI-compatible backend using a trusted
 * server-built prompt string.
 * Yields `{ type: 'reasoning', delta }` and `{ type: 'text', delta }` chunks,
 * and returns the final sanitized HTML reply and accumulated reasoning.
 *
 * Guarantees that outputs strictly satisfy maximum length bounds (MAX_CONTENT_LENGTH, MAX_REASONING_LENGTH)
 * so persisted messages remain valid for subsequent PUT updates.
 */
export async function* streamAiAnnotationReply(
  params: AiStreamParams
): AsyncGenerator<AiStreamChunk, { htmlReply: string; reasoningText: string }, void> {
  const { prompt, aiConfig, fetch: customFetch, abortSignal } = params;

  const baseURL = aiConfig.baseURL.trim().replace(/\/+$/, '');
  const apiKey = aiConfig.apiKey.trim() || 'sk-no-key-required';
  const modelId = aiConfig.model.trim() || 'gpt-4o-mini';
  const reasoningEffort = (aiConfig.reasoningEffort ?? '').trim();

  const provider = createOpenAICompatible({
    name: 'margintalk-server-ai',
    baseURL,
    apiKey,
    fetch: customFetch ?? fetch,
    transformRequestBody: (args) => applyReasoningEffortToRequestBody(args, reasoningEffort)
  });

  const result = streamText({
    model: provider.chatModel(modelId),
    prompt,
    maxRetries: 0,
    abortSignal,
    onError: ({ error }) => {
      logProviderErrorSafely(error);
    }
  });

  let reasoningText = '';
  let text = '';

  for await (const part of result.fullStream) {
    if (abortSignal?.aborted) {
      throw new Error('AI stream aborted');
    }
    if (part.type === 'reasoning-delta') {
      if (part.text) {
        reasoningText += part.text;
        if (reasoningText.length > MAX_REASONING_LENGTH) {
          throw new Error('AI reasoning exceeded maximum allowed length limit');
        }
        yield { type: 'reasoning', delta: part.text };
      }
    } else if (part.type === 'text-delta') {
      if (part.text) {
        text += part.text;
        if (text.length > MAX_CONTENT_LENGTH) {
          throw new Error('AI response exceeded maximum allowed length limit');
        }
        yield { type: 'text', delta: part.text };
      }
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  if (!text) {
    try {
      text = await result.text;
    } catch {
      // Ignored
    }
  }

  if (!reasoningText) {
    try {
      const resolvedReasoning = await result.reasoningText;
      if (resolvedReasoning) {
        reasoningText = resolvedReasoning;
      }
    } catch {
      // Ignored
    }
  }

  if (reasoningText.length > MAX_REASONING_LENGTH) {
    throw new Error('AI reasoning exceeded maximum allowed length limit');
  }

  const htmlReply = normalizeAiHtmlReply(text);
  if (!htmlReply) {
    throw new Error('AI returned an empty response');
  }
  if (htmlReply.length > MAX_CONTENT_LENGTH) {
    throw new Error('AI response exceeded maximum allowed length limit');
  }

  return {
    htmlReply,
    reasoningText: reasoningText.trim()
  };
}
