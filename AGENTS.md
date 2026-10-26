写一个 bun 工程，要求用 svelte framework7 实现，支持在界面上单击打开选择 Markdown 文件的对话框，并渲染出来。这是左栏。支持鼠标长按某处，然后就在文档此处逐渐放一个半透明的📎，颜色随机，按足够长时间就确定放置了，然后右栏是批注：用户可以在最下面输入并发送。与传统批注不同的是，批注是双人对话的形式，用户和 AI 对话式批注。AI 用 ai-sdk 实现，支持自定义 baseURL 和 Key，openai-compatible 端点。点击已经放置的其他曲别针可以看到其他对话。点击文档无曲别针处，可以隐藏右栏。默认右栏隐藏。长按文档无曲别针处，可以放新对话。发给 AI 的请求是 你是一个文档阅读助手，全文如下：... 其中把每个曲别针渲染成 HTML 关于对话的语义，就放置在曲别针处，如果用户刚刚输出的批注还没有回复，就往最后加个 AI 占位符。注意不要破坏 markdown 语义，例如数学公式的半中间不要放曲别针（微调位置,精确插入到坐标位置，最小避让原则）。最后告诉 AI，输出占位符处你的批注式回复。整个过程不用工具，也不用多轮对话。界面要美观大方。使用 https://github.com/tw93/kami 的视觉风格。所有依赖用最新版本。AI 不读 html，AI 只读 MarkDown.插入的曲别针可以是 html in origin markdown.


<aside class="annotation" data-clip="...">
  <blockquote>
    <p>消息内容</p>
    <footer>用户</footer>
  </blockquote>
  <blockquote>
    <!--AI_REPLY_PLACEHOLDER-->
    <footer>AI</footer>
  </blockquote>
</aside> 要求 AI 以轻度格式的 HTML 回复，信息量要大。

要求实际测试通过交付。