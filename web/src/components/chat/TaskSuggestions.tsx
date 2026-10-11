import { useState } from "react";
import { Link } from "react-router-dom";
import { chatApi } from "../../api/index.js";
import type { ChatSuggestionDTO } from "../../api/types.js";
import { ErrorState } from "../common/ErrorState.js";

/**
 * Rendered under an assistant message that started a real bulk analysis run (see `bulkJobId` on
 * ChatMessageDTO). Nothing here is fetched until the user explicitly asks — a suggestion is never
 * auto-loaded, and "Create as Tasks" is a separate, explicit action from viewing suggestions. Reuses
 * the EXISTING generate→approve→convert path (ChatService.createTasks -> BacklogBulkService.bulkAction)
 * — the same one Issues & Requests already uses.
 */
export function TaskSuggestions({ projectId, bulkJobId }: { projectId: string; bulkJobId: string }) {
  const [suggestions, setSuggestions] = useState<ChatSuggestionDTO[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ createdTaskIds: string[] }>();

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      const rows = await chatApi.listSuggestions(projectId, bulkJobId);
      setSuggestions(rows);
      setSelected(new Set(rows.filter((r) => r.proposal || r.status === "READY_FOR_TASK").map((r) => r.itemId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load suggestions.");
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function createSelected(ids: string[]) {
    if (ids.length === 0) return;
    setCreating(true);
    setError(undefined);
    try {
      const res = await chatApi.createTasks(projectId, ids);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create tasks.");
    } finally {
      setCreating(false);
    }
  }

  if (!suggestions && !loading) {
    return (
      <button type="button" className="btn btn-secondary" onClick={load}>
        Show suggestions
      </button>
    );
  }

  return (
    <div className="chat-suggestions">
      {loading && <p className="field-hint">Loading suggestions…</p>}
      {error && <ErrorState message={error} onRetry={load} />}
      {suggestions && suggestions.length === 0 && (
        <p className="field-hint">No suggestions yet — analysis may still be running. Try again in a moment.</p>
      )}
      {suggestions && suggestions.length > 0 && !result && (
        <>
          <ul className="chat-suggestion-list">
            {suggestions.map((s) => (
              <li key={s.itemId} className="chat-suggestion-row">
                <label>
                  <input type="checkbox" checked={selected.has(s.itemId)} onChange={() => toggle(s.itemId)} />
                  {s.ref && <span className="backlog-ref">{s.ref}</span>} <span>{s.title}</span>
                </label>
                <Link className="btn-link chat-suggestion-view-link" to={`/projects/${projectId}/backlog/${s.itemId}`}>
                  View
                </Link>
              </li>
            ))}
          </ul>
          <div className="chat-suggestion-actions">
            <button type="button" className="btn btn-primary" disabled={creating || selected.size === 0} onClick={() => createSelected([...selected])}>
              {creating ? "Creating…" : `Create selected tasks (${selected.size})`}
            </button>{" "}
            <button type="button" className="btn btn-secondary" disabled={creating} onClick={() => createSelected(suggestions.map((s) => s.itemId))}>
              Create all
            </button>
          </div>
          <p className="field-hint">Nothing is created until you choose one of the buttons above — new tasks land in Tasks → BACKLOG, not started.</p>
        </>
      )}
      {result && (
        <p role="status" className="backlog-success">
          {result.createdTaskIds.length === 0
            ? "No tasks were created."
            : `${result.createdTaskIds.length} task${result.createdTaskIds.length === 1 ? "" : "s"} created in `}
          {result.createdTaskIds.length > 0 && <Link to={`/projects/${projectId}/tasks`}>Tasks → BACKLOG</Link>}
          {result.createdTaskIds.length > 0 ? "." : ""}
        </p>
      )}
    </div>
  );
}
