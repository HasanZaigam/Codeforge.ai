import { useState, type FormEvent } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { modelGatewayApi } from "../../api/index.js";
import type { AiProviderId, ProviderConnectionDTO } from "../../api/types.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelSelect } from "./ModelSelect.js";

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
  replacing = false,
  onClose,
  onConnected,
}: {
  provider: AiProviderId;
  /** Opened from Manage → "Replace API key" on an existing connection: same flow, clearer wording. */
  replacing?: boolean;
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
    <Dialog
      title={replacing ? `Replace ${PROVIDER_LABEL[provider]} API key` : `Connect ${PROVIDER_LABEL[provider]}`}
      description={
        replacing
          ? "The new key is verified against the provider's own API, then replaces the stored one."
          : "The key is verified against the provider's own API before it's stored."
      }
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="provider-api-key">API key</Label>
          <div className="flex gap-2">
            <Input
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
              className="flex-1"
            />
            <Button variant="outline" type="button" onClick={() => void handleLoadModels()} disabled={!apiKey.trim() || loadingModels}>
              {loadingModels ? "Loading…" : "Load models"}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Encrypted at rest and never shown again, sent to the AI developer, or logged.</p>
        </div>

        <div className="mb-4 flex flex-col gap-2">
          <Label htmlFor="provider-model">Model</Label>
          {availableModels && !useManualModel ? (
            <>
              <ModelSelect id="provider-model" models={availableModels} value={model} onChange={setModel} />
              <p className="text-sm text-muted-foreground">
                {availableModels.length} chat model{availableModels.length === 1 ? "" : "s"} this key can use, newest first, loaded just now from {PROVIDER_LABEL[provider]}.{" "}
                <Button variant="link" type="button" className="h-auto p-0" onClick={() => setUseManualModel(true)}>
                  Type it manually instead
                </Button>
              </p>
            </>
          ) : (
            <>
              <Input id="provider-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="exact model id" required maxLength={200} />
              <p className="text-sm text-muted-foreground">
                {modelsError ? `${modelsError} ` : "Not sure of the exact id? "}
                {!modelsError && apiKey.trim() ? (
                  <Button variant="link" type="button" className="h-auto p-0" onClick={() => void handleLoadModels()}>
                    Load this key's available models
                  </Button>
                ) : (
                  "Paste the API key above, then \"Load models\"."
                )}
              </p>
            </>
          )}
        </div>

        {error && <ErrorState message={error} />}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !apiKey.trim() || !model.trim()}>
            {submitting ? "Connecting…" : "Test & Connect"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
