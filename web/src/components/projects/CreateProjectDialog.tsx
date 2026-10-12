import { useState, type FormEvent } from "react";
import { CheckIcon, FolderGit2Icon, GitForkIcon, type LucideIcon } from "lucide-react";
import { Dialog, DialogActions } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { projectsApi, type ProjectDTO } from "../../api/index.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * How the user means to set the project up. It only shapes the next few screens (one repository →
 * connect it and go to the Overview; several → keep offering "Connect another"); nothing is stored,
 * and a "one repository" project can still get more repositories later.
 */
export type RepositorySetup = "single" | "multiple";

const SETUP_OPTIONS: Array<{ value: RepositorySetup; title: string; description: string; icon: LucideIcon }> = [
  { value: "single", title: "One repository", description: "A monorepo — connect it once.", icon: FolderGit2Icon },
  { value: "multiple", title: "Several repositories", description: "Frontend, backend, admin… — connect each one.", icon: GitForkIcon },
];

/**
 * Creates an empty project — just a name. Repositories are connected next, in Project Settings →
 * Repositories: one for a monorepo, or several (frontend, backend, admin …) for a codebase split across
 * repositories. Every task then targets exactly one of them (TD-62).
 */
export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: ProjectDTO, setup: RepositorySetup) => void;
}) {
  const [name, setName] = useState("");
  const [setup, setSetup] = useState<RepositorySetup>("single");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      onCreated(await projectsApi.create({ name: name.trim() }), setup);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create this project. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="Create a project" description="Name it first — you'll connect its repositories next." onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-project-name">Project name</Label>
          <Input
            id="new-project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="OTT Platform"
            required
            maxLength={200}
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-2">
          <span id="repository-setup-label" className="text-sm font-medium">
            How is the code organised?
          </span>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="repository-setup-label">
            {SETUP_OPTIONS.map(({ value, title, description, icon: Icon }) => {
              const selected = setup === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setSetup(value)}
                  onKeyDown={(e) => {
                    // Standard radio-group keys: any arrow moves to the other option.
                    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                      e.preventDefault();
                      const next = value === "single" ? "multiple" : "single";
                      setSetup(next);
                      (e.currentTarget.parentElement?.querySelector(`[data-setup="${next}"]`) as HTMLElement | null)?.focus();
                    }
                  }}
                  data-setup={value}
                  className={cn(
                    "relative flex gap-3 rounded-2xl border p-3 text-left text-sm transition-colors outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    selected && "border-primary bg-primary/5 ring-1 ring-primary hover:bg-primary/5",
                  )}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="pr-5">
                    <span className="font-medium">{title}</span>
                    <span className="block text-muted-foreground">{description}</span>
                  </span>
                  {selected && (
                    <span className="absolute top-3 right-3 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <CheckIcon className="size-3" aria-hidden="true" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">You can always connect more repositories later in Settings.</p>
        </div>

        {error && <ErrorState message={error} />}
        <DialogActions>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !name.trim()}>
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
