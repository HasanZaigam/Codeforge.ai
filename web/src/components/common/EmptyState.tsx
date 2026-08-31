import type { ReactNode } from "react";

export function EmptyState({ icon, message, action }: { icon?: string; message: string; action?: ReactNode }) {
  return (
    <div className="state-block">
      {icon && <div className="icon">{icon}</div>}
      <p>{message}</p>
      {action}
    </div>
  );
}
