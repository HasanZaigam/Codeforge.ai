export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state-block" role="status">
      <p>{label}</p>
    </div>
  );
}
