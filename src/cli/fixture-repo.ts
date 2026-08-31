import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const PACKAGE_JSON = JSON.stringify({ name: "fixture-project", version: "1.0.0", scripts: { test: "node test.js" } }, null, 2);

const BUGGY_ADD = `function add(a, b) {\n  return a - b; // bug: subtracts instead of adds\n}\nmodule.exports = { add };\n`;

const TEST_FILE = `const assert = require("node:assert");\nconst { add } = require("./add.js");\nassert.strictEqual(add(2, 3), 5, "add(2, 3) should be 5");\nconsole.log("test passed");\n`;

/**
 * Creates a tiny local git repository used as the "project repo" for the
 * demo/tests, standing in for a real connected project (e.g. OTT/E-True) so
 * the vertical slice can run without a live GitHub repo or credentials. See
 * /docs/MVP_SCOPE.md and the security-boundary notes in
 * local-git-source-control-provider.ts.
 */
export async function createFixtureRepo(rootDir: string): Promise<string> {
  const repoPath = join(rootDir, "fixture-repo");
  await mkdir(repoPath, { recursive: true });
  await writeFile(join(repoPath, "package.json"), PACKAGE_JSON);
  await writeFile(join(repoPath, "add.js"), BUGGY_ADD);
  await writeFile(join(repoPath, "test.js"), TEST_FILE);
  await writeFile(
    join(repoPath, "CLAUDE.md"),
    "# Fixture project\n\nA minimal Node project used to exercise the platform's orchestration loop. `node test.js` is the test command.\n",
  );

  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoPath });
  await execFileAsync("git", ["-c", "user.email=fixture@local", "-c", "user.name=Fixture", "add", "-A"], { cwd: repoPath });
  await execFileAsync(
    "git",
    ["-c", "user.email=fixture@local", "-c", "user.name=Fixture", "commit", "-m", "initial commit"],
    { cwd: repoPath },
  );
  return repoPath;
}
