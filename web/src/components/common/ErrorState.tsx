/** Never renders a raw error/stack trace — see /docs/UI_ARCHITECTURE.md "Error UX". */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
