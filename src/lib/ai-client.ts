import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import DOMPurify from 'dompurify';
import { buildAiPrompt, type ClipAnnotation } from './markdown';

export interface AiSettings {
  baseURL: string;
  apiKey: string;
  model: string;
}

const STORAGE_KEY = 'coachme_ai_settings_v1';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini'
};

export function loadAiSettings(): AiSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_AI_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      return {
        baseURL: typeof obj.baseURL === 'string' && obj.baseURL.trim() ? obj.baseURL.trim() : DEFAULT_AI_SETTINGS.baseURL,
        apiKey: typeof obj.apiKey === 'string' ? obj.apiKey.trim() : DEFAULT_AI_SETTINGS.apiKey,
        model: typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : DEFAULT_AI_SETTINGS.model
      };
    }
  } catch {
    // ignore storage errors
  }
  return { ...DEFAULT_AI_SETTINGS };
}

export function saveAiSettings(settings: AiSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

/**
 * Clean and sanitize AI HTML response so it is light-formatted HTML without outer code fences
 * or outer <blockquote> / <footer> wrappers.
 */
export function normalizeAiHtmlReply(rawText: string): string {
  let cleaned = rawText.trim();

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

  // If plain text without HTML tags was returned, wrap paragraphs in <p>
  if (!/<[a-z][\s\S]*>/i.test(cleaned)) {
    cleaned = cleaned
      .split(/\n{2,}/)
      .map((para) => `<p>${para.trim().replace(/\n/g, '<br/>')}</p>`)
      .join('\n');
  }

  if (typeof window !== 'undefined' && DOMPurify?.sanitize) {
    cleaned = DOMPurify.sanitize(cleaned, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre',
        'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'h5', 'span', 'div',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'sup', 'sub', 'mark', 'a'
      ],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'class']
    });
  }

  return cleaned || '<p>（已生成批注回复）</p>';
}

/**
 * Single-shot (no tools, no multi-turn messages array) AI annotation call using
 * `@ai-sdk/openai-compatible` + `ai` `generateText`.
 * Sends the full Markdown document with embedded `<aside class="annotation" data-clip="...">`
 * and `<!--AI_REPLY_PLACEHOLDER-->`.
 */
export async function requestAiAnnotationReply(params: {
  baseMarkdown: string;
  clips: ClipAnnotation[];
  targetClipId: string;
  settings: AiSettings;
}): Promise<{ htmlReply: string; promptSent: string; annotatedMarkdown: string }> {
  const { baseMarkdown, clips, targetClipId, settings } = params;
  const { prompt, annotatedMarkdown } = buildAiPrompt(baseMarkdown, clips, targetClipId);

  const baseURL = settings.baseURL.trim().replace(/\/+$/, '');
  const apiKey = settings.apiKey.trim() || 'sk-no-key-required';
  const modelId = settings.model.trim() || 'gpt-4o-mini';

  const provider = createOpenAICompatible({
    name: 'coachme-openai-compatible',
    baseURL,
    apiKey
  });

  const { text } = await generateText({
    model: provider.chatModel(modelId),
    prompt,
    maxRetries: 1
  });

  const htmlReply = normalizeAiHtmlReply(text);
  return {
    htmlReply,
    promptSent: prompt,
    annotatedMarkdown
  };
}
