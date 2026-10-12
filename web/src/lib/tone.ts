import type { StatusMeta } from "./statusMeta.js";

export type Tone = StatusMeta["tone"];

/** Tinted badge/pill surface for a status tone — colors come from the `--tone-*` tokens in index.css. */
export const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-tone-neutral/12 text-tone-neutral",
  active: "bg-tone-active/12 text-tone-active",
  attention: "bg-tone-attention/15 text-tone-attention",
  info: "bg-tone-info/12 text-tone-info",
  success: "bg-tone-success/12 text-tone-success",
  danger: "bg-tone-danger/12 text-tone-danger",
  cancelled: "bg-tone-cancelled/12 text-tone-cancelled",
};

/** Solid dot for a status tone — column headers, legends, compact indicators. */
export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-tone-neutral",
  active: "bg-tone-active",
  attention: "bg-tone-attention",
  info: "bg-tone-info",
  success: "bg-tone-success",
  danger: "bg-tone-danger",
  cancelled: "bg-tone-cancelled",
};
