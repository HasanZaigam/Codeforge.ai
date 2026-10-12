import { useState } from "react";
import { Link } from "react-router-dom";
import { chatApi } from "../../api/index.js";
import type { ChatSuggestionDTO } from "../../api/types.js";
import { ErrorState } from "../common/ErrorState.js";
import { ListChecksIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

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
      <Button type="button" variant="outline" size="sm" className="mt-1 w-fit" onClick={load}>
        <ListChecksIcon data-icon="inline-start" />
        Show suggestions
      </Button>
    );
  }

  return (
    <div className="mt-1 w-full space-y-3 rounded-2xl border bg-card p-3">
      {loading && <p className="text-sm text-muted-foreground">Loading suggestions…</p>}
      {error && <ErrorState message={error} onRetry={load} />}
      {suggestions && suggestions.length === 0 && (
        <p className="text-sm text-muted-foreground">No suggestions yet — analysis may still be running. Try again in a moment.</p>
      )}
      {suggestions && suggestions.length > 0 && !result && (
        <>
          <ul className="divide-y">
            {suggestions.map((s) => (
              <li key={s.itemId} className="flex items-center justify-between gap-3 py-2 first:pt-0">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    checked={selected.has(s.itemId)}
                    onChange={() => toggle(s.itemId)}
                  />
                  {s.ref && <span className="shrink-0 font-mono text-xs text-muted-foreground">{s.ref}</span>}{" "}
                  <span className="truncate">{s.title}</span>
                </label>
                <Link className="shrink-0 text-xs font-medium text-primary hover:underline" to={`/projects/${projectId}/backlog/${s.itemId}`}>
                  View
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={creating || selected.size === 0} onClick={() => createSelected([...selected])}>
              {creating ? "Creating…" : `Create selected tasks (${selected.size})`}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={creating}
              onClick={() => createSelected(suggestions.map((s) => s.itemId))}
            >
              Create all
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Nothing is created until you choose one of the buttons above — new tasks land in Tasks → BACKLOG, not started.
          </p>
        </>
      )}
      {result && (
        <p role="status" className="text-sm text-tone-success">
          {result.createdTaskIds.length === 0
            ? "No tasks were created."
            : `${result.createdTaskIds.length} task${result.createdTaskIds.length === 1 ? "" : "s"} created in `}
          {result.createdTaskIds.length > 0 && (
            <Link className="font-medium underline underline-offset-4" to={`/projects/${projectId}/tasks`}>
              Tasks → BACKLOG
            </Link>
          )}
          {result.createdTaskIds.length > 0 ? "." : ""}
        </p>
      )}
    </div>
  );
}
