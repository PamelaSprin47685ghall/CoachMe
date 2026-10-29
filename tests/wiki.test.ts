import { describe, expect, test } from 'bun:test';
import { buildWikiUserPrompt, finalizeWikiMarkdown, wikiDocumentName, WIKI_SYSTEM_PROMPT } from '../server/wiki';

describe('wiki drafting', () => {
  test('system prompt asks for a Wikipedia-style article with an H1 title', () => {
    expect(WIKI_SYSTEM_PROMPT).toContain('Wikipedia');
    expect(WIKI_SYSTEM_PROMPT).toContain('# 条目标题');
    expect(WIKI_SYSTEM_PROMPT).toContain('Follow Fei Xiaotong’s plain precision and Shi Tiesheng’s quiet clarity. Avoid officialese, performative rhetoric, translationese, and textbook cadence. Let the subject shape the prose.');
    expect(buildWikiUserPrompt('  量子纠缠  ')).toContain('量子纠缠');
  });

  test('keeps a well-formed article and derives the name from its title', () => {
    const out = finalizeWikiMarkdown('# 量子纠缠\n\n**量子纠缠**是……\n\n## 历史\n内容', '量子纠缠');
    expect(out.title).toBe('量子纠缠');
    expect(out.name).toBe('量子纠缠.md');
    expect(out.markdown.startsWith('# 量子纠缠\n')).toBe(true);
  });

  test('strips a wrapping code fence and leading chatter', () => {
    const out = finalizeWikiMarkdown('```markdown\n好的，以下是条目：\n# **长城** (建筑)\n\n正文\n```', '长城');
    expect(out.title).toBe('长城 (建筑)');
    expect(out.markdown.startsWith('# **长城** (建筑)')).toBe(true);
  });

  test('adds a heading from the brief when the model omitted one', () => {
    const out = finalizeWikiMarkdown('**猫**是一种哺乳动物。', '猫\n请写详细一些');
    expect(out.title).toBe('猫');
    expect(out.markdown.startsWith('# 猫\n\n**猫**')).toBe(true);
  });

  test('document names are filesystem safe', () => {
    expect(wikiDocumentName('a/b:c*?')).toBe('a b c.md');
    expect(wikiDocumentName('   ')).toBe('百科条目.md');
  });
});
