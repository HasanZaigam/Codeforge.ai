import { useState, type FormEvent } from "react";
import type { HumanInputRequestDTO, TaskDTO } from "../../api/index.js";
import { ErrorState } from "../common/ErrorState.js";
import { Button } from "@/components/ui/button";
import { MessageCircleQuestionIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * The most important UX state in the product (Step 4 instructions §12): why
 * the task stopped, what was tried, what's blocking it, and a clear
 * question with recommended options. Submitting only calls POST
 * /tasks/:id/input — the frontend never sets status itself; the Orchestrator
 * decides what happens next (see /docs/TASK_LIFECYCLE.md).
 */
export function NeedsInputPanel({
  input,
  onSubmit,
  submitting,
}: {
  input: HumanInputRequestDTO;
  onSubmit: (answer: { selectedOption: string | null; freeText: string }) => Promise<TaskDTO>;
  submitting: boolean;
}) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);

  // "No change was needed" is the one recommended option that's a complete answer on its own —
  // the other options (e.g. "Clarify the task") need the developer to actually say what to
  // clarify, so free text stays required for those. See NeedsInputPanel's UX brief.
  const isNoChangeNeeded = selectedOption === "No change was needed";
  const canSubmit = isNoChangeNeeded || freeText.trim().length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      // The backend requires non-empty freeText (see api/schemas.ts) — when the developer leaves
      // it blank for "No change was needed," fall back to the option's own label as the decision
      // text rather than relaxing that contract.
      const trimmed = freeText.trim();
      const effectiveFreeText = trimmed || (isNoChangeNeeded ? selectedOption! : trimmed);
      await onSubmit({ selectedOption, freeText: effectiveFreeText });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit your answer. Please try again.");
    }
  }

  if (submitted) {
    return (
      <div className="flex items-center gap-3 rounded-4xl border border-tone-success/30 bg-tone-success/5 p-6">
        <Spinner className="size-5 text-tone-success" />
        <div>
          <h2 className="text-base font-semibold">Thanks — continuing</h2>
          <p className="text-sm text-muted-foreground">The AI developer is resuming with your answer.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-4xl border border-tone-attention/40 bg-card ring-4 ring-tone-attention/10">
      <div className="flex items-center gap-3 border-b border-tone-attention/30 bg-tone-attention/10 px-6 py-4">
        <MessageCircleQuestionIcon className="size-5 text-tone-attention" aria-hidden="true" />
        <h2 className="text-base font-semibold">Your decision is required</h2>
      </div>

      <div className="grid gap-6 p-6 lg:grid-cols-2">
        <div className="space-y-4 text-sm">
          <div className="space-y-1">
            <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What was found</h4>
            <p>{input.discovered}</p>
          </div>

          {input.attempted.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What was tried</h4>
              <ul className="list-disc space-y-1 pl-5">
                {input.attempted.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1">
            <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What's blocking progress</h4>
            <p>{input.blocker}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Question</h4>
            <p className="font-semibold">{input.question}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {input.options.length > 0 && (
              <div className="space-y-2" role="radiogroup" aria-label="Recommended options">
                {input.options.map((option) => (
                  <label
                    key={option.label}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-2xl border p-3 text-sm transition-colors hover:bg-muted/50",
                      selectedOption === option.label && "border-primary bg-primary/5 ring-1 ring-primary",
                    )}
                  >
                    <input
                      type="radio"
                      name="option"
                      value={option.label}
                      checked={selectedOption === option.label}
                      onChange={() => setSelectedOption(option.label)}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span>
                      <span className="font-medium">{option.label}</span>
                      <br />
                      <span className="text-muted-foreground">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="answer-text">
                Your decision {isNoChangeNeeded && <span className="font-normal text-muted-foreground">(optional)</span>}
              </Label>
              <Textarea
                id="answer-text"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="Explain your decision, or add anything the options above don't cover…"
                rows={3}
                required={!isNoChangeNeeded}
                maxLength={10000}
              />
            </div>

            {error && <ErrorState message={error} />}

            <Button type="submit" size="lg" className="w-full" disabled={submitting || !canSubmit}>
              {submitting ? "Submitting…" : "Continue"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
