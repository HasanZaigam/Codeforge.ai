import { Link, useOutletContext } from "react-router-dom";
import type { ProjectOutletContext } from "./ProjectLayout.js";
import { AdjudicationPanel } from "../components/backlog/AdjudicationPanel.js";
import { ChevronLeftIcon } from "lucide-react";

/**
 * Internal-only route (not in primary project navigation, linked from Settings → Advanced). Holds the
 * Phase 4B.1+ human ground-truth adjudication tooling (sampling, baselines, CSV import/export) that used
 * to live on the Issues & Requests page itself — that page is for the normal engineering workflow, this
 * one is for validating CodeForge's own analysis quality. Nothing here changes backlog/task state.
 */
export function ProjectEvaluationPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  return (
    <div>
      <Link to={`/projects/${project.id}/settings`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeftIcon className="size-4" />
        Back to settings
      </Link>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Evaluation</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Internal ground-truth review and baseline measurement for CodeForge's own duplicate detection, clarification, and
            proposal-readiness analysis. For development/QA use — not part of the normal Issues &amp; Requests workflow.
          </p>
        </div>
      </div>
      <AdjudicationPanel projectId={project.id} />
    </div>
  );
}
