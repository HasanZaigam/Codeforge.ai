import type { ReactNode } from "react";

/** Minimal modal shell shared by CreateProjectDialog and CreateTaskDialog — no dialog library needed for two forms. */
export function Dialog({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  /** Optional one-line explanation shown under the title — for a form whose purpose isn't obvious from the title alone. */
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>{title}</h2>
          <button className="btn btn-secondary" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {description && <p className="dialog-description">{description}</p>}
        {children}
      </div>
    </div>
  );
}
