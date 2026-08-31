import type { TaskStatus } from "../../api/index.js";
import { STATUS_META } from "../../lib/statusMeta.js";

export function StatusBadge({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  return <span className={`status-badge tone-${meta.tone}`}>{meta.label}</span>;
}
