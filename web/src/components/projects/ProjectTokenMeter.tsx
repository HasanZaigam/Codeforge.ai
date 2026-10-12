import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { projectsApi, type ProjectTokenUsageDTO } from "../../api/index.js";
import { TokenMeter } from "../common/TokenMeter.js";
import { formatTokens } from "../../lib/tokens.js";

/** The project's token meter for this month, shown at the top of the Overview. `refreshKey` re-reads it (e.g. after a Chat reply). */
export function ProjectTokenMeter({ projectId, refreshKey = 0 }: { projectId: string; refreshKey?: number }) {
  const [usage, setUsage] = useState<ProjectTokenUsageDTO>();
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    // Advisory widget: any failure — even a synchronous one — just hides it, never the Overview.
    Promise.resolve()
      .then(() => projectsApi.getTokenUsage(projectId))
      .then((u) => {
        setUsage(u);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [projectId]);

  useEffect(load, [load, refreshKey]);

  if (failed && !usage) return null; // advisory — never block the Overview on it
  if (!usage) return <div className="h-[92px] animate-pulse rounded-3xl bg-muted/60" aria-hidden="true" />;

  const { tasks, analyses, chat } = usage.breakdown;
  return (
    <section className="rounded-3xl bg-card p-5 ring-1 ring-foreground/10" aria-label="Token usage">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Token usage this month</h3>
        <Link to={`/projects/${projectId}/settings#token-budget`} className="text-xs font-medium text-primary hover:underline">
          {usage.budget === null ? "Set a budget" : "Change budget"}
        </Link>
      </div>
      <TokenMeter meter={usage} label="Project token usage" compact />
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1">
          <dt>Tasks</dt>
          <dd className="font-medium text-foreground tabular-nums">{formatTokens(tasks.tokens)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>Issue analysis</dt>
          <dd className="font-medium text-foreground tabular-nums">{formatTokens(analyses.tokens)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>Chat</dt>
          <dd className="font-medium text-foreground tabular-nums">{formatTokens(chat.tokens)}</dd>
        </div>
      </dl>
    </section>
  );
}
