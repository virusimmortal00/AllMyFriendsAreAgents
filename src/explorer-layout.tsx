import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useScrollEdges } from "./scroll-edges";

export interface ExplorerPage<Key extends string> {
  readonly key: Key;
  readonly label: string;
  readonly icon: string;
  readonly description?: string;
  readonly locked?: boolean;
}

/**
 * Windows 95 Explorer/Control Panel composition: a fixed page list beside one
 * scrolling content pane, with a status line below. Narrow layouts move the list
 * above the content as a wrapping row; the selected page never leaves the window.
 */
export function ExplorerLayout<Key extends string>({ label, pages, selected, onSelect, status, children }: {
  label: string;
  pages: readonly ExplorerPage<Key>[];
  selected: Key;
  onSelect: (page: Key) => void;
  status?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  useScrollEdges(contentRef);
  const current = pages.find((page) => page.key === selected) ?? pages[0];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = pages.findIndex((page) => page.key === selected);
    const next = event.key === "ArrowDown" || event.key === "ArrowRight" ? (index + 1) % pages.length
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? (index - 1 + pages.length) % pages.length
        : event.key === "Home" ? 0 : event.key === "End" ? pages.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onSelect(pages[next].key);
    event.currentTarget.querySelector<HTMLButtonElement>(`#${CSS.escape(`${id}-${pages[next].key}`)}`)?.focus();
  }

  return <div className="explorer">
    <div className="explorer__pages" role="tablist" aria-label={label} aria-orientation="vertical" onKeyDown={onKeyDown}>
      {pages.map((page) => <button key={page.key} type="button" role="tab" id={`${id}-${page.key}`} aria-selected={page.key === current.key} aria-controls={`${id}-panel`} tabIndex={page.key === current.key ? 0 : -1} onClick={() => onSelect(page.key)}>
        <span className="explorer__icon" aria-hidden="true">{page.icon}</span><span>{page.label}</span>{page.locked ? <span className="explorer__lock" aria-hidden="true" title="Sign in to open">🔒</span> : null}
      </button>)}
    </div>
    <div ref={contentRef} className="explorer__content classic-scrollbars" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${current.key}`} tabIndex={-1}>
      {children}
    </div>
    <div className="explorer__status" role="status">{status ?? current.description ?? ""}</div>
  </div>;
}
