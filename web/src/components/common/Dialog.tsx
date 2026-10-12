import type { ReactNode } from "react";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The app's modal shell — callers mount it to open and unmount it to close (`onClose`), so it
 * stays a controlled, always-open shadcn Dialog rather than owning its own trigger/open state.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  size = "md",
}: {
  title: string;
  /** Optional one-line explanation shown under the title — for a form whose purpose isn't obvious from the title alone. */
  description?: string;
  onClose: () => void;
  children: ReactNode;
  size?: "md" | "lg";
}) {
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", size === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg")}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </DialogRoot>
  );
}

/** Right-aligned action row at the bottom of a dialog form. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">{children}</div>;
}
