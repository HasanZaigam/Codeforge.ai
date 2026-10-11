import { useEffect, useState } from "react";
import { modelGatewayApi } from "../../api/index.js";
import type { AiProviderId, GlobalAiConfigDTO, ProviderConnectionDTO, ProviderUsageTotalsDTO } from "../../api/types.js";
import { ConnectProviderDialog } from "./ConnectProviderDialog.js";
import { LoadingState } from "../common/LoadingState.js";
import { ErrorState } from "../common/ErrorState.js";

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
  const [connectDialogProvider, setConnectDialogProvider] = useState<AiProviderId>();
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
    <div className="card card-padded stack" style={{ gap: 12 }}>
      <h3>AI / Models</h3>
      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !connections && <LoadingState label="Loading AI/Models settings…" />}

      {connections && config && (
        <>
          <div className="field">
            <label>Global AI Brain</label>
            <select value={config.mode} onChange={(e) => void handleModeChange(e.target.value as "auto" | "fixed")} disabled={savingConfig}>
              <option value="auto">Auto — CodeForge decides</option>
              <option value="fixed">Fixed</option>
            </select>
            {config.mode === "fixed" && (
              <select value={config.fixedProvider ?? ""} onChange={(e) => void handleFixedProviderChange(e.target.value as AiProviderId)} disabled={savingConfig} style={{ marginTop: 8 }}>
                {config.autoAllowed
                  .filter((a) => a.connected)
                  .map((a) => (
                    <option key={a.provider} value={a.provider}>
                      {PROVIDER_LABEL[a.provider]}
                    </option>
                  ))}
              </select>
            )}
            <p className="field-hint">
              {config.mode === "auto"
                ? "Chat, task execution, and every other AI-powered operation use whichever allowed, connected provider is currently healthy."
                : "Chat, task execution, and every other AI-powered operation always use this exact provider/model — if its connection breaks, executions fail with an actionable error instead of silently switching."}
            </p>
            {configError && <ErrorState message={configError} />}
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <strong>Connected Providers</strong>
            {connections.map((c) => (
              <div key={c.provider} className="page-header" style={{ marginBottom: 0 }}>
                <div>
                  <strong>{PROVIDER_LABEL[c.provider]}</strong>
                  {c.connected ? (
                    <p className="field-hint" style={{ margin: 0 }}>
                      Model: {c.model}
                      {c.lastVerifiedAt && ` · last verified ${c.lastVerifiedAt}`}
                    </p>
                  ) : c.status === "error" ? (
                    <p className="field-hint" style={{ margin: 0 }}>
                      {c.lastError ?? "This connection stopped working."}
                    </p>
                  ) : (
                    <p className="field-hint" style={{ margin: 0 }}>
                      Not connected.
                    </p>
                  )}
                  {testResult?.provider === c.provider && (
                    <p className={`field-hint ${testResult.valid ? "" : "danger"}`} style={{ margin: 0 }}>
                      {testResult.valid ? "✓ Verified — this key still works." : `✕ ${testResult.error ?? "This key no longer works."}`}
                    </p>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {c.connected ? (
                    <>
                      <button className="btn btn-secondary btn-sm" onClick={() => void handleTest(c.provider)} disabled={testingProvider === c.provider}>
                        {testingProvider === c.provider ? "Testing…" : "Test connection"}
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setConnectDialogProvider(c.provider)}>
                        Manage
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => void handleDisconnect(c.provider)}>
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={() => setConnectDialogProvider(c.provider)}>
                      Connect
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {config.mode === "auto" && connectedCount > 0 && (
            <div className="field">
              <label>Allowed for Auto</label>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {config.autoAllowed
                  .filter((a) => a.connected)
                  .map((a) => (
                    <label key={a.provider} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: "normal" }}>
                      <input type="checkbox" checked={a.allowed} disabled={savingConfig} onChange={(e) => void handleToggleAutoAllowed(a.provider, e.target.checked)} />
                      {PROVIDER_LABEL[a.provider]}
                    </label>
                  ))}
              </div>
            </div>
          )}

          {connectedCount === 0 && (
            <p className="text-muted">
              No provider is connected yet — connect Google, Anthropic, or OpenAI above. Until then, this deployment falls back to its own platform-configured model (unchanged).
            </p>
          )}

          <div className="stack" style={{ gap: 4 }}>
            <strong>AI Usage</strong>
            {!usage || usage.length === 0 ? (
              <p className="text-muted">No AI executions recorded yet.</p>
            ) : (
              <dl className="info-callout" style={{ margin: 0 }}>
                {usage.map((u) => (
                  <div key={u.providerId}>
                    <dt>{PROVIDER_LABEL[u.providerId as AiProviderId] ?? u.providerId}</dt>
                    <dd>
                      Input: {formatTokens(u.inputTokens)} · Output: {formatTokens(u.outputTokens)} · Total: {formatTokens(u.totalTokens)}
                      {u.runsWithUsage < u.runsTotal && <span className="field-hint"> ({u.runsTotal - u.runsWithUsage} of {u.runsTotal} runs reported no usage)</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </>
      )}

      {connectDialogProvider && (
        <ConnectProviderDialog
          provider={connectDialogProvider}
          onClose={() => setConnectDialogProvider(undefined)}
          onConnected={() => {
            setConnectDialogProvider(undefined);
            setTestResult(undefined);
            load();
          }}
        />
      )}
    </div>
  );
}
