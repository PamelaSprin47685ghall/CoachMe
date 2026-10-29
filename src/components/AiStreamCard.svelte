<script lang="ts">
  /**
   * One flat card per in-flight generation: thinking streams in place (grey
   * text) and is replaced by the formal output as soon as answer text arrives.
   */
  import type { Snippet } from 'svelte';
  import { STREAM_PHASE_LABEL, type StreamPhase } from '../lib/stream-phase';

  interface Props {
    heading: string;
    phase: StreamPhase;
    reasoning: string;
    idleText: string;
    testid: string;
    reasoningTestid: string;
    reasoningEl?: HTMLElement;
    extraClass?: string;
    content: Snippet;
  }

  let {
    heading,
    phase,
    reasoning,
    idleText,
    testid,
    reasoningTestid,
    reasoningEl = $bindable(),
    extraClass = '',
    content
  }: Props = $props();
</script>

<div class="chat-bubble-card chat-bubble-ai {extraClass}" data-testid={testid} data-phase={phase}>
  <div class="chat-role-header">
    <span>{heading}</span>
    <span class="thinking-live-badge">{STREAM_PHASE_LABEL[phase]}</span>
  </div>
  {#if phase === 'replying'}
    {@render content()}
  {:else if phase === 'thinking'}
    <div bind:this={reasoningEl} class="chat-thinking-text" data-testid={reasoningTestid}>{reasoning}</div>
  {:else}
    <div class="chat-thinking-text">{idleText}</div>
  {/if}
</div>
