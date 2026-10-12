import type { ReactNode } from "react";
import { TONE_BADGE, type Tone } from "../../lib/tone.js";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** A Badge tinted with one of the shared status tones — for any status-like label that isn't a TaskStatus. */
export function ToneBadge({ tone, title, className, children }: { tone: Tone; title?: string; className?: string; children: ReactNode }) {
  return (
    <Badge className={cn(TONE_BADGE[tone], className)} title={title}>
      {children}
    </Badge>
  );
}
