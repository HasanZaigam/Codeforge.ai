import { useState } from "react";
import { Dialog } from "../common/Dialog.js";
import { ErrorState } from "../common/ErrorState.js";
import { bulkBacklogApi, type BacklogImportDTO, type ImportPreviewDTO } from "../../api/index.js";
import { REJECT_REASON_LABELS } from "../../lib/backlogLabels.js";

/**
 * Two-step import: PREVIEW (nothing is stored, no model is called) then an explicit CONFIRM. Importing never starts analysis — the
 * user does that on the review screen.
 */
export function ImportBugsDialog({ projectId, onClose, onImported }: { projectId: string; onClose: () => void; onImported: (imp: BacklogImportDTO) => void }) {
  const [csv, setCsv] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [preview, setPreview] = useState<ImportPreviewDTO>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function readFile(file: File) {
    setPreview(undefined);
    setCsv(await file.text());
    if (!sourceName) setSourceName(file.name.replace(/\.[^.]+$/, ""));
  }

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That failed. Please try again.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const canPreview = csv.trim() !== "" && sourceName.trim() !== "" && !busy;
  const rejected = preview?.rows.filter((r) => r.status === "REJECTED") ?? [];

  return (
    <Dialog title="Import bugs" description="Import a CSV bug sheet as backlog items. Nothing is analyzed and no task is created — you choose what to analyze next." onClose={onClose}>
      <div className="field">
        <label htmlFor="import-file">CSV file</label>
        <input id="import-file" type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} />
        <span className="field-hint">Export your sheet as CSV (one sheet per file). Common headers such as Bug Id, Bug title, Step to Reproduce, Expected Result, Actual Result, Priority, Module are recognised.</span>
      </div>
      <div className="field">
        <label htmlFor="import-csv">…or paste CSV</label>
        <textarea id="import-csv" rows={5} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(undefined); }} />
      </div>
      <div className="field">
        <label htmlFor="import-source">Source name</label>
        <input id="import-source" value={sourceName} maxLength={100} onChange={(e) => { setSourceName(e.target.value); setPreview(undefined); }} placeholder="e.g. OTT Bug Report — Application" />
        <span className="field-hint">Re-importing the same source name and bug ids is safe: existing items are linked, never duplicated or changed.</span>
      </div>
      {error && <ErrorState message={error} />}
      {preview && (
        <div role="status" className="import-preview">
          <p>
            <strong>{preview.totalRows} rows:</strong> {preview.accepted} valid, {preview.rejected} rejected
            {preview.alreadyImported > 0 ? `, ${preview.alreadyImported} already imported` : ""}.
          </p>
          <p className="field-hint">Mapped columns: {Object.entries(preview.mapping.fields).map(([k, v]) => `${k} ← ${v}`).join("; ") || "none"}.</p>
          {preview.warnings.map((w) => <p key={w} className="field-hint">⚠ {w}</p>)}
          {rejected.length > 0 && (
            <details open>
              <summary>{rejected.length} rejected row{rejected.length === 1 ? "" : "s"}</summary>
              <ul className="backlog-bullets">
                {rejected.map((r) => (
                  <li key={r.rowNumber}>Row {r.rowNumber}: <strong>{REJECT_REASON_LABELS[r.reason ?? ""] ?? r.reason}</strong> — {r.detail}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-secondary" disabled={!canPreview} onClick={async () => setPreview(await run(() => bulkBacklogApi.preview(projectId, csv, sourceName.trim())))}>
          Preview
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!preview || preview.errors.length > 0 || preview.accepted === 0 || busy}
          onClick={async () => {
            const imp = await run(() => bulkBacklogApi.confirmImport(projectId, csv, sourceName.trim()));
            if (imp) onImported(imp);
          }}
        >
          {busy ? "Working…" : preview ? `Import ${preview.accepted} valid row${preview.accepted === 1 ? "" : "s"}` : "Import"}
        </button>
      </div>
    </Dialog>
  );
}
