import { useState, type FormEvent } from "react";
import { GaugeIcon } from "lucide-react";
import type { TokenMeterDTO } from "../../api/index.js";
import { formatTokens } from "../../lib/tokens.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

function monthLabel(periodStart: string): string {
  return new Date(periodStart).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * This month's token usage against an optional budget (TD-63). Budgets only inform: at 75% the bar turns
 * amber, at 100% red with an "over budget" note — nothing is ever blocked. Estimated and unreported usage
 * are called out so the number is never presented as more precise than it is.
 */
export function TokenMeter({ meter, label, compact = false }: { meter: TokenMeterDTO; label: string; compact?: boolean }) {
  const percent = meter.percentUsed;
  const tone = percent === null ? "neutral" : percent >= 100 ? "danger" : percent >= 75 ? "attention" : "ok";

  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-2">
          <GaugeIcon className="size-4 translate-y-0.5 text-muted-foreground" aria-hidden="true" />
          <span className={cn("font-heading font-semibold tabular-nums", compact ? "text-lg" : "text-2xl")}>{formatTokens(meter.used)}</span>
          <span className="text-sm text-muted-foreground">
            {meter.budget !== null ? `of ${formatTokens(meter.budget)} tokens` : "tokens"} · {monthLabel(meter.periodStart)}
          </span>
        </div>
        {meter.remaining !== null && (
          <span className={cn("text-sm font-medium tabular-nums", tone === "danger" ? "text-tone-danger" : tone === "attention" ? "text-tone-attention" : "text-muted-foreground")}>
            {tone === "danger" ? "Over budget" : `${formatTokens(meter.remaining)} left`}
          </span>
        )}
      </div>

      {meter.budget !== null ? (
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${label}: ${percent ?? 0}% of budget used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, percent ?? 0)}
        >
          <div
            className={cn("h-full rounded-full transition-[width]", tone === "danger" ? "bg-tone-danger" : tone === "attention" ? "bg-tone-attention" : "bg-primary")}
            // Any usage at all stays visible as a sliver, even when it rounds to 0%.
            style={{ width: `${meter.used > 0 ? Math.max(1, Math.min(100, percent ?? 0)) : 0}%` }}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No monthly budget set — usage is tracked, but there's nothing to count down from.</p>
      )}

      {(meter.estimatedTokens > 0 || meter.unreportedOperations > 0) && (
        <p className="text-xs text-muted-foreground">
          {meter.estimatedTokens > 0 && <>~{formatTokens(meter.estimatedTokens)} of this is estimated (≈4 characters per token). </>}
          {meter.unreportedOperations > 0 && (
            <>
              {meter.unreportedOperations} AI run{meter.unreportedOperations === 1 ? "" : "s"} reported no usage, so the real total is somewhat higher.
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** Sets or removes a monthly token budget. Display only: reaching it warns, it never blocks work. */
export function TokenBudgetForm({
  id,
  budget,
  onSave,
}: {
  id: string;
  budget: number | null;
  onSave: (monthlyTokens: number | null) => Promise<void>;
}) {
  const [value, setValue] = useState(budget === null ? "" : String(budget));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const parsed = value.trim() === "" ? null : Number(value.replace(/[,_\s]/g, ""));
  const invalid = parsed !== null && (!Number.isInteger(parsed) || parsed <= 0);
  const unchanged = parsed === budget;

  async function save(next: number | null) {
    setSaving(true);
    setError(undefined);
    try {
      await onSave(next);
      setValue(next === null ? "" : String(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the budget.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!invalid) void save(parsed);
      }}
    >
      <Label htmlFor={id}>Monthly token budget</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          inputMode="numeric"
          className="sm:max-w-56"
          placeholder="e.g. 2000000"
          value={value}
          aria-invalid={invalid}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={saving || invalid || unchanged || parsed === null}>
            {saving ? "Saving…" : "Save budget"}
          </Button>
          {budget !== null && (
            <Button type="button" variant="ghost" disabled={saving} onClick={() => void save(null)}>
              Remove budget
            </Button>
          )}
        </div>
      </div>
      <p className={cn("text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>
        {invalid
          ? "Enter a whole number of tokens, like 2000000."
          : "Resets on the 1st of every month (UTC). Reaching it only shows a warning — CodeForge never stops work because of it."}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
