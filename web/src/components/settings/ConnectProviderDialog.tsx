import { useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { modelGatewayApi } from "../../api/index.js";
import type { AiProviderId, ProviderConnectionDTO } from "../../api/types.js";

const PROVIDER_LABEL: Record<AiProviderId, string> = { google: "Google", anthropic: "Anthropic", openai: "OpenAI" };

/**
 * Model Gateway — connecting one AI provider (see /docs/MODEL_GATEWAY.md). The key is verified with
 * a REAL call to the provider (ModelGatewayService.connectProvider) before anything is stored — this
 * dialog never shows a "Connected" result the backend didn't actually confirm. Mirrors
 * GitHubConnectDialog's exact shape (a secret pasted into a form, verified, never shown again).
 *
 * The model picker is a REAL, on-demand dropdown (ModelGatewayService.listAvailableModels) — never a
 * hardcoded catalog. Nobody should have to remember/type an exact model id from memory: paste the
 * key, load the real list of models that key can actually use, pick one. If the provider's list call
 * fails (or a key hasn't been entered yet), a free-text fallback is still available.
 */
export function ConnectProviderDialog({
  provider,
  onClose,
  onConnected,
}: {
  provider: AiProviderId;
  onClose: () => void;
  onConnected: (connection: ProviderConnectionDTO) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>();
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string>();
  const [useManualModel, setUseManualModel] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleLoadModels() {
    if (!apiKey.trim()) return;
    setLoadingModels(true);
    setModelsError(undefined);
    setAvailableModels(undefined);
    try {
      const { models, error: fetchError } = await modelGatewayApi.listModels(provider, apiKey.trim());
      if (fetchError) {
        setModelsError(fetchError);
        setUseManualModel(true);
      } else if (models.length === 0) {
        setModelsError(`${PROVIDER_LABEL[provider]} didn't report any available models for this key.`);
        setUseManualModel(true);
      } else {
        setAvailableModels(models);
        setModel((current) => (models.includes(current) ? current : models[0]!));
      }
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : "Couldn't load models right now.");
      setUseManualModel(true);
    } finally {
      setLoadingModels(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const connection = await modelGatewayApi.connect(provider, apiKey.trim(), model.trim());
      onConnected(connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect this provider. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog title={`Connect ${PROVIDER_LABEL[provider]}`} description="The key is verified against the provider's own API before it's stored." onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="provider-api-key">API key</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="provider-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setAvailableModels(undefined);
                setModelsError(undefined);
              }}
              required
              maxLength={4000}
              autoComplete="off"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleLoadModels()} disabled={!apiKey.trim() || loadingModels}>
              {loadingModels ? "Loading…" : "Load models"}
            </button>
          </div>
          <p className="field-hint">Encrypted at rest and never shown again, sent to the AI developer, or logged.</p>
        </div>

        <div className="field">
          <label htmlFor="provider-model">Model</label>
          {availableModels && !useManualModel ? (
            <>
              <select id="provider-model" value={model} onChange={(e) => setModel(e.target.value)} required>
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                {availableModels.length} model{availableModels.length === 1 ? "" : "s"} this key can use, loaded just now from {PROVIDER_LABEL[provider]}.{" "}
                <button type="button" className="btn-link" onClick={() => setUseManualModel(true)}>
                  Type it manually instead
                </button>
              </p>
            </>
          ) : (
            <>
              <input id="provider-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="exact model id" required maxLength={200} />
              <p className="field-hint">
                {modelsError ? `${modelsError} ` : "Not sure of the exact id? "}
                {!modelsError && apiKey.trim() ? (
                  <button type="button" className="btn-link" onClick={() => void handleLoadModels()}>
                    Load this key's available models
                  </button>
                ) : (
                  "Paste the API key above, then \"Load models\"."
                )}
              </p>
            </>
          )}
        </div>

        {error && <ErrorState message={error} />}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || !apiKey.trim() || !model.trim()}>
            {submitting ? "Connecting…" : "Test & Connect"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
