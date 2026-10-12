import type { TaskReport } from "../../api/index.js";
import { ToneBadge } from "../common/ToneBadge.js";
import type { Tone } from "../../lib/tone.js";

type Finding = TaskReport["reviewFindings"][number];

function severityTone(severity: string): Tone {
  const s = severity.toLowerCase();
  if (s === "critical" || s === "high" || s === "blocker" || s === "major") return "danger";
  if (s === "medium" || s === "warning" || s === "moderate") return "attention";
  return "neutral";
}

/** Reviewer findings as severity-tagged rows — shared by the task report and each agent run. */
export function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ul className="space-y-2">
      {findings.map((finding, i) => (
        <li className="flex items-start gap-2 text-sm" key={i}>
          <ToneBadge tone={severityTone(finding.severity)} className="mt-0.5 capitalize">
            {finding.severity}
          </ToneBadge>
          <span className="sr-only">—</span>
          <span>{finding.summary}</span>
        </li>
      ))}
    </ul>
  );
}
