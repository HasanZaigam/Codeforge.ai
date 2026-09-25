/** Renders the platform's own verification of a model-claimed file path — the model's claim is never shown as fact. */
export function repoCheckLabel(exists: boolean | null | undefined): string {
  if (exists === true) return "verified in repository";
  if (exists === false) return "not found in repository listing";
  return "not checked";
}

export function CandidateFileList({ files }: { files: Array<{ path: string; reason: string; existsInRepository: boolean | null | undefined }> }) {
  if (files.length === 0) return <p className="field-hint">No candidate files were suggested.</p>;
  return (
    <ul className="backlog-file-list">
      {files.map((f) => (
        <li key={f.path}>
          <code>{f.path}</code>{" "}
          <span className={`backlog-check ${f.existsInRepository === true ? "ok" : f.existsInRepository === false ? "missing" : "unchecked"}`}>
            {repoCheckLabel(f.existsInRepository)}
          </span>
          {f.reason && <div className="field-hint">{f.reason}</div>}
        </li>
      ))}
    </ul>
  );
}
