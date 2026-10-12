import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A plain add/edit/remove list editor for a string[] field — used by ProjectContextPanel for
 * instructions/architecture/conventions/validation guidance/constraints. Deliberately simple: no
 * rich text, no drag-and-drop reordering (none exists elsewhere in the project). Order is
 * preserved; editing or removing one item never reorders the rest.
 */
export function ListEditor({
  id,
  label,
  items,
  onChange,
  addLabel,
  emptyHint,
  itemPlaceholder,
  hideLabel,
}: {
  id: string;
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  addLabel: string;
  emptyHint?: string;
  itemPlaceholder?: string;
  /** Keeps the field's own accessible label (still read by screen readers) but visually hides it —
   *  for callers (ProjectContextPanel) that already render an equivalent heading immediately above. */
  hideLabel?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </Label>
      {items.length === 0 && emptyHint && <p className="text-sm text-muted-foreground">{emptyHint}</p>}
      <div id={id} className="space-y-2" role="group" aria-label={label}>
        {items.map((item, index) => (
          <div className="flex items-center gap-2" key={index}>
            <Input
              value={item}
              placeholder={itemPlaceholder}
              aria-label={`${label} item ${index + 1}`}
              onChange={(e) => {
                const next = [...items];
                next[index] = e.target.value;
                onChange(next);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove"
              title="Remove"
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              <XIcon />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, ""])}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}
