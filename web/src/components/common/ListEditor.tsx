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
}: {
  id: string;
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  addLabel: string;
  emptyHint?: string;
  itemPlaceholder?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {items.length === 0 && emptyHint && <p className="field-hint">{emptyHint}</p>}
      <div id={id} className="list-editor" role="group" aria-label={label}>
        {items.map((item, index) => (
          <div className="list-editor-row" key={index}>
            <input
              value={item}
              placeholder={itemPlaceholder}
              aria-label={`${label} item ${index + 1}`}
              onChange={(e) => {
                const next = [...items];
                next[index] = e.target.value;
                onChange(next);
              }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary" onClick={() => onChange([...items, ""])}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}
