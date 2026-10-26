<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Framework7 from 'framework7/lite-bundle';
  import {
    renderMarkdownToHtml,
    buildAnnotatedMarkdown,
    buildAiPrompt,
    extractEmbeddedClipsFromMarkdown,
    getSnippetAround,
    resolveSafeOffset,
    type ClipAnnotation
  } from './lib/markdown';
  import {
    resolveMarkdownOffsetFromPoint,
    mountPaperclipsIntoDom
  } from './lib/dom-mapper';
  import {
    loadAiSettings,
    saveAiSettings,
    requestAiAnnotationReply,
    type AiSettings
  } from './lib/ai-client';
  import {
    DEFAULT_SAMPLE_FILENAME,
    DEFAULT_SAMPLE_MARKDOWN,
    pickRandomClipColor
  } from './lib/sample-doc';

  // Document & Clips State
  let fileName = $state<string>(DEFAULT_SAMPLE_FILENAME);
  let baseMarkdown = $state<string>(DEFAULT_SAMPLE_MARKDOWN);
  let clips = $state<ClipAnnotation[]>([]);
  let selectedClipId = $state<string | null>(null); // Right panel hidden by default!

  // Long-press state for progressive 📎 placement
  const LONG_PRESS_DURATION_MS = 520;
  const MOVE_CANCEL_THRESHOLD_PX = 12;

  let isLongPressing = $state<boolean>(false);
  let pressProgress = $state<number>(0); // 0..1
  let pressClientX = $state<number>(0);
  let pressClientY = $state<number>(0);
  let pressColor = $state<string>('#c85a32');
  let pressTargetOffset = $state<number>(0);
  let pressAdjustedInfo = $state<{ adjusted: boolean; reason?: string }>({ adjusted: false });

  let pressTimerId: number | null = null;
  let pressRafId: number | null = null;
  let pressStartTime = 0;
  let justPlacedClipTimestamp = 0;

  // Right Panel Chat Input & AI Request State
  let draftInput = $state<string>('');
  let isRequestingAi = $state<boolean>(false);
  let aiErrorMsg = $state<string | null>(null);

  // Settings & Source Preview Modals
  let aiSettings = $state<AiSettings>(loadAiSettings());
  let showSettingsModal = $state<boolean>(false);
  let showMarkdownModal = $state<boolean>(false);
  let toastMessage = $state<string | null>(null);
  let toastTimer: number | null = null;

  // DOM References
  let fileInputEl: HTMLInputElement | undefined = $state();
  let markdownContainerEl: HTMLElement | undefined = $state();
  let messagesScrollEl: HTMLElement | undefined = $state();
  let f7Instance: Framework7 | null = null;

  // Derived values
  let renderedDoc = $derived(renderMarkdownToHtml(baseMarkdown));
  let activeClip = $derived(clips.find((c) => c.id === selectedClipId) ?? null);
  let annotatedMarkdownPreview = $derived(
    buildAnnotatedMarkdown(baseMarkdown, clips, selectedClipId ?? undefined)
  );
  let fullPromptPreview = $derived(
    selectedClipId
      ? buildAiPrompt(baseMarkdown, clips, selectedClipId).prompt
      : buildAnnotatedMarkdown(baseMarkdown, clips)
  );

  function showToast(msg: string, duration = 2600) {
    toastMessage = msg;
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastMessage = null;
    }, duration);
  }

  onMount(() => {
    try {
      f7Instance = new Framework7({
        el: '#app',
        name: 'CoachMe',
        theme: 'ios'
      });
    } catch {
      // Framework7 core initialized
    }

    syncClipsToDom();
  });

  // Whenever rendered HTML, clips, or selectedClipId changes, re-mount interactive 📎 pins in the DOM
  $effect(() => {
    const _html = renderedDoc.html;
    const _clipsSnapshot = clips.map((c) => `${c.id}:${c.offset}:${c.messages.length}:${c.color}`).join('|');
    const _selected = selectedClipId;

    if (markdownContainerEl && _html !== undefined) {
      tick().then(() => {
        if (!markdownContainerEl) return;
        mountPaperclipsIntoDom(
          markdownContainerEl,
          baseMarkdown,
          clips,
          _selected,
          (clickedId) => {
            selectedClipId = clickedId;
            aiErrorMsg = null;
          }
        );
      });
    }
  });

  function syncClipsToDom() {
    if (!markdownContainerEl) return;
    mountPaperclipsIntoDom(
      markdownContainerEl,
      baseMarkdown,
      clips,
      selectedClipId,
      (clickedId) => {
        selectedClipId = clickedId;
        aiErrorMsg = null;
      }
    );
  }

  // File Picker Dialog Logic
  function openMarkdownFileDialog() {
    fileInputEl?.click();
  }

  async function handleFileSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const rawText = await file.text();
    loadMarkdownContent(file.name, rawText);
    input.value = '';
  }

  function loadMarkdownContent(name: string, rawText: string) {
    const extracted = extractEmbeddedClipsFromMarkdown(rawText);
    fileName = name;
    baseMarkdown = extracted.cleanMarkdown;
    clips = extracted.clips;
    selectedClipId = null; // Default right column hidden
    aiErrorMsg = null;
    showToast(`已加载文档「${name}」${extracted.clips.length > 0 ? `（含 ${extracted.clips.length} 处批注）` : ''}`);
  }

  // Long-press gesture on the left Markdown document
  function handleDocPointerDown(event: PointerEvent) {
    // Only primary mouse button or touch
    if (event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (!target || !markdownContainerEl) return;

    // Ignore if user clicked on an existing 📎 paperclip badge
    if (target.closest('.clip-anchor-pin')) {
      return;
    }

    cancelLongPress();

    const lastColor = clips[clips.length - 1]?.color;
    pressColor = pickRandomClipColor(lastColor);
    pressClientX = event.clientX;
    pressClientY = event.clientY;
    pressStartTime = performance.now();
    pressProgress = 0.06;
    isLongPressing = true;

    const lookup = resolveMarkdownOffsetFromPoint(
      markdownContainerEl,
      baseMarkdown,
      event.clientX,
      event.clientY
    );
    pressTargetOffset = lookup.safeOffset;
    pressAdjustedInfo = { adjusted: lookup.adjusted, reason: lookup.reason };

    const updateProgress = () => {
      if (!isLongPressing) return;
      const elapsed = performance.now() - pressStartTime;
      pressProgress = Math.min(1, elapsed / LONG_PRESS_DURATION_MS);
      if (pressProgress < 1) {
        pressRafId = window.requestAnimationFrame(updateProgress);
      }
    };
    pressRafId = window.requestAnimationFrame(updateProgress);

    pressTimerId = window.setTimeout(() => {
      finalizePaperclipPlacement();
    }, LONG_PRESS_DURATION_MS);
  }

  function handleDocPointerMove(event: PointerEvent) {
    if (!isLongPressing) return;
    const dist = Math.hypot(event.clientX - pressClientX, event.clientY - pressClientY);
    if (dist > MOVE_CANCEL_THRESHOLD_PX) {
      cancelLongPress();
    }
  }

  function handleDocPointerUp() {
    if (!isLongPressing) return;
    cancelLongPress();
  }

  function cancelLongPress() {
    isLongPressing = false;
    pressProgress = 0;
    if (pressTimerId !== null) {
      window.clearTimeout(pressTimerId);
      pressTimerId = null;
    }
    if (pressRafId !== null) {
      window.cancelAnimationFrame(pressRafId);
      pressRafId = null;
    }
  }

  function finalizePaperclipPlacement() {
    const targetOffset = resolveSafeOffset(baseMarkdown, pressTargetOffset).offset;
    const newClipId = `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const snippet = getSnippetAround(baseMarkdown, targetOffset);

    const newClip: ClipAnnotation = {
      id: newClipId,
      color: pressColor,
      offset: targetOffset,
      anchorSnippet: snippet,
      messages: [],
      createdAt: Date.now()
    };

    const wasAdjusted = pressAdjustedInfo.adjusted;
    const adjustReason = pressAdjustedInfo.reason;

    cancelLongPress();
    justPlacedClipTimestamp = performance.now();

    clips = [...clips, newClip];
    selectedClipId = newClipId;
    aiErrorMsg = null;

    if (wasAdjusted) {
      showToast(`已遵循最小避让原则微调位置（避开 ${adjustReason || '公式/语法边界'}）并放置 📎`);
    } else {
      showToast('已放置曲别针 📎，可在右栏输入批注与 AI 对话');
    }
  }

  // Click on document area without paperclip hides right column
  function handleDocClick(event: MouseEvent) {
    // Do not immediately hide right column if this click event is the tail end of a long-press placement
    if (performance.now() - justPlacedClipTimestamp < 350) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest('.clip-anchor-pin')) {
      return;
    }

    // Ignore if user was selecting text range
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      return;
    }

    if (selectedClipId !== null) {
      selectedClipId = null;
      aiErrorMsg = null;
    }
  }

  // Send user annotation message and trigger single-shot AI reply
  async function handleSendAnnotation() {
    const content = draftInput.trim();
    if (!content || !selectedClipId || isRequestingAi) return;

    const targetId = selectedClipId;
    draftInput = '';
    aiErrorMsg = null;

    const userTurnId = `u-${Date.now()}`;
    const placeholderTurnId = `ai-${Date.now()}`;

    // 1. Append user message to the selected clip
    clips = clips.map((c) => {
      if (c.id !== targetId) return c;
      return {
        ...c,
        messages: [
          ...c.messages,
          { id: userTurnId, role: 'user', content }
        ]
      };
    });

    await tick();
    scrollToBottomOfMessages();

    // 2. Call AI with the full annotated Markdown (which automatically appends <!--AI_REPLY_PLACEHOLDER--> for the unanswered user message)
    isRequestingAi = true;
    try {
      const result = await requestAiAnnotationReply({
        baseMarkdown,
        clips,
        targetClipId: targetId,
        settings: aiSettings
      });

      clips = clips.map((c) => {
        if (c.id !== targetId) return c;
        return {
          ...c,
          messages: [
            ...c.messages,
            {
              id: placeholderTurnId,
              role: 'ai',
              content: result.htmlReply
            }
          ]
        };
      });

      await tick();
      scrollToBottomOfMessages();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      aiErrorMsg = `AI 请求失败：${message}`;
    } finally {
      isRequestingAi = false;
    }
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSendAnnotation();
    }
  }

  function removeCurrentClip() {
    if (!selectedClipId) return;
    const idToRemove = selectedClipId;
    clips = clips.filter((c) => c.id !== idToRemove);
    selectedClipId = null;
    showToast('已移除该枚曲别针批注');
  }

  function scrollToBottomOfMessages() {
    if (messagesScrollEl) {
      messagesScrollEl.scrollTop = messagesScrollEl.scrollHeight;
    }
  }

  function handleSaveSettings() {
    saveAiSettings(aiSettings);
    showSettingsModal = false;
    showToast('AI 端点与密钥配置已保存');
  }

  function exportAnnotatedMarkdownFile() {
    const fullMd = buildAnnotatedMarkdown(baseMarkdown, clips);
    const blob = new Blob([fullMd], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName.replace(/\.md$/i, '') + '.annotated.md';
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出带 <aside> 批注语义的 Markdown 文件');
  }
</script>

<div class="framework7-root kami-shell" data-testid="app-shell">
  <!-- Hidden native file input triggered by toolbar button -->
  <input
    bind:this={fileInputEl}
    type="file"
    accept=".md,.markdown,text/markdown,text/plain"
    style="display: none;"
    data-testid="markdown-file-input"
    onchange={handleFileSelected}
  />

  <!-- Top Navbar (Framework7 + Kami style) -->
  <header class="navbar kami-navbar">
    <div class="kami-brand">
      <span class="kami-logo-seal">紙</span>
      <div class="kami-title-group">
        <span class="kami-app-title">CoachMe · Kami 纸笺批注</span>
        <span class="kami-doc-subtitle" data-testid="current-filename">
          <span>📄 {fileName}</span>
          <span>·</span>
          <span data-testid="clip-total-count">{clips.length} 枚曲别针</span>
        </span>
      </div>
    </div>

    <div class="kami-toolbar-actions">
      <button
        type="button"
        class="kami-btn kami-btn-primary"
        data-testid="open-file-btn"
        onclick={openMarkdownFileDialog}
      >
        <span>📂 打开 Markdown 文件</span>
      </button>

      <button
        type="button"
        class="kami-btn"
        data-testid="preview-annotated-md-btn"
        onclick={() => (showMarkdownModal = true)}
      >
        <span>🔍 查看批注源文</span>
      </button>

      <button
        type="button"
        class="kami-btn"
        data-testid="open-settings-btn"
        onclick={() => (showSettingsModal = true)}
      >
        <span>⚙️ AI 端点设置</span>
      </button>
    </div>
  </header>

  <!-- Main Workspace: Left Reader + Right Annotation Drawer -->
  <main class="kami-workspace">
    <!-- Left Column: Markdown Reader -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section
      class="kami-reader-pane"
      data-testid="left-reader-pane"
      onpointerdown={handleDocPointerDown}
      onpointermove={handleDocPointerMove}
      onpointerup={handleDocPointerUp}
      onpointercancel={handleDocPointerUp}
      onclick={handleDocClick}
    >
      <article class="kami-paper-sheet" data-testid="markdown-paper-sheet">
        <div class="kami-sheet-meta">
          <span>Kami Paper Edition · Markdown &amp; KaTeX</span>
          <span class="kami-sheet-hint">
            💡 鼠标长按任意段落放置彩色 📎 曲别针 · 点击空白处隐藏右栏
          </span>
        </div>

        <div
          bind:this={markdownContainerEl}
          class="kami-markdown-body"
          data-testid="markdown-rendered-body"
        >
          {@html renderedDoc.html}
        </div>
      </article>
    </section>

    <!-- Right Column: Conversational Annotation Panel (Hidden by default) -->
    {#if activeClip}
      <aside
        class="kami-annotation-drawer"
        data-testid="right-annotation-panel"
        style="--clip-accent: {activeClip.color}"
      >
        <div class="drawer-header">
          <div class="drawer-header-top">
            <div class="drawer-clip-badge">
              <span
                class="drawer-color-dot"
                style="background-color: {activeClip.color}"
              ></span>
              <span>📎 对话式批注</span>
              <span style="font-size: 11.5px; color: var(--kami-ink-muted); font-weight: 500;">
                (#{activeClip.id.slice(-5)} · 偏移 {activeClip.offset})
              </span>
            </div>

            <div style="display: flex; align-items: center; gap: 6px;">
              <button
                type="button"
                class="kami-btn"
                style="padding: 4px 9px; font-size: 12px;"
                data-testid="delete-clip-btn"
                onclick={removeCurrentClip}
                title="移除此枚曲别针"
              >
                删除 📎
              </button>
              <button
                type="button"
                class="kami-btn"
                style="padding: 4px 9px; font-size: 12px;"
                data-testid="close-drawer-btn"
                onclick={() => (selectedClipId = null)}
                title="隐藏右栏"
              >
                ✕
              </button>
            </div>
          </div>

          <div class="drawer-anchor-preview" data-testid="drawer-anchor-snippet" title={activeClip.anchorSnippet}>
            锚点：{activeClip.anchorSnippet}
          </div>
        </div>

        <!-- Messages List -->
        <div
          bind:this={messagesScrollEl}
          class="drawer-messages"
          data-testid="annotation-messages-list"
        >
          {#if activeClip.messages.length === 0 && !isRequestingAi}
            <div class="drawer-empty-state" data-testid="drawer-empty-hint">
              <div style="font-size: 28px; margin-bottom: 8px;">📎</div>
              <div>曲别针已别在文档第 <strong>{activeClip.offset}</strong> 字符处。</div>
              <div>在下方输入你的批注或疑问，AI 将通读全文并在该曲别针位置给出高信息量批注回复。</div>
            </div>
          {/if}

          {#each activeClip.messages as msg (msg.id)}
            {#if msg.role === 'user'}
              <div class="chat-bubble-card chat-bubble-user" data-testid="chat-turn-user">
                <div class="chat-role-header">
                  <span>✍️ 用户批注</span>
                </div>
                <div style="white-space: pre-wrap;">{msg.content}</div>
              </div>
            {:else}
              <div class="chat-bubble-card chat-bubble-ai" data-testid="chat-turn-ai">
                <div class="chat-role-header">
                  <span>🤖 AI 深度批注</span>
                  <span>HTML</span>
                </div>
                <div class="chat-ai-html-content" data-testid="chat-ai-html">
                  {@html msg.content}
                </div>
              </div>
            {/if}
          {/each}

          {#if isRequestingAi}
            <div class="chat-bubble-card chat-bubble-ai" data-testid="chat-ai-loading">
              <div class="chat-role-header">
                <span>🤖 AI 正在旁征博引生成批注...</span>
              </div>
              <div style="color: var(--kami-ink-muted); font-size: 13px;">
                正在读取全文与 <code>&lt;!--AI_REPLY_PLACEHOLDER--&gt;</code> 上下文...
              </div>
            </div>
          {/if}

          {#if aiErrorMsg}
            <div
              class="chat-bubble-card"
              style="border-color: #d9534f; background: #fff5f5; color: #b52b27; font-size: 12.5px;"
              data-testid="chat-ai-error"
            >
              {aiErrorMsg}
            </div>
          {/if}
        </div>

        <!-- Bottom Input Composer -->
        <div class="drawer-composer">
          <textarea
            class="composer-textarea"
            data-testid="annotation-input"
            placeholder="在此输入批注内容，按 Enter 发送（Shift+Enter 换行）..."
            bind:value={draftInput}
            disabled={isRequestingAi}
            onkeydown={handleComposerKeydown}
          ></textarea>
          <div class="composer-footer">
            <span class="composer-tip">单次全文 Markdown + &lt;aside&gt; 注入</span>
            <button
              type="button"
              class="kami-btn kami-btn-primary"
              data-testid="send-annotation-btn"
              disabled={!draftInput.trim() || isRequestingAi}
              onclick={handleSendAnnotation}
            >
              {isRequestingAi ? '生成中...' : '发送批注'}
            </button>
          </div>
        </div>
      </aside>
    {/if}
  </main>

  <!-- Progressive Long-press Ghost Paperclip 📎 -->
  {#if isLongPressing}
    <div
      class="longpress-ghost-clip"
      data-testid="longpress-ghost-clip"
      style="left: {pressClientX}px; top: {pressClientY}px; opacity: {0.25 + pressProgress * 0.75};"
    >
      <div
        class="longpress-ring-wrap"
        style="border: 3px solid {pressColor}; background: color-mix(in srgb, {pressColor} {Math.round(pressProgress * 32)}%, #fbfaf7);"
      >
        <span
          class="longpress-emoji"
          style="transform: scale({0.75 + pressProgress * 0.45}) rotate({(1 - pressProgress) * -25}deg);"
        >
          📎
        </span>
      </div>
      <span class="longpress-caption" style="background: {pressColor};">
        {Math.round(pressProgress * 100)}% 长按别上曲别针
      </span>
    </div>
  {/if}

  <!-- AI Settings Modal (Custom baseURL, API Key, Model) -->
  {#if showSettingsModal}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="kami-modal-backdrop"
      data-testid="settings-modal-backdrop"
      onclick={(e) => {
        if (e.target === e.currentTarget) showSettingsModal = false;
      }}
    >
      <div class="kami-modal-card" data-testid="settings-modal">
        <div class="kami-modal-header">
          <span>⚙️ OpenAI-Compatible AI 端点设置</span>
          <button
            type="button"
            class="kami-btn"
            style="padding: 4px 10px;"
            onclick={() => (showSettingsModal = false)}
          >
            关闭
          </button>
        </div>

        <div class="kami-modal-body">
          <div class="kami-field">
            <label for="ai-base-url">Base URL (OpenAI 兼容接口地址)</label>
            <input
              id="ai-base-url"
              class="kami-input"
              data-testid="settings-baseurl-input"
              type="text"
              placeholder="https://api.openai.com/v1"
              bind:value={aiSettings.baseURL}
            />
          </div>

          <div class="kami-field">
            <label for="ai-api-key">API Key (密钥)</label>
            <input
              id="ai-api-key"
              class="kami-input"
              data-testid="settings-apikey-input"
              type="password"
              placeholder="sk-..."
              bind:value={aiSettings.apiKey}
            />
          </div>

          <div class="kami-field">
            <label for="ai-model-id">模型名称 (Model ID)</label>
            <input
              id="ai-model-id"
              class="kami-input"
              data-testid="settings-model-input"
              type="text"
              placeholder="gpt-4o-mini"
              bind:value={aiSettings.model}
            />
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px;">
            <button
              type="button"
              class="kami-btn"
              onclick={() => (showSettingsModal = false)}
            >
              取消
            </button>
            <button
              type="button"
              class="kami-btn kami-btn-primary"
              data-testid="save-settings-btn"
              onclick={handleSaveSettings}
            >
              保存配置
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Annotated Markdown & AI Prompt Inspection Modal -->
  {#if showMarkdownModal}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="kami-modal-backdrop"
      data-testid="markdown-modal-backdrop"
      onclick={(e) => {
        if (e.target === e.currentTarget) showMarkdownModal = false;
      }}
    >
      <div class="kami-modal-card" style="max-width: 720px;" data-testid="markdown-modal">
        <div class="kami-modal-header">
          <span>📜 注入 &lt;aside class="annotation"&gt; 后的 Markdown 原文</span>
          <div style="display: flex; gap: 8px;">
            <button
              type="button"
              class="kami-btn"
              style="padding: 4px 10px; font-size: 12px;"
              onclick={exportAnnotatedMarkdownFile}
            >
              💾 导出 Markdown
            </button>
            <button
              type="button"
              class="kami-btn"
              style="padding: 4px 10px; font-size: 12px;"
              data-testid="close-markdown-modal-btn"
              onclick={() => (showMarkdownModal = false)}
            >
              关闭
            </button>
          </div>
        </div>

        <div class="kami-modal-body">
          <div style="font-size: 12.5px; color: var(--kami-ink-secondary);">
            AI 只读 Markdown 原文，所有曲别针均以语义化 HTML <code>&lt;aside class="annotation" data-clip="..."&gt;</code> 精确嵌入对应位置（遵循最小避让原则，不破坏数学公式等结构）：
          </div>
          <pre class="kami-code-preview" data-testid="annotated-markdown-code">{annotatedMarkdownPreview}</pre>

          <div style="font-size: 12.5px; color: var(--kami-ink-secondary);">
            发送给 AI 的完整单轮 Prompt 预览：
          </div>
          <pre class="kami-code-preview" data-testid="ai-prompt-preview-code">{fullPromptPreview}</pre>
        </div>
      </div>
    </div>
  {/if}

  {#if toastMessage}
    <div class="kami-toast" data-testid="kami-toast">
      {toastMessage}
    </div>
  {/if}
</div>
