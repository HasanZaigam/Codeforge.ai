import { NativeSelect } from "@/components/ui/native-select";

/**
 * The model dropdown shared by the Connect and Manage dialogs. The server already returns chat
 * models only, newest first, with fine-tunes last (provider-adapter.ts); fine-tunes get their own
 * group here so they don't crowd the base models.
 */
export function ModelSelect({
  id,
  models,
  value,
  onChange,
  disabled,
}: {
  id: string;
  models: string[];
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const base = models.filter((m) => !m.startsWith("ft:"));
  const fineTuned = models.filter((m) => m.startsWith("ft:"));
  return (
    <NativeSelect className="w-full" id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} required>
      {base.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      {fineTuned.length > 0 && (
        <optgroup label="Your fine-tuned models">
          {fineTuned.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </optgroup>
      )}
    </NativeSelect>
  );
}
