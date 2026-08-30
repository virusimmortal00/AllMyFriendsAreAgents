import { useId, type ReactNode } from "react";
import { useModalOverlay } from "./overlay";
import { viewAttributes, type ViewDefinition } from "./view-registry";

export function DialogFrame({
  title,
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
  view,
  children,
  actions,
  onClose,
}: {
  title: string;
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
  view?: ViewDefinition;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(onClose, returnFocusTo);

  return <div className={`modal-backdrop dialog-backdrop ${backdropClassName}`.trim()} onMouseDown={onBackdropMouseDown}>
    <section
      ref={dialogRef}
      className={`dialog-window agent-settings-window ${className}`.trim()}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={ariaDescribedBy}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      data-responsive-layout={dataResponsiveLayout}
      data-presentation={dataPresentation}
      {...(view ? viewAttributes(view) : {})}
    >
      <header className="dialog-titlebar agent-settings-titlebar">
        <h2 id={titleId}>{title}</h2>
        {closeLabel === null ? null : <button type="button" aria-label={closeLabel || `Close ${title}`} disabled={closeDisabled} onClick={onClose}>×</button>}
      </header>
      <div className={`dialog-body ${bodyClassName}`.trim()}>{children}</div>
      {actions === undefined ? null : <footer className={`dialog-actions agent-settings-actions ${actionsClassName}`.trim()}>{actions}</footer>}
    </section>
  </div>;
}
