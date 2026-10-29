<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Framework7 from 'framework7/lite-bundle';
  import DOMPurify from 'dompurify';
  import {
    renderMarkdownToHtml,
    buildAnnotatedMarkdown,
    getSnippetAround,
    resolveSafeOffset,
    isLegacyHtmlReply,
    type ClipAnnotation
  } from './lib/markdown';
  import {
    resolveMarkdownOffsetFromPoint,
    mountPaperclipsIntoDom
  } from './lib/dom-mapper';
  import {
    longPress,
    LONG_PRESS_DURATION_MS,
    LONG_PRESS_GHOST_DELAY_MS,
    MOVE_CANCEL_THRESHOLD_PX
  } from './lib/long-press';
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
    streamWikiDraft,
    updateDocument
  } from './lib/api-client';
  import { streamPhaseOf } from './lib/stream-phase';
  import SideDrawer from './components/SideDrawer.svelte';
  import Composer from './components/Composer.svelte';
  import AiStreamCard from './components/AiStreamCard.svelte';
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

  /** AI annotation replies are light Markdown; legacy stored replies are light HTML. */
  function renderAiReply(content: string): string {
    return isLegacyHtmlReply(content)
      ? sanitizeAiHtml(content)
      : sanitizeDocumentHtml(renderMarkdownToHtml(content).html);
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
  // Server is the single source of truth: the view only ever renders the last
  // server snapshot. One mutation at a time; whatever the server answers
  // (success, 409 snapshot, 404) replaces the view verbatim.
  // ---------------------------------------------------------------------------
  let mutationPending = $state<boolean>(false);

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
  let uploadingFiles = $state<boolean>(false);

  // ---------------------------------------------------------------------------
  // Long-press state for progressive 📎 placement
  // ---------------------------------------------------------------------------
  let isLongPressing = $state<boolean>(false);
  /** The ghost 📎 only appears once the press has clearly been held (not a drag/scroll). */
  let pressGhostVisible = $state<boolean>(false);
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
    /** Raw composer text at send time, restored if the turn never reached the server. */
    draft: string;
  } | null>(null);
  let replyAbort: AbortController | null = null;

  const isRequestingAi = $derived(activeReply !== null);
  const visibleReply = $derived(
    activeReply && activeReply.documentId === documentId && activeReply.clipId === selectedClipId
      ? activeReply
      : null
  );

  const replyPhase = $derived(streamPhaseOf(visibleReply));

  // ---------------------------------------------------------------------------
  // Encyclopedia drafting (left sidebar → streamed on the main reader)
  // ---------------------------------------------------------------------------
  let wikiPanelOpen = $state<boolean>(false);
  let wikiPrompt = $state<string>('');
  let wikiComposerFocused = $state<boolean>(false);
  let wikiError = $state<string | null>(null);
  let activeWiki = $state<{ prompt: string; reasoning: string; text: string } | null>(null);
  let wikiAbort: AbortController | null = null;
  let wikiReasoningEl: HTMLElement | undefined = $state();
  const wikiPhase = $derived(streamPhaseOf(activeWiki));
  const wikiPreviewHtml = $derived(
    activeWiki?.text ? sanitizeDocumentHtml(renderMarkdownToHtml(activeWiki.text).html) : ''
  );

  // ---------------------------------------------------------------------------
  // Modals / DOM refs
  // ---------------------------------------------------------------------------
  let toastMessage = $state<string | null>(null);
  let toastTimer: number | null = null;

  let fileInputEl: HTMLInputElement | undefined = $state();
  let markdownContainerEl: HTMLElement | undefined = $state();
  let readerPaneEl: HTMLElement | undefined = $state();
  let messagesScrollEl: HTMLElement | undefined = $state();
  let liveReasoningScrollEl: HTMLElement | undefined = $state();
  let composerTextareaEl: HTMLTextAreaElement | undefined = $state();
  let composerFocused = $state(false);
  let f7Instance: Framework7 | null = null;
  let pollTimer: number | null = null;

  // ---------------------------------------------------------------------------
  // Derived view values
  // ---------------------------------------------------------------------------
  let renderedDoc = $derived(renderMarkdownToHtml(baseMarkdown));
  let sanitizedDocHtml = $derived(sanitizeDocumentHtml(renderedDoc.html));
  let activeClip = $derived(clips.find((c) => c.id === selectedClipId) ?? null);
  /** Anything that could replace or mutate the server snapshot must be idle first. */
  const isBusy = $derived(
    mutationPending ||
      activeReply !== null ||
      activeWiki !== null ||
      openDocumentPending ||
      uploadingFiles ||
      deletingDocumentId !== null
  );
  let canAnnotate = $derived(signedIn && isCloudDocument && !isBusy);
  let switchingBlocked = $derived(isBusy);

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
  }

  function captureAccount(): AccountScope {
    return { epoch: accountEpoch, userId: session?.user?.id ?? null };
  }

  function captureView(): ViewScope {
    return {
      ...captureAccount(),
      documentId
    };
  }

  function accountStillCurrent(started: AccountScope): boolean {
    return accountEpoch === started.epoch && (session?.user?.id ?? null) === started.userId;
  }

  function viewStillCurrent(started: ViewScope): boolean {
    return (
      accountStillCurrent(started) &&
      documentId === started.documentId
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

  function clearAccountData(reason: string | null): void {
    // Invalidate every in-flight request first, then drop all private state.
    accountEpoch += 1;
    session = session ? { ...session, user: null, csrfToken: null } : session;
    setCsrfToken(null);
    abortActiveReply();
    abortActiveWiki();
    wikiPanelOpen = false;
    wikiPrompt = '';
    wikiError = null;
    cancelLongPress();
    mutationPending = false;
    libraryDocs = [];
    libraryError = null;
    libraryLoading = false;
    pendingDelete = null;
    showLibraryModal = false;
    showAccountModal = false;
    openDocumentPending = false;
    uploadingFiles = false;
    draftInput = '';
    replyError = null;
    resetToSample();
    purgeLegacyAiSettings();
    if (reason) showToast(reason);
  }

  async function handleSignOut() {
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
  // Document view = last server snapshot
  // ---------------------------------------------------------------------------
  function resetToSample(): void {
    cancelLongPress();
    documentId = null;
    documentName = DEFAULT_SAMPLE_FILENAME;
    baseMarkdown = DEFAULT_SAMPLE_MARKDOWN;
    clips = [];
    serverRevision = 0;
    serverUpdatedAt = null;
    selectedClipId = null;
    replyError = null;
  }

  /** Render a server snapshot verbatim, keeping the open 📎 if it still exists. */
  function applyAuthoritativeSnapshot(doc: CloudDocument): void {
    cancelLongPress();
    documentId = doc.id;
    documentName = doc.name;
    baseMarkdown = doc.markdown;
    clips = doc.clips;
    serverRevision = doc.revision;
    serverUpdatedAt = doc.updatedAt ?? Date.now();
    if (selectedClipId && !clips.some((c) => c.id === selectedClipId)) selectedClipId = null;
  }

  /** Switch the view to another server document. */
  function adoptCloudDocument(doc: CloudDocument): void {
    selectedClipId = null;
    replyError = null;
    applyAuthoritativeSnapshot(doc);
  }

  /** The open document is gone on the server: leave it, nothing local survives. */
  function dropMissingDocument(id: string): void {
    const goneName = documentName;
    libraryDocs = libraryDocs.filter((d) => d.id !== id);
    if (documentId === id) resetToSample();
    showToast(`云端文档「${goneName}」已被删除或不再可用。`);
  }

  /** Re-read the open document; used whenever a request leaves us unsure. */
  async function reloadActiveDocument(): Promise<void> {
    const started = captureView();
    if (started.documentId === null || started.userId === null) return;
    try {
      const doc = await getDocument(started.documentId);
      if (viewStillCurrent(started)) applyAuthoritativeSnapshot(doc);
    } catch (err) {
      if (!viewStillCurrent(started)) return;
      if (err instanceof ApiError && err.notFound) dropMissingDocument(started.documentId);
      else if (err instanceof ApiError && err.unauthorized) handle401(err.message);
    }
  }

  /**
   * Converge on the server after a failed request against the open document:
   * a 409 carries the current snapshot, a 404 closes the document, anything
   * else triggers a refetch. The client never merges or retries on its own.
   */
  function recoverFromServerError(err: unknown, started: ViewScope, fallback: string): void {
    if (!accountStillCurrent(started)) return;
    if (err instanceof ApiError && err.unauthorized) {
      handle401(err.message);
      return;
    }
    if (!viewStillCurrent(started) || started.documentId === null) return;
    if (err instanceof ApiError && err.notFound) {
      dropMissingDocument(started.documentId);
    } else if (err instanceof ApiError && err.document?.id === started.documentId) {
      applyAuthoritativeSnapshot(err.document);
      showToast(`${describeApiError(err, fallback)}，已显示云端最新版本。`);
    } else {
      showToast(describeApiError(err, fallback));
      void reloadActiveDocument();
    }
  }

  /**
   * Send the next clip list to the server and render its answer. Returns the
   * server snapshot, or null when the server did not accept the change.
   */
  async function commitClips(nextClips: ClipAnnotation[]): Promise<CloudDocument | null> {
    const started = captureView();
    if (started.documentId === null || mutationPending) return null;
    mutationPending = true;
    try {
      const doc = await updateDocument(started.documentId, serverRevision, nextClips);
      if (!viewStillCurrent(started)) return null;
      applyAuthoritativeSnapshot(doc);
      return doc;
    } catch (err) {
      recoverFromServerError(err, started, '批注保存失败');
      return null;
    } finally {
      if (accountStillCurrent(started)) mutationPending = false;
    }
  }

  /** Save Markdown to the user's device; clips are embedded as `<aside>` so a re-import restores them. */
  function downloadMarkdownFile(name: string, markdown: string, clipsToEmbed: ClipAnnotation[]): void {
    const blob = new Blob([buildAnnotatedMarkdown(markdown, clipsToEmbed)], {
      type: 'text/markdown;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/\.md$/i, '') || 'document'}.md`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
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

  /** Long-press on a library row: download that document with its clips embedded. */
  async function downloadCloudDocument(doc: DocumentSummary): Promise<void> {
    // The open document may hold clips not yet synced; the local view is the freshest copy.
    if (doc.id === documentId) {
      downloadMarkdownFile(documentName, baseMarkdown, clips);
      showToast(`已下载「${documentName}」`);
      return;
    }
    const started = captureAccount();
    showToast(`正在下载「${doc.name}」…`);
    try {
      const full = await getDocument(doc.id);
      if (!accountStillCurrent(started)) return;
      downloadMarkdownFile(full.name, full.markdown, full.clips);
      showToast(`已下载「${full.name}」`);
    } catch (err) {
      if (!accountStillCurrent(started)) return;
      if (err instanceof ApiError && err.notFound) {
        libraryDocs = libraryDocs.filter((d) => d.id !== doc.id);
        showToast('该文档已不存在，列表已刷新。');
      } else if (err instanceof ApiError && err.unauthorized) {
        handle401(err.message);
      } else {
        showToast(describeApiError(err, '下载云端文档失败，请稍后重试。'));
      }
    }
  }

  async function openCloudDocument(doc: DocumentSummary) {
    const started = captureView();
    if (started.userId === null) return;
    if (switchingBlocked) {
      showToast('正在上传/保存/生成，请稍候。');
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
    if (isBusy) {
      showToast('正在上传/保存/打开文档，暂不可删除。');
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
    if (openDocumentPending || mutationPending) return;

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

    // Ignore if user clicked on an existing 📎 paperclip badge or live-generation chrome
    if (target.closest('.clip-anchor-pin') || target.closest('[data-no-annotate]')) {
      return;
    }

    if (!canAnnotate) {
      if (!signedIn) showToast('登录后才能批注云端文档。');
      else if (activeWiki) showToast('AI 正在撰写百科条目，完成后即可长按批注。');
      else if (isRequestingAi) showToast('AI 正在生成批注，完成后方可放置或删除曲别针。');
      else if (isBusy) showToast('正在同步/上传，请稍候。');
      else showToast('请先在「云端文档库」打开 Markdown 文件，或用「百科条目撰写」生成文档，再进行批注。');
      return;
    }

    cancelLongPress();
    suppressNextClick = false;

    const lastColor = clips[clips.length - 1]?.color;
    pressColor = pickRandomClipColor(lastColor);
    pressClientX = event.clientX;
    pressClientY = event.clientY;
    pressStartTime = performance.now();
    pressProgress = 0;
    pressGhostVisible = false;
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
      if (elapsed >= LONG_PRESS_GHOST_DELAY_MS) pressGhostVisible = true;
      // The visible ring fills over the time the ghost is actually shown.
      pressProgress = Math.min(
        1,
        Math.max(0.06, (elapsed - LONG_PRESS_GHOST_DELAY_MS) / (LONG_PRESS_DURATION_MS - LONG_PRESS_GHOST_DELAY_MS))
      );
      if (pressProgress < 1) {
        pressRafId = window.requestAnimationFrame(updateProgress);
      }
    };
    pressRafId = window.requestAnimationFrame(updateProgress);

    pressTimerId = window.setTimeout(() => {
      void finalizePaperclipPlacement();
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
    pressGhostVisible = false;
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

  async function finalizePaperclipPlacement(): Promise<void> {
    const pressDocument = pressDocumentId;
    cancelLongPress();
    suppressNextClick = true;

    // The view may have moved (document switch, account purge, a server refresh, a new
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

    const saved = await commitClips([...clips, newClip]);
    if (!saved?.clips.some((c) => c.id === newClipId)) return;
    selectedClipId = newClipId;

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
        // The user turn is now provably persisted: the draft (already cleared
        // on send) no longer needs to be restored on failure.
        const stream = activeReply;
        if (stream && !stream.draftCleared) stream.draftCleared = true;
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
        if (activeReply) restoreUnsentDraft(activeReply);
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

  /** Put an unsent question back into an empty composer (never overwrite newer typing). */
  function restoreUnsentDraft(stream: { draftCleared: boolean; draft: string }): void {
    if (stream.draftCleared || !stream.draft.trim() || draftInput.trim()) return;
    stream.draftCleared = true;
    draftInput = stream.draft;
  }

  async function handleSendAnnotation() {
    const rawText = composerTextareaEl ? composerTextareaEl.value : draftInput;
    // Empty input is allowed: the server then lets the AI annotate on its own.
    const content = rawText.trim();
    if (!selectedClipId || !documentId || activeReply) return;

    const targetClipId = selectedClipId;
    const targetDocumentId = documentId;
    if (mutationPending) {
      showToast('正在保存到云端，请稍候再发送。');
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
    // Clear the composer as soon as the turn is sent; if the server never
    // persists it (pre-stream rejection), the typed text is put back.
    activeReply = {
      documentId: targetDocumentId,
      clipId: targetClipId,
      content,
      reasoning: '',
      text: '',
      draftCleared: false,
      draft: rawText
    };
    const sentStream = activeReply;
    draftInput = '';
    if (composerTextareaEl) composerTextareaEl.value = '';
    const controller = new AbortController();
    replyAbort = controller;

    await tick();
    scrollToBottomOfMessages();

    const started = captureView();
    try {
      await streamReply({
        documentId: targetDocumentId,
        revision: serverRevision,
        clipId: targetClipId,
        content,
        signal: controller.signal,
        onEvent: handleReplyEvent
      });
    } catch (err) {
      activeReply = null;
      if (controller.signal.aborted) return;
      if (!(err instanceof ApiError && err.unauthorized)) restoreUnsentDraft(sentStream);
      if (!(err instanceof ApiError && err.unauthorized) && viewStillCurrent(started)) {
        replyError = {
          clipId: targetClipId,
          message: describeApiError(err, 'AI 批注生成失败，请重新发送批注。')
        };
      }
      recoverFromServerError(err, started, 'AI 批注生成失败');
    } finally {
      if (replyAbort === controller) replyAbort = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Encyclopedia drafting
  // ---------------------------------------------------------------------------
  function isMobileLayout(): boolean {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  function toggleWikiPanel(): void {
    if (wikiPanelOpen) {
      wikiPanelOpen = false;
      return;
    }
    // Phones show one overlay drawer at a time.
    if (isMobileLayout()) selectedClipId = null;
    wikiPanelOpen = true;
  }

  function abortActiveWiki(): void {
    if (wikiAbort) {
      wikiAbort.abort();
      wikiAbort = null;
    }
    activeWiki = null;
  }

  function restoreWikiPrompt(prompt: string): void {
    if (!wikiPrompt.trim()) wikiPrompt = prompt;
  }

  function cancelWikiDraft(): void {
    const prompt = activeWiki?.prompt ?? '';
    abortActiveWiki();
    restoreWikiPrompt(prompt);
    wikiPanelOpen = true;
    showToast('已停止撰写百科条目，提示已保留，可修改后重新发送。');
  }

  async function handleWikiSubmit(): Promise<void> {
    const brief = wikiPrompt.trim();
    if (!brief || activeWiki) return;
    if (!signedIn) {
      showToast('登录云端账户后即可撰写百科条目。');
      showAccountModal = true;
      return;
    }
    if (!aiConfigured) {
      wikiError = '服务端尚未配置 AI，暂时无法撰写百科条目。';
      return;
    }
    if (isBusy) {
      showToast('正在上传/保存/生成，请稍候。');
      return;
    }

    wikiError = null;
    wikiPanelOpen = false; // auto-close: the generation streams on the main reader
    wikiComposerFocused = false;
    selectedClipId = null;
    cancelLongPress();
    activeWiki = { prompt: brief, reasoning: '', text: '' };
    wikiPrompt = ''; // clear the input on send; restored if generation fails
    const controller = new AbortController();
    wikiAbort = controller;
    const started = captureAccount();
    void tick().then(() => readerPaneEl?.scrollTo({ top: 0 }));

    try {
      await streamWikiDraft({
        prompt: brief,
        signal: controller.signal,
        onEvent: (event) => {
          if (wikiAbort !== controller || !accountStillCurrent(started)) return;
          switch (event.type) {
            case 'reasoning':
              if (activeWiki) activeWiki.reasoning += event.delta;
              void tick().then(() => {
                if (wikiReasoningEl) wikiReasoningEl.scrollTop = wikiReasoningEl.scrollHeight;
              });
              break;
            case 'text':
              if (activeWiki) activeWiki.text += event.delta;
              break;
            case 'done':
              activeWiki = null;
              abortActiveReply();
              adoptCloudDocument(event.document);
              void refreshLibrary();
              showToast(
                `已生成并保存百科条目「${event.document.name.replace(/\.md$/i, '')}」，长按段落即可放置 📎 批注`,
                4200
              );
              break;
            case 'error':
              wikiError = event.error?.message?.trim() || 'AI 百科条目生成失败，请重试。';
              restoreWikiPrompt(brief);
              activeWiki = null;
              break;
            default:
              break;
          }
        }
      });
    } catch (err) {
      if (controller.signal.aborted || !accountStillCurrent(started)) return;
      if (err instanceof ApiError && err.unauthorized) {
        handle401(err.message);
        return;
      }
      wikiError = describeApiError(err, 'AI 百科条目生成失败，请重试。');
      restoreWikiPrompt(brief);
    } finally {
      if (wikiAbort === controller) {
        wikiAbort = null;
        activeWiki = null;
      }
    }
  }

  async function removeCurrentClip(): Promise<void> {
    const idToRemove = selectedClipId;
    if (!idToRemove || documentId === null) return;
    if (isBusy) {
      showToast('正在保存或生成，请稍候再移除曲别针。');
      return;
    }
    const saved = await commitClips(clips.filter((c) => c.id !== idToRemove));
    if (!saved || saved.clips.some((c) => c.id === idToRemove)) return;
    if (replyError?.clipId === idToRemove) replyError = null;
    showToast('已移除该枚曲别针批注');
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
    if (documentId === null || isBusy || document.visibilityState !== 'visible') return;
    const revisionAtStart = serverRevision;
    const started = captureView();
    try {
      const doc = await getDocument(started.documentId as string);
      // A mutation that landed meanwhile already rendered a newer snapshot.
      if (!viewStillCurrent(started) || isBusy || serverRevision !== revisionAtStart) return;
      applyAuthoritativeSnapshot(doc);
    } catch (err) {
      if (!viewStillCurrent(started) || isBusy) return;
      if (err instanceof ApiError && err.notFound) dropMissingDocument(started.documentId as string);
      else if (err instanceof ApiError && err.unauthorized) handle401(err.message);
      // Transient errors: the next tick asks the server again.
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
    if (mutationPending) return '正在保存到云端…';
    return `已同步 · 版本 ${serverRevision} · ${formatTime(serverUpdatedAt)}`;
  });

  function handleBeforeUnload(event: BeforeUnloadEvent) {
    if (mutationPending || isRequestingAi || activeWiki !== null || uploadingFiles) {
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

  // Track the *visible* viewport (above the soft keyboard) so the mobile annotation
  // drawer can be sized to it and the composer + send button stay on screen.
  onMount(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let frame = 0;
    const sync = () => {
      frame = 0;
      root.style.setProperty('--vv-height', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    sync();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty('--vv-height');
      root.style.removeProperty('--vv-top');
    };
  });

  $effect(() => {
    return () => {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      cancelLongPress();
      if (replyAbort) replyAbort.abort();
      if (wikiAbort) wikiAbort.abort();
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
            data-sync-state={documentId === null ? 'local' : mutationPending ? 'saving' : 'clean'}
            title={syncStatusLabel}
          >{syncStatusLabel}</span>
        </span>
      </div>
    </div>

    <div class="kami-toolbar-actions">
      <button
        type="button"
        class="kami-btn kami-btn-primary"
        class:is-active={wikiPanelOpen}
        data-testid="open-wiki-btn"
        aria-pressed={wikiPanelOpen}
        onclick={toggleWikiPanel}
        title="百科条目撰写：AI 按任意提示自拟标题与正文（仿 Wikipedia 体裁）"
      >
        <span aria-hidden="true">📚</span>
        <span class="toolbar-label-wide">{activeWiki ? '条目撰写中…' : '百科条目撰写'}</span>
        <span class="toolbar-label-compact">{activeWiki ? '撰写中' : '百科'}</span>
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
    {#if wikiPanelOpen}
      <SideDrawer
        side="left"
        testid="left-wiki-panel"
        backdropTestid="mobile-wiki-backdrop"
        closeTestid="close-wiki-btn"
        closeLabel="关闭百科条目撰写"
        closeTitle="隐藏左栏"
        compact={wikiComposerFocused}
        bodyTestid="wiki-panel-body"
        onclose={() => (wikiPanelOpen = false)}
      >
        {#snippet title()}
          <span>📚 百科条目撰写</span>
        {/snippet}
        {#snippet subheader()}
          <div class="drawer-anchor-preview">仿 Wikipedia 文章体裁 · AI 自拟标题与正文 · 完成后自动存入云端</div>
        {/snippet}
        {#snippet body()}
          <div class="drawer-empty-state" data-testid="wiki-panel-hint">
            <div style="font-size: 28px; margin-bottom: 8px;">📚</div>
            <div>输入任意提示：一个主题词、一句需求、一段素材或写作要求都可以。</div>
            <div>发送后本栏自动收起，主界面会实时显示 AI 的思考过程与条目 Markdown；完成后即成为当前云端文档，可直接长按放置 📎 继续批注对话。</div>
          </div>
          {#if wikiError}
            <div class="chat-bubble-card kami-error-bubble" role="alert" data-testid="wiki-error">
              {wikiError}
            </div>
          {/if}
        {/snippet}
        {#snippet footer()}
          <Composer
            bind:value={wikiPrompt}
            bind:focused={wikiComposerFocused}
            placeholder="例如：量子纠缠；或「写一篇关于宋代活字印刷的条目，侧重技术演变」。Enter 换行，Ctrl+Enter 发送..."
            ariaLabel="百科条目撰写提示"
            inputTestid="wiki-prompt-input"
            sendTestid="wiki-submit-btn"
            sendLabel={activeWiki ? '撰写中...' : '撰写条目'}
            disabled={activeWiki !== null}
            sendDisabled={!wikiPrompt.trim() || !signedIn || isBusy}
            onsend={() => void handleWikiSubmit()}
          >
            {#snippet tip()}
              {#if !signedIn}
                🔒 登录后可撰写百科条目
              {:else if !aiConfigured}
                🤖 服务端未配置 AI
              {:else}
                AI 自拟标题 · Wikipedia 体裁 · 自动存入云端
              {/if}
            {/snippet}
          </Composer>
        {/snippet}
      </SideDrawer>
    {/if}

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section
      bind:this={readerPaneEl}
      class="kami-reader-pane"
      data-testid="left-reader-pane"
      onpointerdown={handleDocPointerDown}
      onpointermove={handleDocPointerMove}
      onpointerup={handleDocPointerUp}
      onpointercancel={handleDocPointerCancel}
      onclick={handleDocClick}
    >
      <article class="kami-paper-sheet" data-testid="markdown-paper-sheet">
        <!-- The sample document explains usage itself; only real (cloud or
             in-progress wiki) documents get the short long-press reminder. -->
        {#if isCloudDocument || activeWiki}
          <div class="kami-sheet-meta" data-testid="sheet-tip">
            <span class="kami-sheet-hint">💡 长按任意段落别上 📎 曲别针 · 点击空白处收起右栏</span>
          </div>
        {/if}

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

        {#if activeWiki && wikiPhase !== 'replying'}
          <div class="wiki-live" data-testid="wiki-live" data-no-annotate>
            <div class="wiki-live-head">
              <div class="wiki-live-prompt" title={activeWiki.prompt}>📚 百科条目撰写 · 提示：{activeWiki.prompt}</div>
              <button
                type="button"
                class="kami-btn kami-btn-mini"
                data-testid="wiki-cancel-btn"
                onclick={cancelWikiDraft}
              >
                停止生成
              </button>
            </div>
            <AiStreamCard
              heading="📚 AI 百科条目"
              phase={wikiPhase}
              reasoning={activeWiki.reasoning}
              idleText="正在构思条目标题与章节结构…"
              testid="wiki-live-card"
              reasoningTestid="wiki-live-reasoning"
              extraClass="wiki-live-card"
              bind:reasoningEl={wikiReasoningEl}
            >
              {#snippet content()}{/snippet}
            </AiStreamCard>
          </div>
        {:else if wikiError}
          <div class="kami-alert-bar" role="alert" data-testid="wiki-error-banner" data-no-annotate>
            <span class="kami-alert-text">📚 {wikiError}</span>
            <div class="kami-confirm-actions">
              <button
                type="button"
                class="kami-btn kami-btn-mini kami-btn-primary"
                data-testid="wiki-retry-btn"
                onclick={() => (wikiPanelOpen = true)}
              >
                返回修改提示
              </button>
              <button
                type="button"
                class="kami-btn kami-btn-mini"
                onclick={() => (wikiError = null)}
              >
                知道了
              </button>
            </div>
          </div>
        {/if}

        {#if activeWiki && wikiPhase === 'replying'}
          <!-- Body streams with the exact reader markup/typography of the finished
               document, so the switch to the saved document causes no layout jump. -->
          <div class="kami-markdown-body" data-testid="wiki-live-markdown" aria-busy="true">
            {@html wikiPreviewHtml}
          </div>
          <div class="wiki-stop-fab" data-testid="wiki-live-status" data-no-annotate>
            <span class="thinking-live-badge">撰写中</span>
            <span class="wiki-stop-fab-text">AI 正在撰写百科条目…</span>
            <button
              type="button"
              class="kami-btn kami-btn-mini"
              data-testid="wiki-cancel-btn"
              onclick={cancelWikiDraft}
            >
              停止生成
            </button>
          </div>
        {/if}

        <div
          bind:this={markdownContainerEl}
          class="kami-markdown-body"
          data-testid="markdown-rendered-body"
          hidden={activeWiki !== null}
        >
          {@html sanitizedDocHtml}
        </div>
      </article>
    </section>

    <!-- Right Column: Conversational Annotation Panel (Hidden by default) -->
    {#if activeClip}
      {@const clip = activeClip}
      <SideDrawer
        side="right"
        testid="right-annotation-panel"
        backdropTestid="mobile-annotation-backdrop"
        closeTestid="close-drawer-btn"
        closeLabel="关闭批注"
        closeTitle="隐藏右栏"
        compact={composerFocused}
        style="--clip-accent: {clip.color}"
        bodyTestid="annotation-messages-list"
        bind:bodyEl={messagesScrollEl}
        onclose={() => (selectedClipId = null)}
      >
        {#snippet title()}
          <span class="drawer-color-dot" style="background-color: {clip.color}"></span>
          <span>📎 对话式批注</span>
          <span class="drawer-clip-meta">(#{clip.id.slice(-5)} · 偏移 {clip.offset})</span>
        {/snippet}
        {#snippet actions()}
          <button
            type="button"
            class="kami-btn"
            data-testid="delete-clip-btn"
            onclick={removeCurrentClip}
            disabled={isBusy}
            title={isRequestingAi
              ? 'AI 生成期间文档被锁定，暂不能移除曲别针'
              : '移除此枚曲别针'}
          >
            删除 📎
          </button>
        {/snippet}
        {#snippet subheader()}
          <div class="drawer-anchor-preview" data-testid="drawer-anchor-snippet" title={clip.anchorSnippet}>
            锚点：{clip.anchorSnippet}
          </div>
        {/snippet}
        {#snippet body()}
          {#if clip.messages.length === 0 && !visibleReply}
            <div class="drawer-empty-state" data-testid="drawer-empty-hint">
              <div style="font-size: 28px; margin-bottom: 8px;">📎</div>
              <div>曲别针已别在文档第 <strong>{clip.offset}</strong> 字符处。</div>
              <div>在下方输入你的批注或疑问，AI 将通读全文并在该曲别针位置给出高信息量批注回复；也可以直接点「AI」，让它自己批注，每点一次生成一条。</div>
            </div>
          {/if}

          {#each clip.messages as msg (msg.id)}
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
                  <span>Markdown</span>
                </div>
                <div class="chat-ai-html-content" data-testid="chat-ai-html">
                  {@html renderAiReply(msg.content)}
                </div>
              </div>
            {/if}
          {/each}

          {#if visibleReply}
            <AiStreamCard
              heading="🤖 AI 深度批注"
              phase={replyPhase}
              reasoning={visibleReply.reasoning}
              idleText="正在通读全文与曲别针上下文…"
              testid="chat-ai-loading"
              reasoningTestid="chat-ai-loading-reasoning"
              bind:reasoningEl={liveReasoningScrollEl}
            >
              {#snippet content()}
                <div class="chat-ai-html-content" data-testid="chat-ai-loading-reply">
                  {@html renderAiReply(visibleReply?.text ?? '')}
                </div>
              {/snippet}
            </AiStreamCard>
          {:else if isRequestingAi}
            <div class="kami-inline-note" data-testid="chat-ai-streaming-elsewhere">
              🤖 另一枚曲别针正在生成 AI 批注…（点击该曲别针可查看实时进度）
            </div>
          {/if}

          {#if replyError && replyError.clipId === clip.id && !visibleReply}
            <div
              class="chat-bubble-card kami-error-bubble"
              data-testid="chat-ai-error"
              role="alert"
            >
              <div>{replyError.message}</div>
              <div class="kami-error-hint">
                {#if clip.messages.some((m) => m.role === 'user')}
                  您的批注已保存在曲别针对话中；如需重试，请在下方重新发送。
                {:else}
                  您的批注尚未保存，可直接在下方重新发送。
                {/if}
              </div>
            </div>
          {/if}
        {/snippet}
        {#snippet footer()}
          <Composer
            bind:value={draftInput}
            bind:textarea={composerTextareaEl}
            bind:focused={composerFocused}
            placeholder="输入批注或问题（可留空让 AI 自行批注），Enter 换行，Ctrl+Enter 或点 AI 生成..."
            ariaLabel="批注内容"
            inputTestid="annotation-input"
            sendTestid="send-annotation-btn"
            sendLabel={isRequestingAi
              ? 'AI 生成中'
              : draftInput.trim()
                ? 'AI：发送批注并生成回复'
                : 'AI：自动批注（生成一条）'}
            sendClass="kami-btn-ai{isRequestingAi ? ' is-generating' : ''}"
            sendTitle={draftInput.trim()
              ? '发送批注，AI 生成一条回复（Ctrl+Enter）'
              : '输入为空：AI 自行在此处批注一条，可连续点击（Ctrl+Enter）'}
            disabled={isRequestingAi}
            sendDisabled={
              isRequestingAi ||
              mutationPending ||
              openDocumentPending ||
              uploadingFiles
            }
            onsend={handleSendAnnotation}
          >
            {#snippet sendContent()}
              <span class="ai-glyph" aria-hidden="true">AI</span>
            {/snippet}
            {#snippet tip()}
              {#if mutationPending}
                ⏳ 正在保存到云端…
              {:else if !aiConfigured}
                🤖 服务端未配置 AI
              {:else}
                单次全文 Markdown + &lt;aside&gt; 注入
              {/if}
            {/snippet}
          </Composer>
        {/snippet}
      </SideDrawer>
    {/if}
  </main>

  <!-- Progressive Long-press Ghost Paperclip 📎 -->
  {#if isLongPressing && pressGhostVisible}
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
              class="kami-btn kami-btn-primary"
              data-testid="open-file-btn"
              onclick={openMarkdownFileDialog}
              disabled={uploadingFiles || openDocumentPending || mutationPending}
              title="选择本地 Markdown 文件（可多选），自动上传到云端文档库"
            >
              📂 {uploadingFiles ? '上传中…' : '打开 Markdown 文件'}
            </button>
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
                  disabled={uploadingFiles || openDocumentPending}
                >
                  {uploadingFiles ? '上传中…' : '打开 Markdown 文件'}
                </button>
              </div>
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
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="library-row-main"
                    data-testid="cloud-document-row-body"
                    title="点击打开 · 长按下载 Markdown"
                    use:longPress={{ onLongPress: () => void downloadCloudDocument(doc) }}
                    onclick={() => {
                      if (!switchingBlocked) void openCloudDocument(doc);
                    }}
                  >
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
                {#if uploadingFiles || openDocumentPending}
                  正在上传或打开文档，完成后方可切换或删除文档。
                {:else if mutationPending}
                  正在保存到云端，完成后方可切换或删除文档。
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

  {#if toastMessage}
    <div class="kami-toast" data-testid="kami-toast">
      {toastMessage}
    </div>
  {/if}
</div>
