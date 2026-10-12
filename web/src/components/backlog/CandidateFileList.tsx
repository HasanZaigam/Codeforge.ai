import { ToneBadge } from "../common/ToneBadge.js";

/** Renders the platform's own verification of a model-claimed file path — the model's claim is never shown as fact. */
export function repoCheckLabel(exists: boolean | null | undefined): string {
  if (exists === true) return "verified in repository";
  if (exists === false) return "not found in repository listing";
  return "not checked";
}

export function CandidateFileList({ files }: { files: Array<{ path: string; reason: string; existsInRepository: boolean | null | undefined }> }) {
  if (files.length === 0) return <p className="text-sm text-muted-foreground">No candidate files were suggested.</p>;
  return (
    <ul className="space-y-2">
      {files.map((f) => (
        <li key={f.path} className="space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <code>{f.path}</code>{" "}
            <ToneBadge tone={f.existsInRepository === true ? "success" : f.existsInRepository === false ? "danger" : "neutral"}>
              {repoCheckLabel(f.existsInRepository)}
            </ToneBadge>
          </div>
          {f.reason && <div className="text-muted-foreground">{f.reason}</div>}
        </li>
      ))}
    </ul>
  );
}
