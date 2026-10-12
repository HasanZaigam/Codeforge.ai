import { useEffect, useState } from "react";
import { projectsApi, type ProjectTokenUsageDTO } from "../../api/index.js";
import { Section } from "../common/Section.js";
import { TokenBudgetForm, TokenMeter } from "../common/TokenMeter.js";
import { formatTokens } from "../../lib/tokens.js";

/** Project Settings → Token budget: this month's usage by kind of operation, and the project's optional monthly budget. */
export function ProjectTokenBudgetSection({ projectId }: { projectId: string }) {
  const [usage, setUsage] = useState<ProjectTokenUsageDTO>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.resolve()
      .then(() => projectsApi.getTokenUsage(projectId))
      .then(setUsage)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load token usage."));
  }, [projectId]);

  return (
    <div id="token-budget" className="scroll-mt-6">
      <Section title="Token budget" description="How many AI tokens this project used this month, and an optional monthly budget to count down from.">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!usage && !error && <p className="text-sm text-muted-foreground">Loading token usage…</p>}
        {usage && (
          <div className="flex flex-col gap-5">
            <TokenMeter meter={usage} label="Project token usage" />
            <dl className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  ["Tasks", usage.breakdown.tasks, "AI run", "AI runs"],
                  ["Issue analysis", usage.breakdown.analyses, "analysis", "analyses"],
                  ["Chat", usage.breakdown.chat, "AI reply", "AI replies"],
                ] as const
              ).map(([label, bucket, one, many]) => (
                <div key={label} className="rounded-2xl bg-muted/60 px-4 py-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="font-semibold tabular-nums">{formatTokens(bucket.tokens)}</dd>
                  <dd className="text-xs text-muted-foreground">
                    {bucket.operations} {bucket.operations === 1 ? one : many}
                    {bucket.estimatedTokens > 0 ? ` · ~${formatTokens(bucket.estimatedTokens)} est.` : ""}
                  </dd>
                </div>
              ))}
            </dl>
            <TokenBudgetForm
              id="project-token-budget"
              budget={usage.budget}
              onSave={async (monthlyTokens) => setUsage(await projectsApi.setTokenBudget(projectId, monthlyTokens))}
            />
          </div>
        )}
      </Section>
    </div>
  );
}
