import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

let bodyScrollLocks = 0;
let previousBodyOverflow = "";

function lockBodyScroll() {
  if (bodyScrollLocks === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLocks += 1;
  return () => {
    bodyScrollLocks = Math.max(0, bodyScrollLocks - 1);
    if (bodyScrollLocks === 0) document.body.style.overflow = previousBodyOverflow;
  };
}

function focusableElements(container: HTMLElement | null) {
  return [...(container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) || [])]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

export function useModalOverlay<T extends HTMLElement = HTMLElement>(onClose: () => void, returnFocusTo: HTMLElement | null = null, active = true) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const restoreFocusTo = returnFocusTo || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const unlockBodyScroll = lockBodyScroll();
    dialogRef.current?.focus();
    return () => {
      unlockBodyScroll();
      if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
    };
  }, [active, returnFocusTo]);

  function onDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = activeIndex < 0
      ? (event.shiftKey ? focusable.length - 1 : 0)
      : (activeIndex + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  function onBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.currentTarget === event.target) onCloseRef.current();
  }

  return { dialogRef, onDialogKeyDown, onBackdropMouseDown };
}

export function useDismissibleLayer(open: boolean, onDismiss: () => void) {
  const layerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!layerRef.current?.contains(event.target as Node)) onDismissRef.current();
    };
    const dismissFromKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismissRef.current();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissFromKeyboard);
    };
  }, [open]);

  return { layerRef: layerRef as RefObject<HTMLDivElement>, triggerRef: triggerRef as RefObject<HTMLButtonElement> };
}
