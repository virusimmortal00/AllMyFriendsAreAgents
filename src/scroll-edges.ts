import { useLayoutEffect, type RefObject } from "react";

/** Decorate actual native scroll owners; no extra DOM, input handling, or scroll state in React. */
export function useScrollEdges(targetRef: RefObject<HTMLElement | null>, contentKey?: string | boolean | null) {
  useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let regions: HTMLElement[] = [];
    const clear = (region: HTMLElement) => {
      delete region.dataset.scrollEdges;
      delete region.dataset.overlayScroll;
    };
    const update = () => {
      for (const region of regions) {
        const visible = region.getClientRects().length && region.clientHeight > 0;
        const above = visible && region.scrollTop > 1;
        const below = visible && region.scrollHeight - region.clientHeight - region.scrollTop > 1;
        const style = getComputedStyle(region);
        const gutter = region.offsetWidth - region.clientWidth - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0);
        region.dataset.scrollEdges = above && below ? "both" : above ? "above" : below ? "below" : "none";
        region.dataset.overlayScroll = String(gutter < 10);
      }
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const discover = () => {
      const next = [target, ...target.querySelectorAll<HTMLElement>("*")].filter((region) => !/^(INPUT|TEXTAREA|SELECT)$/.test(region.tagName) && /auto|scroll/.test(getComputedStyle(region).overflowY));
      for (const region of regions) if (!next.includes(region)) clear(region);
      regions = next;
      resize?.disconnect();
      resize?.observe(target);
      for (const region of regions) {
        resize?.observe(region);
        for (const child of region.children) resize?.observe(child);
      }
      update();
    };
    const mutation = new MutationObserver(discover);
    mutation.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"] });
    target.addEventListener("scroll", update, { capture: true, passive: true });
    discover();
    return () => {
      mutation.disconnect();
      resize?.disconnect();
      target.removeEventListener("scroll", update, { capture: true });
      for (const region of regions) clear(region);
    };
  }, [targetRef, contentKey]);
}
