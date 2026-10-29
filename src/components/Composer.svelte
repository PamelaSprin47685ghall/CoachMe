<script lang="ts">
  /**
   * Shared bottom composer: Enter inserts a newline; Ctrl+Enter / Cmd+Enter or
   * the button sends. The button never steals focus, so tapping it on a phone
   * keeps the soft keyboard (and therefore the layout) stable until it sends.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    value?: string;
    textarea?: HTMLTextAreaElement;
    focused?: boolean;
    placeholder: string;
    ariaLabel: string;
    inputTestid: string;
    sendTestid: string;
    sendLabel: string;
    /** Optional custom button face (e.g. the artistic 「AI」 glyph); `sendLabel` stays the accessible name. */
    sendContent?: Snippet;
    sendClass?: string;
    sendTitle?: string;
    disabled?: boolean;
    sendDisabled?: boolean;
    tip?: Snippet;
    onsend: () => void;
  }

  let {
    value = $bindable(''),
    textarea = $bindable(),
    focused = $bindable(false),
    placeholder,
    ariaLabel,
    inputTestid,
    sendTestid,
    sendLabel,
    sendContent,
    sendClass = 'kami-btn-primary',
    sendTitle,
    disabled = false,
    sendDisabled = false,
    tip,
    onsend
  }: Props = $props();

  function handleKeydown(event: KeyboardEvent) {
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      onsend();
    }
  }
</script>

<div class="drawer-composer">
  <textarea
    bind:this={textarea}
    class="composer-textarea"
    data-testid={inputTestid}
    aria-label={ariaLabel}
    {placeholder}
    bind:value
    {disabled}
    onkeydown={handleKeydown}
    onfocus={() => (focused = true)}
    onblur={() => (focused = false)}
  ></textarea>
  <div class="composer-footer">
    <span class="composer-tip">{#if tip}{@render tip()}{/if}</span>
    <button
      type="button"
      class="kami-btn {sendClass}"
      data-testid={sendTestid}
      disabled={sendDisabled}
      aria-label={sendContent ? sendLabel : undefined}
      title={sendTitle}
      onmousedown={(event) => event.preventDefault()}
      onclick={onsend}
    >
      {#if sendContent}{@render sendContent()}{:else}{sendLabel}{/if}
    </button>
  </div>
</div>
