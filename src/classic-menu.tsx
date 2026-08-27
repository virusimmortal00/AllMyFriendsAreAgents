import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type ClassicMenuItem =
  | { type?: "command"; label: string; accessKey: string; shortcut?: string; disabled?: boolean; checked?: boolean; checkType?: "radio" | "checkbox"; onSelect: (returnFocusTo: HTMLButtonElement) => void }
  | { type: "separator" };

export interface ClassicMenuDefinition {
  id: string;
  label: string;
  accessKey: string;
  disabled?: boolean;
  items: ClassicMenuItem[];
}

function mnemonicLabel(label: string, accessKey: string): ReactNode {
  const index = label.toLocaleLowerCase().indexOf(accessKey.toLocaleLowerCase());
  if (index < 0) return label;
  return <>{label.slice(0, index)}<u>{label[index]}</u>{label.slice(index + 1)}</>;
}

export function ClassicMenuBar({ menus, onHelp }: { menus: ClassicMenuDefinition[]; onHelp?: () => void }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const titleRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuRefs = useRef<Array<HTMLDivElement | null>>([]);
  const focusLastRef = useRef(false);

  const enabledMenuIndex = (start: number, direction: -1 | 1 = 1) => {
    for (let offset = 0; offset < menus.length; offset += 1) {
      const index = (start + offset * direction + menus.length) % menus.length;
      if (!menus[index]?.disabled) return index;
    }
    return -1;
  };

  const focusTitle = (index: number, open = openIndex !== null, direction: -1 | 1 = 1) => {
    const next = enabledMenuIndex(index, direction);
    if (next < 0) return;
    setActiveIndex(next);
    setOpenIndex(open ? next : null);
    titleRefs.current[next]?.focus();
  };

  const openMenu = (index: number, focusLast = false, direction: -1 | 1 = 1) => {
    const next = enabledMenuIndex(index, direction);
    if (next < 0) return;
    focusLastRef.current = focusLast;
    setActiveIndex(next);
    setOpenIndex(next);
  };

  useLayoutEffect(() => {
    if (openIndex === null) return;
    const items = [...(menuRefs.current[openIndex]?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') || [])];
    items[focusLastRef.current ? items.length - 1 : 0]?.focus();
    focusLastRef.current = false;
  }, [openIndex]);

  const deactivate = (restoreContentFocus = false) => {
    setOpenIndex(null);
    setActiveIndex(null);
    if (restoreContentFocus) (document.querySelector<HTMLElement>("[data-primary-workspace]") || document.body).focus();
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) deactivate();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.key === "F1" && onHelp) {
        event.preventDefault();
        deactivate();
        onHelp();
        return;
      }
      if (event.key === "F10" || event.key === "Alt") {
        event.preventDefault();
        if (activeIndex === null) focusTitle(0, false);
        else deactivate(true);
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1) return;
      const index = menus.findIndex((menu) => !menu.disabled && menu.accessKey.toLocaleLowerCase() === event.key.toLocaleLowerCase());
      if (index < 0) return;
      event.preventDefault();
      openMenu(index);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeIndex, menus, onHelp]);

  function onTitleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      focusTitle(index + direction, openIndex !== null, direction);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu(index, event.key === "ArrowUp");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      deactivate(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>, menuIndex: number) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      openMenu(menuIndex + direction, false, direction);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpenIndex(null);
      setActiveIndex(menuIndex);
      titleRefs.current[menuIndex]?.focus();
      return;
    }
    const items = [...(menuRefs.current[menuIndex]?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') || [])];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
      : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length
      : event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : null;
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
      return;
    }
    if (event.key.length !== 1) return;
    const menu = menus[menuIndex];
    const itemIndex = menu.items.findIndex((item) => item.type !== "separator" && !item.disabled && item.accessKey.toLocaleLowerCase() === event.key.toLocaleLowerCase());
    if (itemIndex < 0) return;
    event.preventDefault();
    const item = menu.items[itemIndex];
    if (item.type !== "separator") {
      const returnFocusTo = titleRefs.current[menuIndex];
      deactivate();
      if (returnFocusTo) {
        returnFocusTo.focus();
        item.onSelect(returnFocusTo);
      }
    }
  }

  return (
    <nav ref={rootRef} className="menu-bar" aria-label="Application menu" role="menubar">
      {menus.map((menu, index) => <div className="menu-wrap" key={menu.id}>
        <button
          ref={(element) => { titleRefs.current[index] = element; }}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={openIndex === index}
          disabled={menu.disabled}
          tabIndex={activeIndex === index ? 0 : -1}
          onMouseEnter={() => { if (!menu.disabled && openIndex !== null && openIndex !== index) openMenu(index); }}
          onKeyDown={(event) => onTitleKeyDown(event, index)}
          onClick={() => openIndex === index ? deactivate() : openMenu(index)}
        >{mnemonicLabel(menu.label, menu.accessKey)}</button>
        {openIndex === index ? <div
          ref={(element) => { menuRefs.current[index] = element; }}
          className="dropdown-menu"
          role="menu"
          aria-label={menu.label}
          onKeyDown={(event) => onMenuKeyDown(event, index)}
        >{menu.items.map((item, itemIndex) => item.type === "separator"
          ? <div className="menu-separator" role="separator" key={`separator-${itemIndex}`} />
          : <Fragment key={`${item.label}-${itemIndex}`}><button
              type="button"
              role={item.checked === undefined ? "menuitem" : `menuitem${item.checkType ?? "radio"}`}
              aria-checked={item.checked === undefined ? undefined : item.checked}
              disabled={item.disabled}
              onClick={() => {
                const returnFocusTo = titleRefs.current[index];
                deactivate();
                if (returnFocusTo) {
                  returnFocusTo.focus();
                  item.onSelect(returnFocusTo);
                }
              }}
            ><span className="menu-check" aria-hidden="true">{item.checked ? "✓" : ""}</span><span>{mnemonicLabel(item.label, item.accessKey)}</span>{item.shortcut ? <span className="menu-shortcut">{item.shortcut}</span> : null}</button></Fragment>)}</div> : null}
      </div>)}
    </nav>
  );
}
