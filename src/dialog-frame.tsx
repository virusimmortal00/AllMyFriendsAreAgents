import { useId, useRef, type ReactNode } from "react";
import { useScrollEdges } from "./scroll-edges";
import { useModalOverlay } from "./overlay";
import { viewAttributes, type ViewDefinition } from "./view-registry";

export function DialogFrame({
  title,
  active = true,
  closeLabel,
  closeDisabled = false,
  returnFocusTo = null,
  role = "dialog",
  ariaDescribedBy,
  className = "",
  backdropClassName = "",
  bodyClassName = "",
  actionsClassName = "",
  dataResponsiveLayout,
  dataPresentation,
  layout = "content",
  view,
  children,
  actions,
  onClose,
}: {
  title: string;
  active?: boolean;
  closeLabel?: string | null;
  closeDisabled?: boolean;
  returnFocusTo?: HTMLElement | null;
  role?: "dialog" | "alertdialog";
  ariaDescribedBy?: string;
  className?: string;
  backdropClassName?: string;
  bodyClassName?: string;
  actionsClassName?: string;
  dataResponsiveLayout?: string;
  dataPresentation?: string;
  layout?: "content" | "property-sheet";
  view?: ViewDefinition;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const resumeFocus = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useScrollEdges(bodyRef);
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(onClose, returnFocusTo, active, resumeFocus);

  return <div hidden={!active} className={`modal-backdrop dialog-backdrop ${backdropClassName}`.trim()} onMouseDown={onBackdropMouseDown}>
    <section
      ref={dialogRef}
      className={`dialog-window agent-settings-window ${layout === "property-sheet" ? "dialog-window--property-sheet " : ""}${className}`.trim()}
      role={role}
      aria-modal={active ? true : undefined}
      aria-labelledby={titleId}
      aria-describedby={ariaDescribedBy}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      onFocusCapture={(event) => { resumeFocus.current = event.target as HTMLElement; }}
      data-responsive-layout={dataResponsiveLayout}
      data-presentation={dataPresentation}
      {...(view ? viewAttributes(view) : {})}
    >
      <header className="dialog-titlebar agent-settings-titlebar">
        <h2 id={titleId}>{title}</h2>
        {closeLabel === null ? null : <button type="button" aria-label={closeLabel || `Close ${title}`} disabled={closeDisabled} onClick={onClose}>×</button>}
      </header>
      <div ref={bodyRef} className={`dialog-body ${bodyClassName}`.trim()}>{children}</div>
      {actions === undefined ? null : <footer className={`dialog-actions agent-settings-actions ${actionsClassName}`.trim()}>{actions}</footer>}
    </section>
  </div>;
}
