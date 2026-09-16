import type { ProjectContextDTO } from "../api/index.js";

/**
 * Frontend-only rendering of the same bounded project-context semantics the backend injects into
 * AI prompts (see src/orchestrator/project-context-section.ts). A separate implementation is
 * unavoidable — this is a different package/runtime than the backend — but it mirrors the same
 * fields and the same "guidance, not control" framing, and, like the backend renderer, never
 * includes `revision`: that's platform bookkeeping, not project knowledge the AI needs. Display-only
 * — never sent anywhere, and never claims to be the byte-for-byte prompt text assembled server-side.
 */
export function buildAiContextPreview(context: ProjectContextDTO): string {
  const lines: string[] = [`Project: ${context.project.name}`];
  if (context.project.description) lines.push(`Description: ${context.project.description}`);
  appendSection(lines, "Instructions", context.instructions);
  appendSection(lines, "Architecture", context.architecture);
  appendSection(lines, "Conventions", context.conventions);
  appendSection(lines, "Validation guidance", context.validation.commands);
  appendSection(lines, "Constraints", context.constraints);
  return lines.join("\n");
}

function appendSection(lines: string[], heading: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push("", `${heading}:`, ...items.map((item) => `- ${item}`));
}
