import { CircleAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** Never renders a raw error/stack trace — see /docs/UI_ARCHITECTURE.md "Error UX". */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert variant="destructive" className="error-banner">
      <CircleAlertIcon />
      <AlertDescription>
        <p>{message}</p>
        {onRetry && (
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
