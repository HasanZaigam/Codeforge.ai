import { useEffect, useState } from "react";
import { modelGatewayApi } from "../../api/index.js";
import type { AiProviderId, GlobalAiConfigDTO, ProviderConnectionDTO, ProviderUsageTotalsDTO } from "../../api/types.js";
import { ConnectProviderDialog } from "./ConnectProviderDialog.js";
import { ManageProviderDialog } from "./ManageProviderDialog.js";
import { LoadingState } from "../common/LoadingState.js";
import { ErrorState } from "../common/ErrorState.js";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Section } from "../common/Section.js";
import { BrainCircuitIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const PROVIDER_LABEL: Record<AiProviderId, string> = { google: "Google", anthropic: "Anthropic", openai: "OpenAI" };
const ALL_PROVIDERS: AiProviderId[] = ["google", "anthropic", "openai"];

function formatTokens(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/**
 * Settings -> AI / Models — the Model Gateway UI (see /docs/MODEL_GATEWAY.md). Deliberately simple
 * per this feature's own brief: a Global AI Brain selector (Auto/Fixed), a connected-providers list
 * with per-provider Connect/Test/Disconnect, Auto's allowed-provider checkboxes, and a usage summary
 * — no routing-rule DSL, no model marketplace, no cost optimizer.
 */
export function AiModelsCard() {
  const [connections, setConnections] = useState<ProviderConnectionDTO[]>();
  const [config, setConfig] = useState<GlobalAiConfigDTO>();
  const [usage, setUsage] = useState<ProviderUsageTotalsDTO[]>();
  const [error, setError] = useState<string>();
  const [connectDialog, setConnectDialog] = useState<{ provider: AiProviderId; replacing: boolean }>();
  const [manageConnection, setManageConnection] = useState<ProviderConnectionDTO>();
  const [testingProvider, setTestingProvider] = useState<AiProviderId>();
  const [testResult, setTestResult] = useState<{ provider: AiProviderId; valid: boolean; error: string | null }>();
  const [savingConfig, setSavingConfig] = useState(false);
  const [configError, setConfigError] = useState<string>();

  function load() {
    setError(undefined);
    Promise.all([modelGatewayApi.listConnections(), modelGatewayApi.getConfig(), modelGatewayApi.getUsage()])
      .then(([c, cfg, u]) => {
        setConnections(c.connections);
        setConfig(cfg);
        setUsage(u.usage);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load AI/Models settings."));
  }

  useEffect(load, []);

  async function handleDisconnect(provider: AiProviderId) {
    try {
      await modelGatewayApi.disconnect(provider);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Couldn't disconnect ${PROVIDER_LABEL[provider]}.`);
    }
  }

  async function handleTest(provider: AiProviderId) {
    setTestingProvider(provider);
    setTestResult(undefined);
    try {
      const result = await modelGatewayApi.testConnection(provider);
      setTestResult({ provider, ...result });
      load();
    } catch (err) {
      setTestResult({ provider, valid: false, error: err instanceof Error ? err.message : "Couldn't verify this connection right now." });
    } finally {
      setTestingProvider(undefined);
    }
  }

  async function handleModeChange(mode: "auto" | "fixed") {
    if (!config) return;
    setSavingConfig(true);
    setConfigError(undefined);
    try {
      if (mode === "fixed") {
        const firstConnected = config.autoAllowed.find((a) => a.connected)?.provider;
        if (!firstConnected) {
          setConfigError("Connect a provider before switching to a fixed global AI brain.");
          return;
        }
        setConfig(await modelGatewayApi.setConfig({ mode: "fixed", fixedProvider: firstConnected }));
      } else {
        setConfig(await modelGatewayApi.setConfig({ mode: "auto" }));
      }
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Couldn't update the global AI brain.");
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleFixedProviderChange(provider: AiProviderId) {
    setSavingConfig(true);
    setConfigError(undefined);
    try {
      setConfig(await modelGatewayApi.setConfig({ mode: "fixed", fixedProvider: provider }));
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Couldn't update the global AI brain.");
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleToggleAutoAllowed(provider: AiProviderId, allowed: boolean) {
    if (!config) return;
    const next = config.autoAllowed.filter((a) => a.connected).map((a) => a.provider);
    const nextSet = new Set(next);
    if (allowed) nextSet.add(provider);
    else nextSet.delete(provider);
    setSavingConfig(true);
    setConfigError(undefined);
    try {
      setConfig(await modelGatewayApi.setConfig({ mode: "auto", autoAllowedProviders: [...nextSet] }));
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Couldn't update which providers Auto may use.");
    } finally {
      setSavingConfig(false);
    }
  }

  const connectedCount = connections?.filter((c) => c.connected).length ?? 0;

  return (
    <Section
      title={<span className="flex items-center gap-2"><BrainCircuitIcon className="size-4 text-muted-foreground" aria-hidden="true" />AI / Models</span>}
      description="Which AI providers CodeForge may use, and how it chooses between them."
    >
      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !connections && <LoadingState label="Loading AI/Models settings…" />}

      {connections && config && (
        <div className="flex flex-col gap-6 text-sm">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-brain-mode">Global AI Brain</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <NativeSelect
                className="w-full sm:w-64"
                id="ai-brain-mode"
                value={config.mode}
                onChange={(e) => void handleModeChange(e.target.value as "auto" | "fixed")}
                disabled={savingConfig}
              >
                <option value="auto">Auto — CodeForge decides</option>
                <option value="fixed">Fixed</option>
              </NativeSelect>
              {config.mode === "fixed" && (
                <NativeSelect
                  className="w-full sm:w-48"
                  aria-label="Fixed provider"
                  value={config.fixedProvider ?? ""}
                  onChange={(e) => void handleFixedProviderChange(e.target.value as AiProviderId)}
                  disabled={savingConfig}
                >
                  {config.autoAllowed
                    .filter((a) => a.connected)
                    .map((a) => (
                      <option key={a.provider} value={a.provider}>
                        {PROVIDER_LABEL[a.provider]}
                      </option>
                    ))}
                </NativeSelect>
              )}
            </div>
            <p className="text-muted-foreground">
              {config.mode === "auto"
                ? "Chat, task execution, and every other AI-powered operation use whichever allowed, connected provider is currently healthy."
                : "Chat, task execution, and every other AI-powered operation always use this exact provider/model — if its connection breaks, executions fail with an actionable error instead of silently switching."}
            </p>
            {configError && <ErrorState message={configError} />}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="font-medium">Connected Providers</h3>
            <ul className="divide-y rounded-2xl border">
              {connections.map((c) => (
                <li key={c.provider} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        c.connected ? "bg-tone-success" : c.status === "error" ? "bg-tone-danger" : "bg-muted-foreground/30",
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <strong className="font-medium">{PROVIDER_LABEL[c.provider]}</strong>
                      {c.connected ? (
                        <p className="text-muted-foreground">
                          Model: {c.model}
                          {c.lastVerifiedAt && ` · last verified ${c.lastVerifiedAt}`}
                        </p>
                      ) : c.status === "error" ? (
                        <p className="text-destructive">{c.lastError ?? "This connection stopped working."}</p>
                      ) : (
                        <p className="text-muted-foreground">Not connected.</p>
                      )}
                      {testResult?.provider === c.provider && (
                        <p className={testResult.valid ? "text-tone-success" : "text-destructive"}>
                          {testResult.valid ? "✓ Verified — this key still works." : `✕ ${testResult.error ?? "This key no longer works."}`}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {c.connected ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          onClick={() => void handleTest(c.provider)}
                          disabled={testingProvider === c.provider}
                        >
                          {testingProvider === c.provider ? "Testing…" : "Test connection"}
                        </Button>
                        <Button variant="outline" size="sm" type="button" onClick={() => setManageConnection(c)}>
                          Manage
                        </Button>
                        <Button variant="ghost" size="sm" type="button" onClick={() => void handleDisconnect(c.provider)}>
                          Disconnect
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" type="button" onClick={() => setConnectDialog({ provider: c.provider, replacing: false })}>
                        Connect
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {config.mode === "auto" && connectedCount > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Allowed for Auto</legend>
              <div className="flex flex-wrap gap-2">
                {config.autoAllowed
                  .filter((a) => a.connected)
                  .map((a) => (
                    <label
                      key={a.provider}
                      className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 has-checked:border-primary has-checked:bg-primary/5"
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={a.allowed}
                        disabled={savingConfig}
                        onChange={(e) => void handleToggleAutoAllowed(a.provider, e.target.checked)}
                      />
                      {PROVIDER_LABEL[a.provider]}
                    </label>
                  ))}
              </div>
            </fieldset>
          )}

          {connectedCount === 0 && (
            <p className="rounded-2xl bg-muted/60 p-4 text-muted-foreground">
              No provider is connected yet — connect Google, Anthropic, or OpenAI above. Until then, this deployment falls back to its own platform-configured model (unchanged).
            </p>
          )}

          <div className="flex flex-col gap-2">
            <h3 className="font-medium">AI Usage</h3>
            {!usage || usage.length === 0 ? (
              <p className="text-muted-foreground">No AI executions recorded yet.</p>
            ) : (
              <dl className="grid gap-2 sm:grid-cols-2">
                {usage.map((u) => (
                  <div key={u.providerId} className="rounded-2xl bg-muted/60 px-4 py-3">
                    <dt className="font-medium">{PROVIDER_LABEL[u.providerId as AiProviderId] ?? u.providerId}</dt>
                    <dd className="text-muted-foreground">
                      Input: {formatTokens(u.inputTokens)} · Output: {formatTokens(u.outputTokens)} · Total: {formatTokens(u.totalTokens)}
                      {u.runsWithUsage < u.runsTotal && (
                        <span className="block text-xs">
                          ({u.runsTotal - u.runsWithUsage} of {u.runsTotal} runs reported no usage)
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      )}

      {connectDialog && (
        <ConnectProviderDialog
          provider={connectDialog.provider}
          replacing={connectDialog.replacing}
          onClose={() => setConnectDialog(undefined)}
          onConnected={() => {
            setConnectDialog(undefined);
            setTestResult(undefined);
            load();
          }}
        />
      )}

      {manageConnection && (
        <ManageProviderDialog
          connection={manageConnection}
          onClose={() => setManageConnection(undefined)}
          onChanged={() => {
            setManageConnection(undefined);
            setTestResult(undefined);
            load();
          }}
          onReplaceKey={() => {
            setConnectDialog({ provider: manageConnection.provider, replacing: true });
            setManageConnection(undefined);
          }}
        />
      )}
    </Section>
  );
}
