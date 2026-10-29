import type { Action } from 'svelte/action';

/** Shared gesture timing, so every long-press in the app feels the same. */
export const LONG_PRESS_DURATION_MS = 750;
/** The 📎 ghost stays hidden this long, so scrolls/drags never flash a paperclip. */
export const LONG_PRESS_GHOST_DELAY_MS = 280;
export const MOVE_CANCEL_THRESHOLD_PX = 10;

export interface LongPressOptions {
  /** Fired once the pointer has been held still for `duration` ms. */
  onLongPress: () => void;
  duration?: number;
  disabled?: boolean;
}

/**
 * Long-press gesture for an element whose plain click keeps its own meaning.
 * When the press completes, the click synthesised on release is swallowed so
 * the element's `onclick` never fires for the same gesture.
 */
export const longPress: Action<HTMLElement, LongPressOptions> = (node, initial) => {
  let options = initial;
  let timer: number | null = null;
  let originX = 0;
  let originY = 0;
  let swallowClick = false;

  const cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (options.disabled || event.button !== 0) return;
    cancel();
    swallowClick = false;
    originX = event.clientX;
    originY = event.clientY;
    timer = window.setTimeout(() => {
      timer = null;
      swallowClick = true;
      options.onLongPress();
    }, options.duration ?? LONG_PRESS_DURATION_MS);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (timer === null) return;
    if (Math.hypot(event.clientX - originX, event.clientY - originY) > MOVE_CANCEL_THRESHOLD_PX) cancel();
  };

  const onClick = (event: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  // Touch browsers open a context menu on long-press; the gesture owns it here.
  const onContextMenu = (event: Event) => event.preventDefault();

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', onClick, true);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(next) {
      options = next;
      if (next.disabled) cancel();
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointerleave', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('click', onClick, true);
      node.removeEventListener('contextmenu', onContextMenu);
    }
  };
};
