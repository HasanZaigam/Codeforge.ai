import type { TaskStatus } from "../../api/index.js";
import { STATUS_META } from "../../lib/statusMeta.js";
import { TONE_BADGE } from "../../lib/tone.js";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const meta = STATUS_META[status];
  return <Badge className={cn(TONE_BADGE[meta.tone], className)}>{meta.label}</Badge>;
}
