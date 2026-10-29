/**
 * Encyclopedia ("百科条目") drafting: prompt + post-processing for a
 * Wikipedia-style Markdown article generated from an arbitrary user brief.
 */

import { AI_PROSE_STYLE } from '../src/lib/markdown';

export const WIKI_MAX_PROMPT_LENGTH = 4_000;
export const WIKI_MAX_MARKDOWN_LENGTH = 120_000;
const MAX_TITLE_LENGTH = 120;

export const WIKI_SYSTEM_PROMPT = [
  '你是一名资深的维基百科（Wikipedia）条目编辑。',
  '根据用户给出的任意提示（可能是一个主题词、一句话、一段要求或素材），自行拟定一个恰当的条目标题，并撰写一篇采用 Wikipedia 体例（结构与体裁）的百科条目。',
  '',
  '输出格式要求（严格遵守）：',
  '1. 只输出条目本身的 Markdown，不要任何前言、解释、寒暄或结束语，不要用代码围栏包裹全文。',
  '2. 第一行必须是一级标题：`# 条目标题`。标题简洁、名词性、符合百科命名习惯（必要时可用括号消歧义）。',
  '3. 标题之后紧接一段或数段不带小标题的导言（lead section）：首句以**加粗的条目名**开头，给出定义与最重要的事实，概括全文。',
  '4. 正文使用 `##` / `###` 分节，按主题选择合适的章节，例如：概述、名称/词源、历史、特征/原理、分类、应用、影响、争议与批评、参见。',
  '5. 体例遵循 Wikipedia：中立、第三人称、信息密度高；不确定的内容用审慎措辞。',
  '6. 可使用列表、表格、引用和 LaTeX 数学公式（行内 `$...$`，独立 `$$...$$`）；不要输出 HTML 标签。',
  '7. 不要编造具体的网址、ISBN、DOI 或页码；如需「参考资料」，只给出通用、可核实的描述。',
  '8. 正文语言跟随用户提示的语言；若无法判断，使用简体中文。',
  '',
  '语言风格（体例仍是 Wikipedia，但行文遵循以下要求）：',
  AI_PROSE_STYLE
].join('\n');

export function buildWikiUserPrompt(brief: string): string {
  return `请根据以下提示撰写百科条目：\n\n${brief.trim()}`;
}

function stripOuterFence(text: string): string {
  const fence = text.match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n?```\s*$/i);
  return fence && fence[1] !== undefined ? fence[1].trim() : text;
}

function plainTitle(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~#<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turn any title into a safe document file name ending in `.md`. */
export function wikiDocumentName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
  return `${base || '百科条目'}.md`;
}

/**
 * Normalise the model output into the stored article: strip a wrapping code
 * fence, guarantee a leading `# Title` and derive the document name from it.
 */
export function finalizeWikiMarkdown(
  raw: string,
  brief: string
): { title: string; name: string; markdown: string } {
  let markdown = stripOuterFence(raw.replace(/\r\n?/g, '\n').trim());
  // Drop any chatter before the first heading if the model added a preface.
  const firstH1 = markdown.search(/^#[ \t]+\S/m);
  if (firstH1 > 0 && firstH1 < 400) markdown = markdown.slice(firstH1);

  const h1 = markdown.match(/^#[ \t]+(.+?)[ \t#]*$/m);
  let title = h1 && h1[1] ? plainTitle(h1[1]) : '';
  if (!h1 || markdown.indexOf(h1[0]) !== 0 || !title) {
    title = title || plainTitle(brief.split('\n')[0] ?? '').slice(0, 40) || '百科条目';
    if (!h1 || markdown.indexOf(h1[0]) !== 0) markdown = `# ${title}\n\n${markdown}`;
  }
  title = title.slice(0, MAX_TITLE_LENGTH);
  return { title, name: wikiDocumentName(title), markdown: `${markdown.trim()}\n` };
}
