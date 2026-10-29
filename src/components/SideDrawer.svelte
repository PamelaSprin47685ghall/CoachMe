<script lang="ts">
  /**
   * One sidebar implementation for both edges of the workspace.
   * Desktop: an in-flow flex column that takes space and reflows the reader.
   * Mobile (≤640px): a fixed overlay drawer with a tap-to-close backdrop,
   * sized to the visible viewport above the soft keyboard.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    side: 'left' | 'right';
    testid: string;
    backdropTestid: string;
    closeTestid: string;
    closeLabel: string;
    closeTitle?: string;
    /** Compact chrome while the composer has focus (soft keyboard open). */
    compact?: boolean;
    style?: string;
    bodyTestid?: string;
    bodyEl?: HTMLElement;
    onclose: () => void;
    title: Snippet;
    actions?: Snippet;
    subheader?: Snippet;
    body: Snippet;
    footer?: Snippet;
  }

  let {
    side,
    testid,
    backdropTestid,
    closeTestid,
    closeLabel,
    closeTitle,
    compact = false,
    style,
    bodyTestid,
    bodyEl = $bindable(),
    onclose,
    title,
    actions,
    subheader,
    body,
    footer
  }: Props = $props();
</script>

<button
  type="button"
  class="mobile-annotation-backdrop"
  data-testid={backdropTestid}
  aria-label={closeLabel}
  onclick={onclose}
></button>
<aside
  class="kami-side-drawer kami-side-drawer--{side}"
  class:composer-active={compact}
  data-testid={testid}
  {style}
>
  <div class="drawer-header">
    <div class="drawer-header-top">
      <div class="drawer-clip-badge">{@render title()}</div>
      <div class="drawer-header-actions">
        {#if actions}{@render actions()}{/if}
        <button
          type="button"
          class="kami-btn"
          data-testid={closeTestid}
          aria-label={closeLabel}
          title={closeTitle ?? closeLabel}
          onclick={onclose}
        >
          ✕
        </button>
      </div>
    </div>
    {#if subheader}{@render subheader()}{/if}
  </div>

  <div bind:this={bodyEl} class="drawer-messages" data-testid={bodyTestid}>
    {@render body()}
  </div>

  {#if footer}{@render footer()}{/if}
</aside>
