export const DEFAULT_SAMPLE_FILENAME = 'kami-reading-notes.md';

export const DEFAULT_SAMPLE_MARKDOWN = `# 纸笺深读：从信息洪流到批注式思考

> 「读书如交友，批注即切磋。」—— 在安静的纸张纹理上，将疑问化作一枚曲别针，与 AI 展开旁征博引的深度对话。

## 一、 为什么我们需要「对话式批注」？

传统的阅读笔记往往脱离原文上下文，而传统的电子书高亮又缺乏思考的延展。在 **CoachMe · Kami** 阅读器中，你可以在任意段落、公式或命题旁**长按鼠标**，缓缓别上一枚彩色曲别针 📎。

当你写下批注时，系统会将它以语义化 \`<aside class="annotation">\` 的形式精准嵌入原始 Markdown 的对应位置，并避免破坏任何行内结构。

## 二、 数学结构与最小避让原则

在科学文献阅读中，行内公式如爱因斯坦质能方程 $E = mc^2$ 或欧拉恒等式 $e^{i\\pi} + 1 = 0$ 是不可分割的语义原子。若你在公式内部长按，系统会遵循**最小避让原则（Minimal Avoidance Principle）**，自动微调坐标至公式边界之外。

再看一组经典的香农信息熵（Shannon Entropy）块级公式：

$$
H(X) = -\\sum_{i=1}^{n} P(x_i) \\log_2 P(x_i)
$$

其中 $P(x_i)$ 表示随机事件 $x_i$ 出现的概率。信息量越大，不确定性消除得越多——这也正是我们要求 AI 批注回复「以轻度格式 HTML 输出、高信息密度」的原因。

## 三、 结构化代码示例与行内代码

除数学公式外，行内代码如 \`resolveSafeOffset(markdown, offset)\` 以及代码块同样受到语法边界保护：

\`\`\`typescript
interface AnnotationClip {
  id: string;
  color: string;
  offset: number;
}
\`\`\`

### 操作指南

1. **打开文档**：点击顶部工具栏的「打开 Markdown 文件」按钮，选择任意本地 \`.md\` 文件渲染到左栏。
2. **长按放置 📎**：在正文任意位置**按住鼠标左键不放**，半透明随机色彩的曲别针会随进度环逐渐显现，蓄满即稳稳别在文档此处。
3. **对话式批注**：右栏自动展开该曲别针的专属双人批注流；在底部输入你的见解或追问并发送，AI 会基于全文与批注位置生成高信息量的 HTML 批注回复。
4. **自由切换与收起**：点击文档中已有的其他 📎 可切换查看对应对话；点击文档无曲别针空白处即可静默收起右栏。
`;

export const KAMI_CLIP_PALETTE = [
  '#d9534f', // 朱砂红 Cinnabar
  '#2e7d5b', // 竹青绿 Bamboo
  '#3a6ea5', // 靛青蓝 Indigo
  '#8c5383', // 暮山紫 Plum
  '#c67d30', // 琥珀金 Amber
  '#3d8b8b', // 苍山青 Teal
  '#b55239', // 赭石橙 Terracotta
  '#5b6291'  // 鼠尾草蓝 Slate
];

export function pickRandomClipColor(lastColor?: string): string {
  const pool = KAMI_CLIP_PALETTE.filter((c) => c !== lastColor);
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? KAMI_CLIP_PALETTE[0]!;
}
