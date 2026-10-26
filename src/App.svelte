<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Framework7 from 'framework7/lite-bundle';
  import DOMPurify from 'dompurify';
  import {
    renderMarkdownToHtml,
    buildAnnotatedMarkdown,
    buildAiPrompt,
    getSnippetAround,
    resolveSafeOffset,
    type ClipAnnotation
  } from './lib/markdown';
  import {
    resolveMarkdownOffsetFromPoint,
    mountPaperclipsIntoDom
  } from './lib/dom-mapper';
  import {
    ApiError,
    createDocument,
    deleteDocument,
    fetchSession,
    getDocument,
    listDocuments,
    logout as apiLogout,
    setCsrfToken,
    streamReply,
    updateDocument
  } from './lib/api-client';
  import type { CloudDocument, DocumentSummary, ReplyEvent, SessionInfo } from './lib/contracts';
  import {
    DEFAULT_SAMPLE_FILENAME,
    DEFAULT_SAMPLE_MARKDOWN,
    pickRandomClipColor
  } from './lib/sample-doc';

  // ---------------------------------------------------------------------------
  // Sanitization for untrusted HTML in this multi-user app.
  // Uploaded Markdown and stored AI HTML are attacker-controlled. DOMPurify is
  // used with the default HTML/SVG/MathML allowlists so that KaTeX markup and
  // the `data-md-start` / `data-md-end` offset attributes (required by the
  // long-press DOM→Markdown mapper) survive sanitization.
  // ---------------------------------------------------------------------------
  const OFFSET_ATTRS = ['data-md-start', 'data-md-end'];
  // KaTeX emits `<annotation encoding="application/x-tex">` inside its MathML
  // block, wrapped in `<semantics>`. Both are absent from DOMPurify's MathML
  // allowlist, so re-allow exactly these two instead of silently dropping the
  // whole accessibility subtree. `annotation-xml` stays forbidden: it is the
  // MathML→HTML integration (mXSS) vector and KaTeX never emits it.
  const KATEX_TAGS = ['semantics', 'annotation'];
  const KATEX_ATTRS = ['encoding'];

  // DOMPurify's default HTML allowlist keeps `style`, `link`, `form`, `input`,
  // `select`, `textarea`, `button` and `template`. Untrusted uploaded Markdown
  // must never inject UI overlays, fake login forms or external stylesheets
  // into a signed-in MarginTalk session, so forbid them explicitly (KaTeX
  // needs inline `style` *attributes*, never `<style>` elements).
  // `input` stays off this list because GFM task lists render as trusted
  // `<input type="checkbox" disabled>`; every other input kind is removed by
  // the `afterSanitizeElements` hook below.
  const FORBIDDEN_TAGS = [
    'style', 'link', 'form', 'button', 'textarea', 'select',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'template',
    'noscript', 'slot', 'marquee', 'meta', 'base'
  ];

  // Light-format HTML subset accepted from AI replies (server sanitizes too).
  // No `class`: arbitrary app CSS hooks must not be reachable from AI output.
  const AI_REPLY_TAGS = [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre',
    'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'h5', 'span', 'div',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'sup', 'sub', 'mark', 'a'
  ];
  const AI_REPLY_ATTRS = ['href', 'target', 'rel'];

  let linkHookRegistered = false;
  function ensureSanitizerHooks(): void {
    if (linkHookRegistered) return;
    linkHookRegistered = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node instanceof Element && node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    });
    // Reject real form/password UI while keeping GFM task-list checkboxes:
    // only a disabled `type="checkbox"` input may survive.
    DOMPurify.addHook('afterSanitizeElements', (node) => {
      if (node instanceof HTMLInputElement && !(node.type === 'checkbox' && node.disabled)) {
        node.remove();
      }
    });
  }

  function sanitizeDocumentHtml(html: string): string {
    ensureSanitizerHooks();
    return DOMPurify.sanitize(html, {
      ADD_TAGS: KATEX_TAGS,
      ADD_ATTR: [...OFFSET_ATTRS, ...KATEX_ATTRS],
      FORBID_TAGS: FORBIDDEN_TAGS,
      KEEP_CONTENT: false
    });
  }

  function sanitizeAiHtml(html: string): string {
    ensureSanitizerHooks();
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: AI_REPLY_TAGS,
      ALLOWED_ATTR: AI_REPLY_ATTRS,
      FORBID_TAGS: FORBIDDEN_TAGS,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: true
    });
  }

  /** Legacy browser-side AI credential storage from the pre-SaaS build. */
  const LEGACY_AI_STORAGE_KEYS = ['margintalk_ai_settings_v1', 'coachme_ai_settings_v1'];
  function purgeLegacyAiSettings(): void {
    try {
      for (const key of LEGACY_AI_STORAGE_KEYS) localStorage.removeItem(key);
    } catch {
      // Storage may be unavailable (private mode); nothing else to clean up.
    }
  }

  const POLL_INTERVAL_MS = 5000;
  const LONG_PRESS_DURATION_MS = 520;
  const MOVE_CANCEL_THRESHOLD_PX = 12;

  const AUTH_ERROR_MESSAGES: Record<string, string> = {
    access_denied: '您取消了 Amazon 授权，未登录。',
    invalid_state: '登录校验未通过（state 已过期或不匹配），请重新点击登录。',
    state_expired: '登录状态已过期，请重新点击 Amazon 登录。',
    token_exchange_failed: '与 Amazon 交换访问令牌失败，请稍后重试。',
    invalid_grant: 'Amazon 授权码无效或已被使用，请重新登录。',
    profile_unavailable: '无法读取您的 Amazon 账户资料，请稍后重试。',
    session_failed: '创建登录会话失败，请稍后重试。'
  };

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------
  let session = $state<SessionInfo | null>(null);
  let bootLoading = $state<boolean>(true);
  let authBanner = $state<string | null>(null);
  /** True when `/api/session` itself failed, i.e. config is unknown (not “unconfigured”). */
  let sessionUnavailable = $state<boolean>(false);
  /**
   * Bumped whenever the account scope changes (sign out, 401). Every request
   * captures it and must drop its response if it no longer matches, so a stale
   * reply can never repopulate another account's private data.
   */
  let accountEpoch = 0;

  let signedIn = $derived(Boolean(session?.user));
  /** Derived so template narrowing is exact (no optional-chain re-dereference). */
  let accountUser = $derived(session?.user ?? null);
  let authConfigured = $derived(Boolean(session?.authConfigured));
  let aiConfigured = $derived(Boolean(session?.aiConfigured));
  const loginHint = $derived(
    sessionUnavailable
      ? '无法读取服务端配置（服务未就绪或网络异常），请重试加载登录状态。'
      : '服务端尚未配置 Amazon OAuth，暂时无法登录。'
  );

  // ---------------------------------------------------------------------------
  // Active document state
  // ---------------------------------------------------------------------------
  let documentId = $state<string | null>(null); // null → local sample / unsaved doc
  let documentName = $state<string>(DEFAULT_SAMPLE_FILENAME);
  let baseMarkdown = $state<string>(DEFAULT_SAMPLE_MARKDOWN);
  let clips = $state<ClipAnnotation[]>([]);
  let serverRevision = $state<number>(0);
  let serverUpdatedAt = $state<number | null>(null);
  let selectedClipId = $state<string | null>(null); // Right panel hidden by default!

  const isCloudDocument = $derived(documentId !== null);

  // ---------------------------------------------------------------------------
  // Cloud sync (sequential, revisioned annotation saves)
  // ---------------------------------------------------------------------------
  let syncState = $state<'clean' | 'dirty' | 'saving' | 'error'>('clean');
  let syncError = $state<string | null>(null);
  let localClipSequence = $state<number>(0);
  let saveInFlight = $state<boolean>(false);
  let saveQueued = $state<boolean>(false);
  /**
   * An unresolved 409: the local snapshot and the server's version are kept
   * apart, and only an explicit user choice (discard local, or overwrite the
   * server with a warning) may reconcile them. Never advanced silently.
   */
  let conflict = $state<{
    serverDocument: CloudDocument | null;
  } | null>(null);
  let conflictChoice = $state<'discard' | 'overwrite' | null>(null);
  let resolvingConflict = $state<boolean>(false);
  /** The cloud document vanished while local edits existed; work is retained. */
  let documentMissing = $state<boolean>(false);
  let savingCopyPending = $state<boolean>(false);

  const hasUnsavedWork = $derived(documentId !== null && syncState !== 'clean');

  // ---------------------------------------------------------------------------
  // Library / account modals
  // ---------------------------------------------------------------------------
  let showLibraryModal = $state<boolean>(false);
  let showAccountModal = $state<boolean>(false);
  let libraryDocs = $state<DocumentSummary[]>([]);
  let libraryLoading = $state<boolean>(false);
  let libraryError = $state<string | null>(null);
  let openDocumentPending = $state<boolean>(false);
  let deletingDocumentId = $state<string | null>(null);
  let pendingDelete = $state<DocumentSummary | null>(null);
  let savingSamplePending = $state<boolean>(false);
  let uploadingFiles = $state<boolean>(false);

  // ---------------------------------------------------------------------------
  // Long-press state for progressive 📎 placement
  // ---------------------------------------------------------------------------
  let isLongPressing = $state<boolean>(false);
  let pressProgress = $state<number>(0); // 0..1
  let pressClientX = $state<number>(0);
  let pressClientY = $state<number>(0);
  let pressColor = $state<string>('#c85a32');
  let pressTargetOffset = $state<number>(0);
  let pressAdjustedInfo = $state<{ adjusted: boolean; reason?: string }>({ adjusted: false });
  /** Document/account the press started on, re-checked before it commits. */
  let pressDocumentId: string | null = null;
  let pressAccountEpoch = 0;

  let pressTimerId: number | null = null;
  let pressRafId: number | null = null;
  let pressStartTime = 0;
  let suppressNextClick = false;

  // ---------------------------------------------------------------------------
  // Reply stream (server is authoritative for the persisted user turn)
  // ---------------------------------------------------------------------------
  let draftInput = $state<string>('');
  let lastSentPrompt = $state<string>('');
  /** A generation failure belongs to one clip only, never to the whole panel. */
  let replyError = $state<{ clipId: string; message: string } | null>(null);

  /**
   * The in-flight reply remembers the document/clip that started it, so stream
   * progress stays attached to the originating clip even when the user changes
   * selection mid-stream. `draftCleared` guarantees the typed question is
   * discarded exactly once, and only after the server proves it persisted.
   */
  let activeReply = $state<{
    documentId: string;
    clipId: string;
    content: string;
    reasoning: string;
    text: string;
    draftCleared: boolean;
  } | null>(null);
  let replyAbort: AbortController | null = null;

  const isRequestingAi = $derived(activeReply !== null);
  const visibleReply = $derived(
    activeReply && activeReply.documentId === documentId && activeReply.clipId === selectedClipId
      ? activeReply
      : null
  );

  // ---------------------------------------------------------------------------
  // Modals / DOM refs
  // ---------------------------------------------------------------------------
  let showMarkdownModal = $state<boolean>(false);
  let toastMessage = $state<string | null>(null);
  let toastTimer: number | null = null;

  let fileInputEl: HTMLInputElement | undefined = $state();
  let markdownContainerEl: HTMLElement | undefined = $state();
  let messagesScrollEl: HTMLElement | undefined = $state();
  let liveReasoningScrollEl: HTMLElement | undefined = $state();
  let composerTextareaEl: HTMLTextAreaElement | undefined = $state();
  let f7Instance: Framework7 | null = null;
  let pollTimer: number | null = null;

  // ---------------------------------------------------------------------------
  // Derived view values
  // ---------------------------------------------------------------------------
  let renderedDoc = $derived(renderMarkdownToHtml(baseMarkdown));
  let sanitizedDocHtml = $derived(sanitizeDocumentHtml(renderedDoc.html));
  let activeClip = $derived(clips.find((c) => c.id === selectedClipId) ?? null);
  let annotatedMarkdownPreview = $derived(
    buildAnnotatedMarkdown(baseMarkdown, clips, selectedClipId ?? undefined)
  );
  let fullPromptPreview = $derived(
    lastSentPrompt
      ? lastSentPrompt
      : selectedClipId
        ? buildAiPrompt(baseMarkdown, clips, selectedClipId).prompt
        : buildAnnotatedMarkdown(baseMarkdown, clips)
  );
  /** Anything that could replace or mutate view state must be idle first. */
  const isBusy = $derived(
    saveInFlight ||
      activeReply !== null ||
      openDocumentPending ||
      uploadingFiles ||
      savingSamplePending ||
      deletingDocumentId !== null ||
      resolvingConflict
  );
  /**
   * Operations that could swap the document under the reader. Unlike `isBusy`
   * this deliberately ignores an in-flight annotation save, because placing a
   * second 📎 while the first is still syncing is expected (it re-queues).
   */
  const viewChanging = $derived(
    activeReply !== null ||
      openDocumentPending ||
      uploadingFiles ||
      savingSamplePending ||
      savingCopyPending ||
      resolvingConflict
  );
  /**
   * Annotation work needs a signed-in account, a persisted cloud document, no
   * unresolved conflict/deletion and no in-flight generation (placements are
   * forbidden while a reply runs so server snapshots never need to guess which
   * local clips were speculative).
   */
  let canAnnotate = $derived(
    signedIn &&
      isCloudDocument &&
      !viewChanging &&
      conflict === null &&
      !documentMissing
  );
  let switchingBlocked = $derived(hasUnsavedWork || isBusy || conflict !== null || documentMissing);

  function showToast(msg: string, duration = 2600) {
    toastMessage = msg;
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastMessage = null;
    }, duration);
  }

  function describeApiError(err: unknown, fallback: string): string {
    if (err instanceof ApiError) return err.message || fallback;
    if (err instanceof Error) return err.message || fallback;
    return fallback;
  }

  // ---------------------------------------------------------------------------
  // Request guards: stale responses must never touch current state
  // ---------------------------------------------------------------------------
  interface AccountScope {
    epoch: number;
    userId: string | null;
  }

  interface ViewScope extends AccountScope {
    documentId: string | null;
    clipSequence: number;
    revision: number;
  }

  function captureAccount(): AccountScope {
    return { epoch: accountEpoch, userId: session?.user?.id ?? null };
  }

  function captureView(): ViewScope {
    return {
      ...captureAccount(),
      documentId,
      clipSequence: localClipSequence,
      revision: serverRevision
    };
  }

  function accountStillCurrent(started: AccountScope): boolean {
    return accountEpoch === started.epoch && (session?.user?.id ?? null) === started.userId;
  }

  function viewStillCurrent(started: ViewScope): boolean {
    return (
      accountStillCurrent(started) &&
      documentId === started.documentId &&
      localClipSequence === started.clipSequence
    );
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------
  function consumeAuthErrorQuery(): void {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('auth_error');
    if (!code) return;
    authBanner = AUTH_ERROR_MESSAGES[code] ?? `Amazon 登录失败（${code}），请重试。`;
    // Drop the one-time error query without leaving it in history.
    window.history.replaceState(
      {},
      document.title,
      `${window.location.pathname}${window.location.hash}`
    );
  }

  async function loadSession(): Promise<void> {
    const started = captureAccount();
    try {
      const next = await fetchSession();
      // Never let a slow response install a session for a stale scope.
      if (started.epoch !== accountEpoch) return;
      session = next;
      bootLoading = false;
      sessionUnavailable = false;
      if (next.user) void refreshLibrary();
    } catch (err) {
      if (started.epoch !== accountEpoch) return;
      session = null;
      sessionUnavailable = true;
      bootLoading = false;
      const message = describeApiError(err, '无法读取登录状态。');
      if (!authBanner) authBanner = `${message}（云端服务是否已启动？）`;
    }
  }

  function clearConflictState(): void {
    conflict = null;
    conflictChoice = null;
    resolvingConflict = false;
  }

  function clearAccountData(reason: string | null): void {
    // Invalidate every in-flight request first, then drop all private state.
    accountEpoch += 1;
    session = session ? { ...session, user: null, csrfToken: null } : session;
    setCsrfToken(null);
    abortActiveReply();
    cancelLongPress();
    clearConflictState();
    documentMissing = false;
    savingCopyPending = false;
    libraryDocs = [];
    libraryError = null;
    libraryLoading = false;
    pendingDelete = null;
    showLibraryModal = false;
    showAccountModal = false;
    openDocumentPending = false;
    uploadingFiles = false;
    savingSamplePending = false;
    saveQueued = false;
    draftInput = '';
    lastSentPrompt = '';
    replyError = null;
    resetToSample();
    purgeLegacyAiSettings();
    if (reason) showToast(reason);
  }

  async function handleSignOut() {
    if (hasUnsavedWork && !window.confirm('当前文档还有未保存到云端的批注，退出登录将丢失这些更改，确定退出吗？')) {
      return;
    }
    const started = captureAccount();
    try {
      await apiLogout();
    } catch (err) {
      if (!accountStillCurrent(started)) return;
      if (!(err instanceof ApiError) || !err.unauthorized) {
        showToast(describeApiError(err, '退出登录失败，请稍后重试。'));
        return;
      }
    }
    clearAccountData('已退出登录，云端文档与草稿已清空。');
  }

  function handle401(message: string): void {
    clearAccountData(`${message} 请重新使用 Amazon 登录。`);
  }

  // ---------------------------------------------------------------------------
  // Document state helpers
  // ---------------------------------------------------------------------------
  function resetToSample(): void {
    cancelLongPress();
    clearConflictState();
    documentMissing = false;
    documentId = null;
    documentName = DEFAULT_SAMPLE_FILENAME;
    baseMarkdown = DEFAULT_SAMPLE_MARKDOWN;
    clips = [];
    serverRevision = 0;
    serverUpdatedAt = null;
    selectedClipId = null;
    syncState = 'clean';
    syncError = null;
    saveQueued = false;
    lastSentPrompt = '';
    replyError = null;
  }

  function adoptCloudDocument(doc: CloudDocument): void {
    cancelLongPress();
    clearConflictState();
    documentMissing = false;
    documentId = doc.id;
    documentName = doc.name;
    baseMarkdown = doc.markdown;
    clips = doc.clips;
    serverRevision = doc.revision;
    serverUpdatedAt = doc.updatedAt ?? Date.now();
    selectedClipId = null;
    syncState = 'clean';
    syncError = null;
    replyError = null;
    lastSentPrompt = '';
    saveQueued = false;
  }

  /**
   * Adopt an authoritative snapshot exactly. The client never speculates about
   * clips: placements and deletions are forbidden while a reply or a save is in
   * flight, so an empty local clip that another session deleted can never be
   * resurrected by a poll or a stream event.
   */
  function applyAuthoritativeSnapshot(doc: CloudDocument): void {
    cancelLongPress();
    documentId = doc.id;
    documentName = doc.name;
    baseMarkdown = doc.markdown;
    serverRevision = doc.revision;
    serverUpdatedAt = doc.updatedAt ?? Date.now();
    clips = doc.clips;
    if (selectedClipId && !clips.some((c) => c.id === selectedClipId)) selectedClipId = null;
  }

  // ---------------------------------------------------------------------------
  // Sequential revisioned cloud saves
  // ---------------------------------------------------------------------------
  function markDirtyAndSave(): void {
    if (documentId === null) return; // Sample / un-persisted document has nothing to sync yet.
    localClipSequence += 1;
    if (documentMissing || conflict !== null) {
      // Held locally on purpose: sending now would either resurrect a deleted
      // document or clobber the version we are being asked to reconcile.
      syncState = 'error';
      syncError = documentMissing
        ? '云端文档已被删除，本地批注已保留，可导出或另存为新的云端文档。'
        : '云端版本冲突尚未解决，新的本地修改暂存于浏览器，请先选择如何处理冲突。';
      return;
    }
    syncState = 'dirty';
    syncError = null;
    void runSaveQueue();
  }

  /**
   * One save at a time, always against the newest known revision, carrying the
   * whole annotation snapshot. Mutations that land while a request is in flight
   * (or while the AI generation still holds the document busy) are re-queued
   * instead of dropped. A 409 is never retried automatically: it becomes an
   * explicit conflict the user resolves.
   */
  async function runSaveQueue(): Promise<void> {
    if (documentId === null || documentMissing) return;
    if (conflict !== null) return; // Resolution is a user decision, not a retry.
    if (saveInFlight) {
      saveQueued = true;
      return;
    }
    // The server rejects PUT while its reply generation is pending, so defer.
    if (activeReply !== null) {
      saveQueued = true;
      return;
    }
    saveInFlight = true;
    try {
      do {
        saveQueued = false;
        syncState = 'saving';
        syncError = null;
        const started = captureView();
        const clipsAtSend = clips;
        const currentDocumentId = started.documentId as string;
        try {
          const doc = await updateDocument(currentDocumentId, started.revision, clipsAtSend);
          if (!accountStillCurrent(started)) return; // signed out / 401 mid-save
          if (documentId !== currentDocumentId) return; // view moved on
          serverRevision = doc.revision;
          serverUpdatedAt = doc.updatedAt ?? Date.now();
          if (started.clipSequence === localClipSequence) {
            // Nothing changed locally during the round-trip: adopt verbatim.
            documentName = doc.name;
            baseMarkdown = doc.markdown;
            clips = doc.clips;
            if (selectedClipId && !doc.clips.some((c) => c.id === selectedClipId)) {
              selectedClipId = null;
            }
          } else {
            saveQueued = true; // newer local snapshot wins the next round
          }
        } catch (err) {
          saveQueued = false;
          if (!accountStillCurrent(started)) return;
          if (err instanceof ApiError && err.unauthorized) {
            syncState = 'error';
            syncError = err.message;
            handle401(err.message);
            return;
          }
          if (documentId !== currentDocumentId) return;
          if (err instanceof ApiError && err.notFound) {
            // Keep the local document and clips; offer export / save-as-new /
            // discard instead of silently throwing away unsynced work.
            clearConflictState();
            documentMissing = true;
            syncState = 'error';
            syncError = '云端文档已不存在（可能被其他会话删除）。本地批注已保留，可导出或另存为新的云端文档。';
            libraryDocs = libraryDocs.filter((d) => d.id !== currentDocumentId);
            return;
          }
          syncState = 'error';
          if (err instanceof ApiError && err.conflict) {
            // Divergence: never advance our revision on our own.
            documentMissing = false;
            conflict = {
              serverDocument:
                err.document && err.document.id === currentDocumentId ? err.document : null
            };
            syncError = `云端版本已被其他会话更新（${err.message}）。请选择「放弃本地 · 加载云端」或「以本地批注覆盖云端」来解决冲突；本地未同步批注已保留。`;
          } else {
            conflict = null;
            syncError = describeApiError(err, '批注保存失败，请重试。');
          }
          break;
        }
      } while (saveQueued);
      if (syncState === 'saving') syncState = 'clean';
    } finally {
      saveInFlight = false;
      if (saveQueued && documentId !== null && activeReply === null && conflict === null && !documentMissing) {
        void runSaveQueue();
      }
    }
  }

  function retryCloudSave(): void {
    if (documentId === null || conflict !== null || documentMissing || isBusy) return;
    syncState = 'dirty';
    saveQueued = true;
    void runSaveQueue();
  }

  function askConflictChoice(choice: 'discard' | 'overwrite'): void {
    if (conflict === null) return;
    conflictChoice = choice;
  }

  async function applyConflictChoice(): Promise<void> {
    const choice = conflictChoice;
    if (choice === null || conflict === null || documentId === null) return;
    conflictChoice = null;
    const started = captureView();
    resolvingConflict = true;
    try {
      // The user explicitly asked for the server's version, or explicitly
      // agreed to overwrite it; either way we need its current revision.
      const serverDoc =
        conflict.serverDocument ?? (await getDocument(started.documentId as string));
      if (!viewStillCurrent(started)) return;
      if (choice === 'discard') {
        applyAuthoritativeSnapshot(serverDoc);
        clearConflictState();
        syncState = 'clean';
        syncError = null;
        showToast('已加载云端最新版本，本地未同步的批注修改已放弃。');
      } else {
        serverRevision = serverDoc.revision;
        clearConflictState();
        syncState = 'dirty';
        syncError = null;
        saveQueued = true;
        void runSaveQueue();
        showToast('已按您的选择以本地批注覆盖云端版本。');
      }
    } catch (err) {
      if (!accountStillCurrent(started)) return;
      syncError = describeApiError(err, '冲突处理失败，请稍后重试。');
      showToast(syncError);
    } finally {
      if (accountStillCurrent(started)) resolvingConflict = false;
    }
  }

  function exportAnnotatedMarkdownFile() {
    const fullMd = buildAnnotatedMarkdown(baseMarkdown, clips);
    const blob = new Blob([fullMd], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = documentName.replace(/\.md$/i, '') + '.annotated.md';
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出带 <aside> 批注语义的 Markdown 文件');
  }

  /** Recover a deleted cloud document by uploading the local snapshot as a new one. */
  async function saveLocalCopyAsNewDocument(): Promise<void> {
    const started = captureView();
    if (started.userId === null || savingCopyPending) return;
    const name = documentName;
    savingCopyPending = true;
    try {
      const doc = await createDocument(name, baseMarkdown);
      if (!viewStillCurrent(started)) return;
      // The AI/export representation omits empty clips; recover the actual snapshot instead.
      // Keep local clips while moving to the new resource, so a failed PUT remains retryable.
      documentId = doc.id;
      documentName = doc.name;
      serverRevision = doc.revision;
      serverUpdatedAt = doc.updatedAt;
      documentMissing = false;
      clearConflictState();
      lastSentPrompt = '';
      replyError = null;
      syncState = 'dirty';
      syncError = null;
      localClipSequence += 1;
      await runSaveQueue();
      if (!accountStillCurrent(started) || documentId !== doc.id) return;
      showToast(
        !hasUnsavedWork
          ? `已将本地批注副本另存为云端文档「${doc.name}」`
          : '新文档已创建，本地批注仍保留，请完成剩余的云同步。'
      );
      void refreshLibrary();
    } catch (err) {
      if (!accountStillCurrent(started)) return;
      if (err instanceof ApiError && err.unauthorized) handle401(err.message);
      else showToast(describeApiError(err, '另存为新的云端文档失败。'));
    } finally {
      if (accountStillCurrent(started)) savingCopyPending = false;
    }
  }

  function discardLocalCopy(): void {
    if (
      !window.confirm('确定放弃本地未同步的批注副本，返回示例文档吗？')
    ) {
      return;
    }
    resetToSample();
    showToast('已放弃本地副本。');
    void refreshLibrary();
  }

  // ---------------------------------------------------------------------------
  // Cloud library
  // ---------------------------------------------------------------------------
  async function refreshLibrary(): Promise<void> {
    const started = captureAccount();
    if (started.userId === null) return;
    libraryLoading = true;
    libraryError = null;
    try {
      const docs = await listDocuments();
      if (!accountStillCurrent(started)) return;
      libraryDocs = docs;
    } catch (err) {
      if (!accountStillCurrent(started)) return;
      libraryError = describeApiError(err, '加载云端文档库失败。');
      if (err instanceof ApiError && err.unauthorized) handle401(err.message);
    } finally {
      if (accountStillCurrent(started)) libraryLoading = false;
    }
  }

  function openLibraryModal() {
    if (!session?.user) return;
    showAccountModal = false;
    showLibraryModal = true;
    void refreshLibrary();
  }

  async function openCloudDocument(doc: DocumentSummary) {
    const started = captureView();
    if (started.userId === null) return;
    if (switchingBlocked) {
      showToast(
        conflict !== null
          ? '请先处理云端版本冲突。'
          : documentMissing
            ? '请先导出或另存已删除文档的本地副本。'
            : hasUnsavedWork
              ? '当前文档有未保存的批注，请先完成同步。'
              : '正在上传/保存/生成，请稍候。'
      );
      return;
    }
    if (doc.id === documentId) {
      showLibraryModal = false;
      return;
    }
    openDocumentPending = true;
    try {
      const full = await getDocument(doc.id);
      // Only install it if this is still the same account viewing the same
      // document with no local edits added meanwhile.
      if (!viewStillCurrent(started)) return;
      abortActiveReply();
      adoptCloudDocument(full);
      showLibraryModal = false;
      showToast(`已打开云端文档「${full.name}」`);
    } catch (err) {
      if (!accountStillCurrent(started)) return;
      if (err instanceof ApiError && err.notFound) {
        libraryDocs = libraryDocs.filter((d) => d.id !== doc.id);
        showToast('该文档已不存在，列表已刷新。');
      } else if (err instanceof ApiError && err.unauthorized) {
        handle401(err.message);
      } else {
        showToast(describeApiError(err, '打开云端文档失败，请稍后重试。'));
      }
    } finally {
      if (accountStillCurrent(started)) openDocumentPending = false;
    }
  }

  function askDeleteCloudDocument(doc: DocumentSummary) {
    if (isRequestingAi) {
      showToast('AI 正在生成批注，暂不可删除文档。');
      return;
    }
    if (openDocumentPending || uploadingFiles || savingSamplePending || savingCopyPending) {
      showToast('正在上传/打开文档，暂不可删除。');
      return;
    }
    if (doc.id === documentId && (hasUnsavedWork || conflict !== null || documentMissing)) {
      showToast('当前文档有未保存或未解决的批注修改，请先处理。');
      return;
    }
    pendingDelete = doc;
  }

  async function confirmDeleteCloudDocument() {
    const doc = pendingDelete;
    if (!doc) return;
    const started = captureAccount();
    deletingDocumentId = doc.id;
    try {
      await deleteDocument(doc.id);
      if (!accountStillCurrent(started)) return;
      libraryDocs = libraryDocs.filter((d) => d.id !== doc.id);
      pendingDelete = null;
      if (doc.id === documentId) {
        resetToSample();
        showToast(`已删除云端文档「${doc.name}」，当前返回示例文档。`);
      } else {
        showToast(`已删除云端文档「${doc.name}」`);
      }
    } catch (err) {
      if (!accountStillCurrent(started)) return;
      if (err instanceof ApiError && err.notFound) {
        libraryDocs = libraryDocs.filter((d) => d.id !== doc.id);
        pendingDelete = null;
        if (doc.id === documentId) resetToSample();
        showToast('该文档已被删除。');
      } else if (err instanceof ApiError && err.unauthorized) {
        handle401(err.message);
      } else if (err instanceof ApiError && err.conflict) {
        showToast(describeApiError(err, '该文档正在生成批注，暂时无法删除。'));
      } else {
        showToast(describeApiError(err, '删除云端文档失败，请稍后重试。'));
      }
    } finally {
      if (accountStillCurrent(started)) deletingDocumentId = null;
    }
  }

  async function saveSampleToCloud() {
    const started = captureView();
    if (started.userId === null || savingSamplePending || switchingBlocked) return;
    savingSamplePending = true;
    try {
      const doc = await createDocument(documentName || DEFAULT_SAMPLE_FILENAME, baseMarkdown);
      if (!viewStillCurrent(started)) return;
      // The sample must still be what the user is looking at.
      if (documentId !== null) return;
      adoptCloudDocument(doc);
      showLibraryModal = false;
      showToast(`已将「${doc.name}」保存到云端 📎`);
      void refreshLibrary();
    } catch (err) {
      if (!accountStillCurrent(started)) return;
      if (err instanceof ApiError && err.unauthorized) handle401(err.message);
      else showToast(describeApiError(err, '保存示例文档到云端失败。'));
    } finally {
      if (accountStillCurrent(started)) savingSamplePending = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Native Markdown picker → automatic cloud upload
  // ---------------------------------------------------------------------------
  function openMarkdownFileDialog() {
    if (!signedIn) {
      showToast('登录云端账户后即可上传 Markdown 文件。');
      showAccountModal = true;
      return;
    }
    if (uploadingFiles || openDocumentPending) return;
    fileInputEl?.click();
  }

  async function handleFileSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length === 0) return;

    const started = captureView();
    if (started.userId === null) return;
    if (openDocumentPending || savingSamplePending || savingCopyPending) return;

    uploadingFiles = true;
    let uploaded: CloudDocument | null = null;
    const failures: string[] = [];
    for (const file of files) {
      if (!accountStillCurrent(started)) {
        uploadingFiles = false;
        return; // signed out mid-upload: stop touching the account
      }
      const rawText = await file.text();
      try {
        uploaded = await createDocument(file.name, rawText);
      } catch (err) {
        if (!accountStillCurrent(started)) {
          uploadingFiles = false;
          return;
        }
        if (err instanceof ApiError && err.unauthorized) {
          uploadingFiles = false;
          handle401(err.message);
          return;
        }
        failures.push(`${file.name}：${describeApiError(err, '上传失败')}`);
      }
    }
    uploadingFiles = false;
    if (!accountStillCurrent(started)) return;
    void refreshLibrary();

    if (uploaded && viewStillCurrent(started) && !switchingBlocked) {
      abortActiveReply();
      adoptCloudDocument(uploaded);
      showLibraryModal = false;
      showToast(
        files.length > 1
          ? `已上传 ${files.length - failures.length} 个 Markdown 文件，正在编辑「${uploaded.name}」`
          : `已上传并打开「${uploaded.name}」${failures.length > 0 ? `（${failures[0]}）` : ''}`
      );
      return;
    }
    if (uploaded) {
      showToast('文件已上传到云端；当前文档尚有未保存内容，可在云端文档库中打开新文件。');
    }
    if (failures.length > 0) showToast(`部分文件上传失败：${failures.join('；')}`);
  }

  // ---------------------------------------------------------------------------
  // Long-press gesture on the left Markdown document
  // ---------------------------------------------------------------------------
  function handleDocPointerDown(event: PointerEvent) {
    // Only primary mouse button or touch
    if (event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (!target || !markdownContainerEl) return;

    // Ignore if user clicked on an existing 📎 paperclip badge
    if (target.closest('.clip-anchor-pin')) {
      return;
    }

    if (!canAnnotate) {
      if (!signedIn) showToast('登录后才能批注云端文档。');
      else if (conflict !== null) showToast('请先处理云端版本冲突，再放置曲别针。');
      else if (documentMissing) showToast('云端文档已删除，请先另存为新文档再批注。');
      else if (isRequestingAi) showToast('AI 正在生成批注，完成后方可放置或删除曲别针。');
      else if (isBusy) showToast('正在同步/上传，请稍候。');
      else showToast('请先上传或保存文档到云端，再进行批注。');
      return;
    }

    cancelLongPress();
    suppressNextClick = false;

    const lastColor = clips[clips.length - 1]?.color;
    pressColor = pickRandomClipColor(lastColor);
    pressClientX = event.clientX;
    pressClientY = event.clientY;
    pressStartTime = performance.now();
    pressProgress = 0.06;
    isLongPressing = true;
    pressDocumentId = documentId;
    pressAccountEpoch = accountEpoch;

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
    if (!isLongPressing) {
      if (suppressNextClick) {
        window.setTimeout(() => {
          suppressNextClick = false;
        }, 0);
      }
      return;
    }
    cancelLongPress();
  }

  function handleDocPointerCancel() {
    suppressNextClick = false;
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
    const pressDocument = pressDocumentId;
    cancelLongPress();
    suppressNextClick = true;

    // The view may have moved (document switch, account purge, conflict, a new
    // generation) while the ring was filling: never place into a stale view.
    if (
      pressDocument === null ||
      pressDocument !== documentId ||
      pressAccountEpoch !== accountEpoch ||
      !canAnnotate
    ) {
      showToast('文档或登录状态已变化，未放置曲别针。');
      return;
    }

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

    clips = [...clips, newClip];
    selectedClipId = newClipId;
    markDirtyAndSave();

    if (wasAdjusted) {
      showToast(`已遵循最小避让原则微调位置（避开 ${adjustReason || '公式/语法边界'}）并放置 📎`);
    } else {
      showToast('已放置曲别针 📎，可在右栏输入批注与 AI 对话');
    }
  }

  // Click on document area without paperclip hides right column
  function handleDocClick(event: MouseEvent) {
    // Do not hide right column on the click event synthesized when releasing a long-press placement
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest('.clip-anchor-pin')) {
      return;
    }

    if (selectedClipId !== null) {
      selectedClipId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Reply stream
  // ---------------------------------------------------------------------------
  function abortActiveReply(): void {
    if (replyAbort) {
      replyAbort.abort();
      replyAbort = null;
    }
    activeReply = null;
  }

  function handleReplyEvent(event: ReplyEvent): void {
    // The server owns the user turn: `document` / `done` snapshots are adopted
    // verbatim, so the composer must never append a local copy of the question.
    switch (event.type) {
      case 'document': {
        if (event.document.id === documentId) applyAuthoritativeSnapshot(event.document);
        lastSentPrompt = event.prompt;
        // The user turn is now provably persisted: drop the draft exactly once,
        // and only if the composer still holds exactly what was sent.
        const stream = activeReply;
        if (stream && !stream.draftCleared) {
          stream.draftCleared = true;
          if (draftInput === stream.content) {
            draftInput = '';
            if (composerTextareaEl) composerTextareaEl.value = '';
          }
        }
        void tick().then(() => scrollToBottomOfMessages());
        break;
      }
      case 'reasoning': {
        if (activeReply) activeReply.reasoning += event.delta;
        void tick().then(() => scrollToBottomOfMessages());
        break;
      }
      case 'text': {
        if (activeReply) activeReply.text += event.delta;
        void tick().then(() => scrollToBottomOfMessages());
        break;
      }
      case 'done': {
        if (event.document.id === documentId) applyAuthoritativeSnapshot(event.document);
        activeReply = null;
        break;
      }
      case 'error': {
        const failedClipId = activeReply?.clipId ?? null;
        if (event.document && event.document.id === documentId) {
          applyAuthoritativeSnapshot(event.document);
        }
        if (failedClipId) {
          replyError = {
            clipId: failedClipId,
            message: event.error?.message?.trim() || 'AI 批注生成失败，请重试。'
          };
        }
        activeReply = null;
        break;
      }
    }
  }

  async function handleSendAnnotation() {
    const rawText = composerTextareaEl ? composerTextareaEl.value : draftInput;
    const content = rawText.trim();
    if (!content || !selectedClipId || !documentId || activeReply) return;

    const targetClipId = selectedClipId;
    const targetDocumentId = documentId;
    if (conflict !== null || documentMissing) {
      showToast('请先处理云端版本冲突或删除文档的本地副本。');
      return;
    }
    if (syncState !== 'clean') {
      showToast('批注尚未同步到云端，已自动开始同步，请稍候再发送。');
      retryCloudSave();
      return;
    }
    if (!aiConfigured) {
      replyError = {
        clipId: targetClipId,
        message: '服务端尚未配置 AI，暂时无法生成批注回复。'
      };
      return;
    }

    replyError = null;
    // The draft is deliberately kept until the server proves it persisted the
    // user turn; a pre-stream rejection must not erase a typed question.
    activeReply = {
      documentId: targetDocumentId,
      clipId: targetClipId,
      content,
      reasoning: '',
      text: '',
      draftCleared: false
    };
    const controller = new AbortController();
    replyAbort = controller;

    await tick();
    scrollToBottomOfMessages();

    const started = captureView();
    try {
      await streamReply({
        documentId: targetDocumentId,
        revision: started.revision,
        clipId: targetClipId,
        content,
        signal: controller.signal,
        onEvent: handleReplyEvent
      });
    } catch (err) {
      if (controller.signal.aborted) {
        activeReply = null;
      } else if (err instanceof ApiError && err.unauthorized) {
        activeReply = null;
        handle401(err.message);
        return;
      } else {
        if (
          err instanceof ApiError &&
          err.document &&
          accountStillCurrent(started) &&
          err.document.id === documentId
        ) {
          applyAuthoritativeSnapshot(err.document);
        }
        // A deleted document must not stay silently “open” for further sends.
        if (
          err instanceof ApiError &&
          err.notFound &&
          accountStillCurrent(started) &&
          documentId === targetDocumentId
        ) {
          documentMissing = true;
          syncState = 'error';
          syncError = '云端文档已不存在（可能被其他会话删除）。本地批注已保留，可导出或另存为新的云端文档。';
          libraryDocs = libraryDocs.filter((d) => d.id !== targetDocumentId);
        }
        activeReply = null;
        replyError = {
          clipId: targetClipId,
          message: describeApiError(err, 'AI 批注生成失败，请重新发送批注。')
        };
      }
    } finally {
      if (replyAbort === controller) replyAbort = null;
      // Annotations queued during generation can now be flushed.
      if (
        documentId !== null &&
        accountStillCurrent(started) &&
        syncState !== 'clean' &&
        conflict === null &&
        !documentMissing
      ) {
        void runSaveQueue();
      }
    }
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      handleSendAnnotation();
    }
  }

  function removeCurrentClip() {
    if (!selectedClipId) return;
    if (activeReply !== null) {
      showToast('AI 正在生成批注，文档已锁定，暂不可移除曲别针。');
      return;
    }
    if (conflict !== null || documentMissing) {
      showToast(
        conflict !== null
          ? '请先处理云端版本冲突。'
          : '云端文档已删除，请先另存为新文档。'
      );
      return;
    }
    const idToRemove = selectedClipId;
    clips = clips.filter((c) => c.id !== idToRemove);
    selectedClipId = null;
    if (replyError?.clipId === idToRemove) replyError = null;
    if (documentId !== null) {
      markDirtyAndSave();
      showToast('已移除该枚曲别针批注，正在同步云端…');
    } else {
      showToast('已移除该枚曲别针批注');
    }
  }

  function scrollToBottomOfMessages() {
    if (liveReasoningScrollEl) {
      liveReasoningScrollEl.scrollTop = liveReasoningScrollEl.scrollHeight;
    }
    if (messagesScrollEl) {
      messagesScrollEl.scrollTop = messagesScrollEl.scrollHeight;
    }
  }

  // ---------------------------------------------------------------------------
  // Polling: only when clean and nothing is in flight
  // ---------------------------------------------------------------------------
  async function pollActiveDocument(): Promise<void> {
    const started = captureView();
    if (started.documentId === null || started.userId === null) return;
    if (isBusy || syncState !== 'clean' || conflict !== null || documentMissing) return;
    if (document.visibilityState !== 'visible') return;
    try {
      const doc = await getDocument(started.documentId as string);
      if (
        !viewStillCurrent(started) ||
        serverRevision !== started.revision ||
        syncState !== 'clean' ||
        isBusy
      ) {
        return;
      }
      if (doc.revision !== started.revision) applyAuthoritativeSnapshot(doc);
      else serverUpdatedAt = doc.updatedAt ?? serverUpdatedAt;
    } catch (err) {
      if (!viewStillCurrent(started) || syncState !== 'clean' || isBusy) return;
      if (err instanceof ApiError && err.notFound) {
        // Clean view: nothing local to lose, so returning to the sample is safe.
        const goneName = documentName;
        libraryDocs = libraryDocs.filter((d) => d.id !== started.documentId);
        resetToSample();
        showToast(`云端文档「${goneName}」已被删除或不再可用。`);
      } else if (err instanceof ApiError && err.unauthorized) {
        handle401(err.message);
      }
      // Other transient errors are retried on the next tick; local work is safe.
    }
  }

  function formatTime(ms: number | null): string {
    if (!ms) return '—';
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const syncStatusLabel = $derived.by(() => {
    if (documentId === null) return '本地示例 · 未上传';
    if (documentMissing) return '云端文档已删除 · 本地已保留';
    if (conflict !== null) return '云端版本冲突 · 待处理';
    if (syncState === 'saving') return '正在保存批注到云端…';
    if (syncState === 'dirty') return '有未保存的批注';
    if (syncState === 'error') return '保存失败，点击重试';
    return `已同步 · 版本 ${serverRevision} · ${formatTime(serverUpdatedAt)}`;
  });

  function handleBeforeUnload(event: BeforeUnloadEvent) {
    if (hasUnsavedWork || isRequestingAi || uploadingFiles || documentMissing || conflict !== null) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  onMount(() => {
    purgeLegacyAiSettings();
    consumeAuthErrorQuery();

    try {
      f7Instance = new Framework7({
        el: '#app',
        name: 'MarginTalk',
        theme: 'ios'
      });
    } catch {
      // Framework7 core initialized
    }

    void loadSession();

    pollTimer = window.setInterval(() => void pollActiveDocument(), POLL_INTERVAL_MS);
    window.addEventListener('beforeunload', handleBeforeUnload);
  });

  $effect(() => {
    return () => {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      cancelLongPress();
      if (replyAbort) replyAbort.abort();
      if (toastTimer !== null) window.clearTimeout(toastTimer);
    };
  });

  // Whenever rendered HTML, clips, or selectedClipId changes, re-mount interactive 📎 pins in the DOM
  $effect(() => {
    const html = sanitizedDocHtml;
    // Snapshots (every state update replaces these references) so a deferred
    // mount can never disagree with the Markdown offsets it is mapped against.
    const clipsSnapshot = clips;
    const markdownSnapshot = baseMarkdown;
    const selected = selectedClipId;

    if (markdownContainerEl && html !== undefined) {
      tick().then(() => {
        if (!markdownContainerEl) return;
        mountPaperclipsIntoDom(
          markdownContainerEl,
          markdownSnapshot,
          clipsSnapshot,
          selected,
          (clickedId) => {
            // Ignore clicks on pins whose clip vanished (remote delete / sync)
            // before this deferred mount attached its handler.
            if (clips.some((c) => c.id === clickedId)) selectedClipId = clickedId;
          }
        );
      });
    }
  });
</script>

<div class="framework7-root kami-shell" data-testid="app-shell">
  <!-- Hidden native file input triggered by toolbar button (multi-select auto-upload) -->
  <input
    bind:this={fileInputEl}
    type="file"
    accept=".md,.markdown,text/markdown,text/plain"
    multiple
    style="display: none;"
    data-testid="markdown-file-input"
    onchange={handleFileSelected}
  />

  <!-- Top Navbar (Framework7 + Kami style) -->
  <header class="navbar kami-navbar">
    <div class="kami-brand">
      <span class="kami-logo-seal">笺</span>
      <div class="kami-title-group">
        <span class="kami-app-title">笺谈 · MarginTalk</span>
        <span class="kami-doc-subtitle" data-testid="current-filename">
          <span>📄 {documentName}</span>
          <span>·</span>
          <span data-testid="clip-total-count">{clips.length} 枚曲别针</span>
          <span>·</span>
          <span
            class="kami-sync-status"
            data-testid="sync-status"
            data-sync-state={documentId === null
              ? 'local'
              : conflict !== null || documentMissing
                ? 'conflict'
                : syncState}
            title={syncError ?? syncStatusLabel}
          >{syncStatusLabel}</span>
        </span>
      </div>
    </div>

    <div class="kami-toolbar-actions">
      {#if documentId !== null && syncState === 'error' && conflict === null && !documentMissing}
        <button
          type="button"
          class="kami-btn kami-btn-danger"
          data-testid="retry-sync-btn"
          onclick={retryCloudSave}
          disabled={isBusy}
        >
          <span aria-hidden="true">↻</span>
          <span class="toolbar-label-wide">重试保存</span>
          <span class="toolbar-label-compact">重试</span>
        </button>
      {:else if documentId === null && signedIn && !showLibraryModal}
        <button
          type="button"
          class="kami-btn"
          data-testid="save-sample-btn"
          onclick={saveSampleToCloud}
          disabled={switchingBlocked}
          title="将当前示例文档保存到您的云端文档库"
        >
          <span aria-hidden="true">☁️</span>
          <span class="toolbar-label-wide">保存到云端</span>
          <span class="toolbar-label-compact">存云端</span>
        </button>
      {/if}

      <button
        type="button"
        class="kami-btn kami-btn-primary"
        data-testid="open-file-btn"
        onclick={openMarkdownFileDialog}
        disabled={uploadingFiles || openDocumentPending || savingSamplePending || savingCopyPending}
      >
        <span aria-hidden="true">📂</span>
        <span class="toolbar-label-wide">{uploadingFiles ? '上传中…' : '打开 Markdown 文件'}</span>
        <span class="toolbar-label-compact">{uploadingFiles ? '上传中' : '打开文件'}</span>
      </button>

      <button
        type="button"
        class="kami-btn"
        data-testid="open-library-btn"
        onclick={openLibraryModal}
        disabled={!signedIn}
        title={signedIn ? '查看云端文档库' : '登录后可查看云端文档库'}
      >
        <span aria-hidden="true">🗂️</span>
        <span class="toolbar-label-wide">云端文档库</span>
        <span class="toolbar-label-compact">文档库</span>
      </button>

      <button
        type="button"
        class="kami-btn"
        data-testid="preview-annotated-md-btn"
        onclick={() => (showMarkdownModal = true)}
      >
        <span aria-hidden="true">🔍</span>
        <span class="toolbar-label-wide">查看批注源文</span>
        <span class="toolbar-label-compact">批注源文</span>
      </button>

      {#if signedIn}
        <button
          type="button"
          class="kami-btn kami-btn-account"
          data-testid="open-account-btn"
          onclick={() => (showAccountModal = true)}
          title={accountUser?.name ?? '账户'}
        >
          <span aria-hidden="true">👤</span>
          <span class="toolbar-label-wide">{accountUser?.name ?? '我的账户'}</span>
          <span class="toolbar-label-compact">账户</span>
        </button>
      {:else}
        {#if authConfigured}
          <a
            class="kami-btn kami-btn-amazon external"
            data-testid="login-btn"
            href="/auth/amazon"
            rel="noopener"
          >
            <span aria-hidden="true">🔑</span>
            <span class="toolbar-label-wide">使用 Amazon 登录</span>
            <span class="toolbar-label-compact">登录</span>
          </a>
        {:else}
          <button
            type="button"
            class="kami-btn kami-btn-amazon"
            data-testid="login-btn-disabled"
            disabled
            title={loginHint}
          >
            <span aria-hidden="true">🔑</span>
            <span class="toolbar-label-wide">
              {sessionUnavailable ? 'Amazon 登录暂不可用' : 'Amazon 登录未配置'}
            </span>
            <span class="toolbar-label-compact">登录</span>
          </button>
        {/if}
      {/if}
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
      onpointercancel={handleDocPointerCancel}
      onclick={handleDocClick}
    >
      <article class="kami-paper-sheet" data-testid="markdown-paper-sheet">
        <div class="kami-sheet-meta">
          <span>MarginTalk · Markdown &amp; KaTeX</span>
          <span class="kami-sheet-hint">
            {#if bootLoading}
              ⏳ 正在读取登录状态…
            {:else if !signedIn}
              🔒 访客模式：仅可浏览示例文档，登录后可上传与批注
            {:else if !isCloudDocument}
              💾 示例文档未保存到云端，长按不可批注，请点击「保存到云端」
            {:else}
              💡 鼠标长按任意段落放置彩色 📎 曲别针 · 点击空白处隐藏右栏
            {/if}
          </span>
        </div>

        {#if authBanner}
          <div class="kami-alert-bar" data-testid="auth-error-banner" role="status">
            <span class="kami-alert-text">⚠️ {authBanner}</span>
            <div class="kami-confirm-actions">
              {#if sessionUnavailable}
                <button
                  type="button"
                  class="kami-btn kami-btn-mini kami-btn-primary"
                  data-testid="retry-session-btn"
                  onclick={() => void loadSession()}
                >
                  重试登录状态
                </button>
              {/if}
              <button
                type="button"
                class="kami-btn kami-btn-mini"
                data-testid="dismiss-auth-error-btn"
                onclick={() => (authBanner = null)}
              >
                知道了
              </button>
            </div>
          </div>
        {/if}

        {#if !aiConfigured && signedIn && !bootLoading && !sessionUnavailable}
          <div class="kami-alert-bar kami-alert-bar-warn" role="status" data-testid="ai-unconfigured-banner">
            <span class="kami-alert-text">
              🤖 服务端尚未配置 AI：可以放置/同步曲别针，但暂时无法生成 AI 批注回复。
            </span>
          </div>
        {/if}

        {#if conflict !== null}
          <div class="kami-alert-bar" data-testid="conflict-panel" role="alert">
            <span class="kami-alert-text">⚠️ {syncError}</span>
            <div class="kami-confirm-actions">
              <button
                type="button"
                class="kami-btn kami-btn-mini"
                data-testid="export-local-md-btn"
                onclick={exportAnnotatedMarkdownFile}
              >
                导出本地批注
              </button>
              <button
                type="button"
                class="kami-btn kami-btn-mini"
                data-testid="reload-server-version-btn"
                onclick={() => askConflictChoice('discard')}
                disabled={resolvingConflict}
              >
                放弃本地 · 加载云端
              </button>
              <button
                type="button"
                class="kami-btn kami-btn-mini kami-btn-danger"
                data-testid="overwrite-server-btn"
                onclick={() => askConflictChoice('overwrite')}
                disabled={resolvingConflict}
              >
                以本地覆盖云端
              </button>
            </div>
            {#if conflictChoice !== null}
              <div class="kami-confirm-panel kami-confirm-panel-inline" data-testid="conflict-choice-confirm">
                <div class="kami-confirm-text">
                  {conflictChoice === 'discard'
                    ? '确定放弃本地未同步的曲别针批注，改用云端最新版本吗？'
                    : '确定用本地曲别针批注覆盖云端版本吗？其他会话在该版本之后新增的批注将被丢弃。'}
                </div>
                <div class="kami-confirm-actions">
                  <button
                    type="button"
                    class="kami-btn kami-btn-mini"
                    data-testid="cancel-conflict-choice-btn"
                    onclick={() => (conflictChoice = null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    class="kami-btn kami-btn-mini kami-btn-danger"
                    data-testid="confirm-conflict-choice-btn"
                    onclick={() => void applyConflictChoice()}
                  >
                    {conflictChoice === 'discard' ? '确认放弃本地' : '确认覆盖云端'}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {:else if documentMissing}
          <div class="kami-alert-bar" data-testid="document-missing-panel" role="alert">
            <span class="kami-alert-text">🗑️ {syncError}</span>
            <div class="kami-confirm-actions">
              <button
                type="button"
                class="kami-btn kami-btn-mini"
                data-testid="export-local-md-btn"
                onclick={exportAnnotatedMarkdownFile}
              >
                导出本地批注
              </button>
              <button
                type="button"
                class="kami-btn kami-btn-mini kami-btn-primary"
                data-testid="save-copy-as-new-btn"
                onclick={() => void saveLocalCopyAsNewDocument()}
                disabled={savingCopyPending || !signedIn}
              >
                {savingCopyPending ? '保存中…' : '另存为新的云端文档'}
              </button>
              <button
                type="button"
                class="kami-btn kami-btn-mini"
                data-testid="discard-local-btn"
                onclick={discardLocalCopy}
              >
                放弃本地副本
              </button>
            </div>
          </div>
        {/if}

        <div
          bind:this={markdownContainerEl}
          class="kami-markdown-body"
          data-testid="markdown-rendered-body"
        >
          {@html sanitizedDocHtml}
        </div>
      </article>
    </section>

    <!-- Right Column: Conversational Annotation Panel (Hidden by default) -->
    {#if activeClip}
      <button
        type="button"
        class="mobile-annotation-backdrop"
        data-testid="mobile-annotation-backdrop"
        aria-label="关闭批注，返回正文"
        onclick={() => (selectedClipId = null)}
      ></button>
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
              <span class="drawer-clip-meta">
                (#{activeClip.id.slice(-5)} · 偏移 {activeClip.offset})
              </span>
            </div>

            <div class="drawer-header-actions">
              <button
                type="button"
                class="kami-btn"
                data-testid="delete-clip-btn"
                onclick={removeCurrentClip}
                disabled={isRequestingAi || conflict !== null || documentMissing || saveInFlight}
                title={isRequestingAi
                  ? 'AI 生成期间文档被锁定，暂不能移除曲别针'
                  : '移除此枚曲别针'}
              >
                删除 📎
              </button>
              <button
                type="button"
                class="kami-btn"
                data-testid="close-drawer-btn"
                aria-label="关闭批注"
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
          {#if activeClip.messages.length === 0 && !visibleReply}
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
                {#if msg.reasoning}
                  <details class="chat-reasoning-details" data-testid="chat-turn-reasoning">
                    <summary class="chat-reasoning-summary">
                      <span>💭 思考过程（点击展开/收起）</span>
                    </summary>
                    <div class="chat-reasoning-body" data-testid="chat-reasoning-text">{msg.reasoning}</div>
                  </details>
                {/if}
                <div class="chat-ai-html-content" data-testid="chat-ai-html">
                  {@html sanitizeAiHtml(msg.content)}
                </div>
              </div>
            {/if}
          {/each}

          {#if visibleReply}
            <div class="chat-bubble-card chat-bubble-ai" data-testid="chat-ai-loading">
              <div class="chat-role-header">
                <span>🤖 AI 正在旁征博引生成批注...</span>
                {#if visibleReply.reasoning}
                  <span class="thinking-live-badge">思考中</span>
                {/if}
              </div>
              {#if visibleReply.reasoning}
                <div class="chat-reasoning-live" data-testid="chat-ai-loading-reasoning">
                  <div class="chat-reasoning-live-title">💭 实时思考过程：</div>
                  <div
                    bind:this={liveReasoningScrollEl}
                    class="chat-reasoning-body"
                    data-testid="chat-ai-loading-reasoning-body"
                  >{visibleReply.reasoning}</div>
                </div>
              {:else}
                <div style="color: var(--kami-ink-muted); font-size: 13px;">
                  正在读取全文与 <code>&lt;!--AI_REPLY_PLACEHOLDER--&gt;</code> 上下文...
                </div>
              {/if}
              {#if visibleReply.text}
                <div
                  class="chat-ai-html-content"
                  style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--kami-border);"
                  data-testid="chat-ai-loading-reply"
                >
                  {visibleReply.text}
                </div>
              {/if}
            </div>
          {:else if isRequestingAi}
            <div class="kami-inline-note" data-testid="chat-ai-streaming-elsewhere">
              🤖 另一枚曲别针正在生成 AI 批注…（点击该曲别针可查看实时进度）
            </div>
          {/if}

          {#if replyError && replyError.clipId === activeClip.id && !visibleReply}
            <div
              class="chat-bubble-card kami-error-bubble"
              data-testid="chat-ai-error"
              role="alert"
            >
              <div>{replyError.message}</div>
              <div class="kami-error-hint">
                {#if activeClip.messages.some((m) => m.role === 'user')}
                  您的批注已保存在曲别针对话中；如需重试，请在下方重新发送。
                {:else}
                  您的批注尚未保存，可直接在下方重新发送。
                {/if}
              </div>
            </div>
          {/if}
        </div>

        <!-- Bottom Input Composer -->
        <div class="drawer-composer">
          <textarea
            bind:this={composerTextareaEl}
            class="composer-textarea"
            data-testid="annotation-input"
            aria-label="批注内容"
            placeholder="在此输入批注内容，按 Enter 发送（Shift+Enter 换行）..."
            bind:value={draftInput}
            disabled={isRequestingAi}
            onkeydown={handleComposerKeydown}
          ></textarea>
          <div class="composer-footer">
            <span class="composer-tip">
              {#if conflict !== null}
                ⚠️ 云端版本冲突，请先在左栏处理
              {:else if documentMissing}
                🗑️ 云端文档已删除，本地批注可导出或另存
              {:else if syncState === 'saving' || syncState === 'dirty'}
                ⏳ 曲别针同步中，同步完成后即可发送
              {:else if syncState === 'error'}
                ⚠️ 批注同步失败，请先「重试保存」
              {:else if !aiConfigured}
                🤖 服务端未配置 AI
              {:else}
                单次全文 Markdown + &lt;aside&gt; 注入
              {/if}
            </span>
            <button
              type="button"
              class="kami-btn kami-btn-primary"
              data-testid="send-annotation-btn"
              disabled={
                !draftInput.trim() ||
                isRequestingAi ||
                syncState !== 'clean' ||
                conflict !== null ||
                documentMissing ||
                openDocumentPending ||
                uploadingFiles
              }
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

  <!-- Cloud Document Library Modal -->
  {#if showLibraryModal}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="kami-modal-backdrop"
      data-testid="library-modal-backdrop"
      onclick={(e) => {
        if (e.target === e.currentTarget) showLibraryModal = false;
      }}
    >
      <div class="kami-modal-card" data-testid="library-modal">
        <div class="kami-modal-header">
          <span>🗂️ 云端文档库</span>
          <div class="kami-modal-actions">
            <button
              type="button"
              class="kami-btn"
              data-testid="refresh-library-btn"
              onclick={() => void refreshLibrary()}
              disabled={libraryLoading}
            >
              刷新
            </button>
            <button
              type="button"
              class="kami-btn"
              data-testid="close-library-btn"
              onclick={() => (showLibraryModal = false)}
            >
              关闭
            </button>
          </div>
        </div>

        <div class="kami-modal-body">
          {#if libraryLoading && libraryDocs.length === 0}
            <div class="kami-loading-state" data-testid="library-loading">
              ⏳ 正在读取云端文档列表…
            </div>
          {:else if libraryError && libraryDocs.length === 0}
            <div class="kami-alert-bar" data-testid="library-error" role="alert">
              <span class="kami-alert-text">⚠️ {libraryError}</span>
              <button
                type="button"
                class="kami-btn kami-btn-mini"
                data-testid="retry-library-btn"
                onclick={() => void refreshLibrary()}
              >
                重试
              </button>
            </div>
          {:else if libraryDocs.length === 0}
            <div class="drawer-empty-state" data-testid="library-empty">
              <div style="font-size: 30px; margin-bottom: 8px;">📂</div>
              <div>云端文档库还是空的。</div>
              <div style="margin: 12px 0;">
                <button
                  type="button"
                  class="kami-btn kami-btn-primary"
                  data-testid="upload-from-library-btn"
                  onclick={openMarkdownFileDialog}
                  disabled={uploadingFiles || openDocumentPending || savingSamplePending}
                >
                  {uploadingFiles ? '上传中…' : '选择 Markdown 文件上传'}
                </button>
              </div>
              {#if documentId === null}
                <button
                  type="button"
                  class="kami-btn"
                  data-testid="save-sample-btn"
                  onclick={saveSampleToCloud}
                  disabled={switchingBlocked}
                >
                  ☁️ 将当前示例文档保存到云端
                </button>
              {/if}
            </div>
          {:else}
            <ul class="library-list" data-testid="library-list">
              {#each libraryDocs as doc (doc.id)}
                <li
                  class="library-row"
                  data-testid="cloud-document-row"
                  data-document-id={doc.id}
                  class:is-active={doc.id === documentId}
                >
                  <div class="library-row-main">
                    <span class="library-row-name" title={doc.name}>📄 {doc.name}</span>
                    <span class="library-row-meta">
                      <span>更新：{formatTime(doc.updatedAt)}</span>
                      <span>·</span>
                      <span data-testid="library-row-clip-count">{doc.clipCount} 枚曲别针</span>
                      <span>·</span>
                      <span>v{doc.revision}</span>
                    </span>
                  </div>
                  <div class="library-row-actions">
                    <button
                      type="button"
                      class="kami-btn kami-btn-mini kami-btn-primary"
                      data-testid="open-cloud-document-btn"
                      disabled={switchingBlocked}
                      title={switchingBlocked
                        ? '当前文档有未保存/未解决的修改或正在上传、生成，暂不能切换'
                        : '打开此云端文档'}
                      onclick={() => void openCloudDocument(doc)}
                    >
                      {doc.id === documentId ? '当前' : '打开'}
                    </button>
                    <button
                      type="button"
                      class="kami-btn kami-btn-mini kami-btn-danger"
                      data-testid="delete-cloud-document-btn"
                      disabled={deletingDocumentId === doc.id || switchingBlocked}
                      title={switchingBlocked
                        ? '存在未保存/未解决的修改或正在上传、生成，暂不能删除'
                        : '删除此云端文档（不可恢复）'}
                      onclick={() => askDeleteCloudDocument(doc)}
                    >
                      {deletingDocumentId === doc.id ? '删除中' : '删除'}
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
            {#if libraryError}
              <div class="kami-alert-bar" role="alert" data-testid="library-refresh-error">
                <span class="kami-alert-text">⚠️ {libraryError}</span>
              </div>
            {/if}
            {#if switchingBlocked}
              <div class="kami-inline-note" data-testid="library-switch-locked">
                {#if conflict !== null}
                  云端版本冲突待处理，处理完成后方可切换或删除文档。
                {:else if documentMissing}
                  云端文档已删除，本地副本待导出或另存，完成后方可切换文档。
                {:else if hasUnsavedWork}
                  当前文档存在未保存到云端的批注，同步完成后方可切换或删除文档。
                {:else if uploadingFiles || savingSamplePending || openDocumentPending}
                  正在上传或打开文档，完成后方可切换或删除文档。
                {:else}
                  AI 正在生成批注，完成后方可切换或删除文档。
                {/if}
              </div>
            {/if}
          {/if}
        </div>

        {#if pendingDelete}
          <div class="kami-confirm-panel" data-testid="delete-confirm-panel" role="alertdialog" aria-modal="true">
            <div class="kami-confirm-text">
              确定删除「{pendingDelete.name}」及其全部曲别针批注吗？此操作不可恢复。
            </div>
            <div class="kami-confirm-actions">
              <button
                type="button"
                class="kami-btn kami-btn-mini"
                data-testid="cancel-delete-document-btn"
                onclick={() => (pendingDelete = null)}
              >
                取消
              </button>
              <button
                type="button"
                class="kami-btn kami-btn-mini kami-btn-danger"
                data-testid="confirm-delete-document-btn"
                onclick={() => void confirmDeleteCloudDocument()}
              >
                确认删除
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Account Modal -->
  {#if showAccountModal}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="kami-modal-backdrop"
      data-testid="account-modal-backdrop"
      onclick={(e) => {
        if (e.target === e.currentTarget) showAccountModal = false;
      }}
    >
      <div class="kami-modal-card kami-modal-card-narrow" data-testid="account-modal">
        <div class="kami-modal-header">
          <span>👤 我的账户</span>
          <button
            type="button"
            class="kami-btn"
            data-testid="close-account-btn"
            onclick={() => (showAccountModal = false)}
          >
            关闭
          </button>
        </div>

        <div class="kami-modal-body">
          {#if accountUser}
            <div class="account-identity" data-testid="account-identity">
              <span class="account-avatar" aria-hidden="true">👤</span>
              <span class="account-lines">
                <strong data-testid="account-name">{accountUser.name}</strong>
                <span data-testid="account-email">{accountUser.email ?? '未获取到邮箱信息'}</span>
              </span>
            </div>
            <p class="kami-note">
              批注与文档均保存在您自己的云端账户中；切换设备时使用同一 Amazon 账户登录即可继续。
            </p>
          {:else if authConfigured}
            <p class="kami-note">
              使用 Amazon 账户登录云端后，即可上传 Markdown、保存曲别针批注并与 AI 对话。
            </p>
          {:else if sessionUnavailable}
            <p class="kami-note" data-testid="auth-unconfigured-note">
              {loginHint}
            </p>
          {:else}
            <p class="kami-note" data-testid="auth-unconfigured-note">
              服务端尚未配置 Amazon OAuth（缺少 clientId/clientSecret），当前仅可浏览示例文档。
            </p>
          {/if}
          <p class="kami-note" data-testid="ai-config-note">
            {#if aiConfigured}
              🤖 AI 服务端配置：已就绪（模型与密钥均由服务端保管，浏览器不保存任何密钥）。
            {:else if sessionUnavailable}
              🤖 AI 服务端配置：未知（暂时无法读取 /api/session，请重试）。
            {:else}
              🤖 AI 服务端配置：未就绪，暂时无法生成 AI 批注回复。
            {/if}
          </p>
        </div>

        <div class="kami-modal-footer">
          {#if accountUser}
            <button
              type="button"
              class="kami-btn"
              data-testid="library-from-account-btn"
              onclick={openLibraryModal}
            >
              🗂️ 云端文档库
            </button>
            <button
              type="button"
              class="kami-btn kami-btn-danger"
              data-testid="logout-btn"
              onclick={() => void handleSignOut()}
            >
              退出登录
            </button>
          {:else if authConfigured}
            <a
              class="kami-btn kami-btn-primary kami-btn-amazon external"
              data-testid="account-login-btn"
              href="/auth/amazon"
              rel="noopener"
            >
              🔑 使用 Amazon 登录
            </a>
          {/if}
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
          <span>📜 批注源文</span>
          <div class="kami-modal-actions">
            <button
              type="button"
              class="kami-btn"
              onclick={exportAnnotatedMarkdownFile}
            >
              💾 导出 Markdown
            </button>
            <button
              type="button"
              class="kami-btn"
              data-testid="close-markdown-modal-btn"
              onclick={() => (showMarkdownModal = false)}
            >
              关闭
            </button>
          </div>
        </div>

        <div class="kami-modal-body">
          <div style="font-size: 12.5px; color: var(--kami-ink-secondary);">
            AI 只读 Markdown 原文，所有曲别针均以语义化 HTML <code>&lt;aside class="annotation"&gt;</code> 精确嵌入对应位置（遵循最小避让原则，不破坏数学公式等结构）：
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
