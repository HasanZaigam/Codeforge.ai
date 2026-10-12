import { useEffect, useState, type FormEvent } from "react";
import { KeyRoundIcon } from "lucide-react";
import { Dialog, DialogActions } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { LoadingState } from "../common/LoadingState.js";
import { modelGatewayApi } from "../../api/index.js";
import type { AiProviderId, ProviderConnectionDTO } from "../../api/types.js";
import { ModelSelect } from "./ModelSelect.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PROVIDER_LABEL: Record<AiProviderId, string> = { google: "Google", anthropic: "Anthropic", openai: "OpenAI" };

/**
 * "Manage" for an already-connected provider: change its model without re-pasting the API key. The
 * model list is loaded server-side with the STORED key (ModelGatewayService.listModelsForConnection),
 * and a new model is validated with a real provider call before it replaces the current one
 * (changeConnectionModel). Replacing the key itself is a separate, explicit action that hands off to
 * the regular Connect flow.
 */
export function ManageProviderDialog({
  connection,
  onClose,
  onChanged,
  onReplaceKey,
}: {
  connection: ProviderConnectionDTO;
  onClose: () => void;
  onChanged: (connection: ProviderConnectionDTO) => void;
  onReplaceKey: () => void;
}) {
  const provider = connection.provider;
  const currentModel = connection.model ?? "";
  const [model, setModel] = useState(currentModel);
  const [models, setModels] = useState<string[]>();
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelsError, setModelsError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    modelGatewayApi
      .listConnectionModels(provider)
      .then(({ models: list, error: fetchError }) => {
        if (cancelled) return;
        if (fetchError) setModelsError(fetchError);
        else if (list.length === 0) setModelsError(`${PROVIDER_LABEL[provider]} didn't report any chat models for this key.`);
        // The current model stays selectable even if the provider no longer lists it.
        else setModels(currentModel && !list.includes(currentModel) ? [currentModel, ...list] : list);
      })
      .catch((err) => !cancelled && setModelsError(err instanceof Error ? err.message : "Couldn't load models right now."))
      .finally(() => !cancelled && setLoadingModels(false));
    return () => {
      cancelled = true;
    };
  }, [provider, currentModel]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      onChanged(await modelGatewayApi.changeModel(provider, model.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the model. Please try again.");
      setSaving(false);
    }
  }

  const unchanged = model.trim() === currentModel;

  return (
    <Dialog
      title={`Manage ${PROVIDER_LABEL[provider]}`}
      description="Switch the model CodeForge uses with this provider. Your saved API key is reused — you don't need to paste it again."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">
          <span className="text-muted-foreground">Current model: </span>
          <code>{currentModel || "—"}</code>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="manage-provider-model">Model</Label>
          {loadingModels ? (
            <LoadingState label="Loading models with your saved key…" />
          ) : models ? (
            <ModelSelect id="manage-provider-model" models={models} value={model} onChange={setModel} disabled={saving} />
          ) : (
            <>
              <Input
                id="manage-provider-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="exact model id"
                required
                maxLength={200}
                disabled={saving}
              />
              {modelsError && <p className="text-sm text-muted-foreground">{modelsError} You can still type a model id.</p>}
            </>
          )}
          <p className="text-sm text-muted-foreground">
            The new model is checked against {PROVIDER_LABEL[provider]} before it's saved. It applies to the next Chat message or
            task run — anything already running keeps its current model.
          </p>
        </div>

        {error && <ErrorState message={error} />}

        <div className="flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <Button type="button" variant="ghost" className="self-start" onClick={onReplaceKey} disabled={saving}>
            <KeyRoundIcon data-icon="inline-start" />
            Replace API key
          </Button>
          <DialogActions>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || loadingModels || unchanged || !model.trim()}>
              {saving ? "Checking…" : "Save model"}
            </Button>
          </DialogActions>
        </div>
      </form>
    </Dialog>
  );
}
