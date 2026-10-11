

## Adjudication import boundary *(Phase 4B.2)*
An uploaded CSV is never trusted for identity: every `targetId` is resolved server-side and checked against the **uploaded-to** project (not merely "does this actor own it somewhere") — a target belonging to a different project the same owner also owns is still rejected, per row. AI-reference columns in the template (context, confidence/state) are read for display only and can never set or imply a label. A reviewer's note is untrusted text, stored verbatim, escaped on CSV export.
