import { useState, type FormEvent } from "react";
import type { HumanInputRequestDTO, TaskDTO } from "../../api/index.js";
import { ErrorState } from "../common/ErrorState.js";

/**
 * The most important UX state in the product (Step 4 instructions §12): why
 * the task stopped, what was tried, what's blocking it, and a clear
 * question with recommended options. Submitting only calls POST
 * /tasks/:id/input — the frontend never sets status itself; the Orchestrator
 * decides what happens next (see /docs/TASK_LIFECYCLE.md).
 */
export function NeedsInputPanel({
  input,
  onSubmit,
  submitting,
}: {
  input: HumanInputRequestDTO;
  onSubmit: (answer: { selectedOption: string | null; freeText: string }) => Promise<TaskDTO>;
  submitting: boolean;
}) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await onSubmit({ selectedOption, freeText: freeText.trim() });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit your answer. Please try again.");
    }
  }

  if (submitted) {
    return (
      <div className="needs-input-panel">
        <h2>Thanks — continuing</h2>
        <p>The AI developer is resuming with your answer.</p>
      </div>
    );
  }

  return (
    <div className="needs-input-panel">
      <h2>Your decision is required</h2>

      <div className="needs-input-block">
        <h4>What was found</h4>
        <p>{input.discovered}</p>
      </div>

      {input.attempted.length > 0 && (
        <div className="needs-input-block">
          <h4>What was tried</h4>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {input.attempted.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="needs-input-block">
        <h4>What's blocking progress</h4>
        <p>{input.blocker}</p>
      </div>

      <div className="needs-input-block">
        <h4>Question</h4>
        <p style={{ fontWeight: 600 }}>{input.question}</p>
      </div>

      <form onSubmit={handleSubmit}>
        {input.options.length > 0 && (
          <div className="option-list" role="radiogroup" aria-label="Recommended options">
            {input.options.map((option) => (
              <label
                key={option.label}
                className={`option-item${selectedOption === option.label ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="option"
                  value={option.label}
                  checked={selectedOption === option.label}
                  onChange={() => setSelectedOption(option.label)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span className="option-label">{option.label}</span>
                  <br />
                  <span className="option-description">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="field">
          <label htmlFor="answer-text">Your decision</label>
          <textarea
            id="answer-text"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Explain your decision, or add anything the options above don't cover…"
            rows={3}
            required
            maxLength={10000}
          />
        </div>

        {error && <ErrorState message={error} />}

        <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !freeText.trim()}>
          {submitting ? "Submitting…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
