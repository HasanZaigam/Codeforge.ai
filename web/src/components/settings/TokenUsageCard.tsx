import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CoinsIcon } from "lucide-react";
import { modelGatewayApi, type AccountTokenUsageDTO } from "../../api/index.js";
import { Section } from "../common/Section.js";
import { TokenBudgetForm, TokenMeter } from "../common/TokenMeter.js";
import { formatTokens } from "../../lib/tokens.js";

/** Settings → Token usage: this month's usage across every project, the account budget, and where it went. */
export function TokenUsageCard() {
  const [usage, setUsage] = useState<AccountTokenUsageDTO>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.resolve()
      .then(() => modelGatewayApi.getTokenUsage())
      .then(setUsage)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load token usage."));
  }, []);

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <CoinsIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Token usage
        </span>
      }
      description="AI tokens used this month across all your projects — tasks, issue analysis and Chat."
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!usage && !error && <p className="text-sm text-muted-foreground">Loading token usage…</p>}
      {usage && (
        <div className="flex flex-col gap-5">
          <TokenMeter meter={usage} label="Account token usage" />
          {usage.projects.length > 0 && (
            <ul className="divide-y rounded-2xl border text-sm">
              {usage.projects.map((p) => (
                <li key={p.projectId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <Link to={`/projects/${p.projectId}`} className="min-w-0 truncate font-medium hover:text-primary hover:underline">
                    {p.name}
                  </Link>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {formatTokens(p.used)}
                    {p.budget !== null && ` / ${formatTokens(p.budget)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <TokenBudgetForm
            id="account-token-budget"
            budget={usage.budget}
            onSave={async (monthlyTokens) => setUsage(await modelGatewayApi.setTokenBudget(monthlyTokens))}
          />
        </div>
      )}
    </Section>
  );
}
