import type { ReactNode } from "react";
import { CircleAlertIcon, CircleCheckIcon, CircleSlashIcon, CircleXIcon, InfoIcon, type LucideIcon } from "lucide-react";
import type { Tone } from "../../lib/tone.js";
import { cn } from "@/lib/utils";

const TONE_SURFACE: Record<Tone, string> = {
  neutral: "border-tone-neutral/25 bg-tone-neutral/5",
  active: "border-tone-active/25 bg-tone-active/5",
  attention: "border-tone-attention/30 bg-tone-attention/8",
  info: "border-tone-info/25 bg-tone-info/5",
  success: "border-tone-success/25 bg-tone-success/5",
  danger: "border-tone-danger/25 bg-tone-danger/5",
  cancelled: "border-tone-cancelled/25 bg-tone-cancelled/5",
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-tone-neutral",
  active: "text-tone-active",
  attention: "text-tone-attention",
  info: "text-tone-info",
  success: "text-tone-success",
  danger: "text-tone-danger",
  cancelled: "text-tone-cancelled",
};

const TONE_ICON: Record<Tone, LucideIcon> = {
  neutral: InfoIcon,
  active: InfoIcon,
  attention: CircleAlertIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  danger: CircleXIcon,
  cancelled: CircleSlashIcon,
};

/** A tone-tinted, titled block for an outcome or warning that should stand out from ordinary content. */
export function Callout({
  tone,
  title,
  children,
  className,
}: {
  tone: Tone;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={cn("flex gap-3 rounded-3xl border p-4", TONE_SURFACE[tone], className)}>
      <Icon className={cn("mt-0.5 size-5 shrink-0", TONE_TEXT[tone])} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <h2 className={cn("text-base font-semibold", TONE_TEXT[tone])}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
