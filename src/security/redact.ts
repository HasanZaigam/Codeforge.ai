/**
 * Developer Alpha — output redaction. The OpenCode child process necessarily inherits provider API
 * keys (it needs them to call the model — see OpenCodeAdapter.buildCleanEnvironment, a denylist),
 * and it runs with a shell tool under `--auto`, so a misbehaving or prompt-injected agent can print
 * its own environment (`printenv`) and that text lands in StepResult.summary, then the task report,
 * events and PR body. This is a last-line defense, not a sandbox (GAP-011): any environment
 * variable whose NAME looks secret-bearing has its VALUE replaced wherever it appears in
 * agent-produced text before that text is persisted. Never logs or returns the secret itself.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
/** Short values ("1", "true") would redact ordinary text — only treat sufficiently long values as secrets. */
const MIN_SECRET_LENGTH = 8;

export function collectSecretValues(env: NodeJS.ProcessEnv): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(name)) out.push({ name, value });
  }
  // Longest first so a secret that contains another as a substring is redacted whole.
  return out.sort((a, b) => b.value.length - a.value.length);
}

export function redactSecrets(text: string, env: NodeJS.ProcessEnv): string {
  let result = text;
  for (const { name, value } of collectSecretValues(env)) {
    if (result.includes(value)) result = result.split(value).join(`[REDACTED:${name}]`);
  }
  return result;
}
