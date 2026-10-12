import { useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { backlogApi, type BacklogItemDTO } from "../../api/index.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** Client-side limits mirror CreateBacklogItemSchema (src/api/schemas.ts) for instant feedback; the server re-validates. */
export const TITLE_MAX = 300;
export const DESCRIPTION_MAX = 10_000;
export const REF_MAX = 64;

export function CreateBacklogItemDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (item: BacklogItemDTO) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const canSubmit = title.trim().length > 0 && description.trim().length > 0 && !submitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const ref = externalRef.trim();
      const item = await backlogApi.create(projectId, {
        title: title.trim(),
        description: description.trim(),
        ...(ref ? { externalRef: ref } : {}),
      });
      onCreated(item);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the backlog item. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title="New backlog item"
      description="Backlog items are things CodeForge should understand — creating one does not create or run a task."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="backlog-title">
            Title <span className="text-destructive">*</span>
          </Label>
          <Input id="backlog-title" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="backlog-description">
            Description <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="backlog-description"
            rows={6}
            value={description}
            maxLength={DESCRIPTION_MAX}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="backlog-ref">Reference (optional)</Label>
          <Input id="backlog-ref" value={externalRef} maxLength={REF_MAX} placeholder="e.g. BUG-002" onChange={(e) => setExternalRef(e.target.value)} />
          <span className="text-sm text-muted-foreground">Your own identifier — must be unique within this project.</span>
        </div>
        {error && <ErrorState message={error} />}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create backlog item"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
