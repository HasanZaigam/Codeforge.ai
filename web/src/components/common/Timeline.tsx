import { formatAbsolute, formatRelative } from "../../lib/time.js";
import { cn } from "@/lib/utils";

export interface TimelineEntry {
  id: string;
  label: string;
  detail: string | null;
  createdAt: string;
}

/** A vertical event timeline, oldest first, with the latest entry highlighted. */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const lastIndex = entries.length - 1;
  return (
    <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-border">
      {entries.map((entry, i) => {
        const latest = i === lastIndex;
        return (
          <li className="relative flex gap-3" key={entry.id}>
            <span
              className={cn(
                "relative z-10 mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-background",
                latest ? "bg-primary ring-4 ring-primary/15" : "bg-muted-foreground/40",
              )}
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-col gap-0.5 text-sm">
              <span className={cn("font-medium", !latest && "text-foreground/80")}>{entry.label}</span>
              {entry.detail && <span className="text-xs break-words text-muted-foreground">{entry.detail}</span>}
              <span className="text-xs text-muted-foreground/80" title={formatAbsolute(entry.createdAt)}>
                {formatRelative(entry.createdAt)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
