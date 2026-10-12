import { Spinner } from "@/components/ui/spinner";

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground" role="status">
      <Spinner />
      <p>{label}</p>
    </div>
  );
}
