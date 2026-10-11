import { test } from "node:test";
import assert from "node:assert/strict";
import { investigate } from "../src/backlog/investigation.js";
import { locateEntries } from "../src/backlog/flow.js";
import { buildRepositoryIndex, extractFile, sourceKeyOf } from "../src/backlog/repository-index.js";
import { RepositoryInspector } from "../src/backlog/repository-inspector.js";
import { fakeStructure } from "./helpers/backlog-harness.js";

/**
 * Phase 4A.6 — flow-aware evidence. A mechanism that exists is NOT evidence about the reported flow: the platform must
 * find the reported entry point and a static name-reference path from it to the mechanism. Even then the wording is
 * "static name-reference path, not a proven call path", and behaviour stays unverified.
 */

const signal = new AbortController().signal;
const REV = "c".repeat(40);

async function run(files: Record<string, string>, text: string) {
  const provider = fakeStructure(files, { revision: REV });
  const session = await provider.open({} as never, signal);
  const index = await buildRepositoryIndex(session, sourceKeyOf({ repoUrl: "r", defaultBranch: "main" }), signal);
  return investigate({ text, session, inspector: new RepositoryInspector(session), index, startEvidenceNumber: 1, signal });
}

// The observed false positive: verifySecondaryOTP protects a DIFFERENT flow (mobile change); PATCH /user never reaches it.
const OTHER_FLOW: Record<string, string> = {
  "backend/src/auth/otp.service.ts": "export function verifySecondaryOTP(id: string, otp: string) {\n  return otp.length === 6;\n}\n",
  "backend/src/auth/mobile.controller.ts": 'import { verifySecondaryOTP } from "./otp.service";\nexport async function changeMobileHandler(req: any) {\n  verifySecondaryOTP(req.user, req.body.otp);\n}\n',
  "backend/src/auth/mobile.routes.ts": 'import { changeMobileHandler } from "./mobile.controller";\nrouter.post("/change-mobile", changeMobileHandler);\n',
  "backend/src/user/user.controller.ts": 'export async function updateMyProfileHandler(req: any) {\n  return { ok: true };\n}\n',
  "backend/src/user/user.routes.ts": 'import { updateMyProfileHandler } from "./user.controller";\nrouter.patch("/user", updateMyProfileHandler);\n',
};

test("regression: a validator on ANOTHER flow is MECHANISM_PRESENT but never flow evidence for PATCH /user", async () => {
  const { investigation: inv } = await run(OTHER_FLOW, "PATCH /user lets anyone change the login mobile number without OTP verification.");
  assert.notEqual(inv.signal, "IMPLEMENTATION_PRESENT");
  assert.equal(inv.behavior, "BEHAVIOR_UNVERIFIED");
  assert.equal(inv.flow?.status, "FLOW_NOT_ESTABLISHED", "the mechanism exists (MECHANISM_PRESENT) but the entry point never reaches it");
});

test("the same validator IS flow evidence once the reported entry point references it", async () => {
  const files = {
    ...OTHER_FLOW,
    "backend/src/user/user.controller.ts": 'import { verifySecondaryOTP } from "../auth/otp.service";\nexport async function updateMyProfileHandler(req: any) {\n  verifySecondaryOTP(req.user, req.body.otp);\n}\n',
  };
  const { investigation: inv } = await run(files, "PATCH /user lets anyone change the login mobile number without OTP verification.");
  assert.equal(inv.flow?.status, "FLOW_REFERENCE_PRESENT");
  assert.equal(inv.behavior, "BEHAVIOR_UNVERIFIED", "a static path is never behaviour");
  assert.match(inv.explanation, /not a proven call path/);
});

test("extraction: route chains, multi-line method signatures and body references", () => {
  const f = extractFile(
    "routes/user.routes.ts",
    'router.route("/user").get(list).patch(update);\nexport class S {\n  async requestOTP(\n    id: string,\n    n: number,\n  ): Promise<void> {\n    evaluateOtpThrottle(id);\n  }\n}\n',
  )!;
  assert.ok(f.routes.includes("PATCH /user"));
  const m = f.symbols.includes("requestOTP");
  assert.ok(m, "a multi-line-signature method is a symbol");
  assert.ok(f.refs?.requestOTP?.includes("evaluateOtpThrottle"));
  // A call spanning lines is NOT a declaration.
  assert.ok(!extractFile("a.ts", "class C {\n  run() {\n    foo(\n      1,\n    );\n  }\n}\n")!.symbols.includes("foo"));
});

test("entry point location: method and path parameters must match; a mount is not an endpoint; a named entry excludes inferred ones; one generic word never picks a route", async () => {
  const entriesFor = async (lines: string, text: string, subjectTerms: string[]) => {
    const files = {
      "backend/src/user/user.controller.ts": "export async function updateMyProfileHandler(req: any) {\n  return 1;\n}\nexport async function adminDeletePlanHandler(req: any) {\n  return 2;\n}\n",
      "backend/src/user/user.routes.ts": 'import { updateMyProfileHandler, adminDeletePlanHandler } from "./user.controller";\n' + lines,
    };
    const session = await fakeStructure(files, { revision: REV }).open({} as never, signal);
    const index = await buildRepositoryIndex(session, sourceKeyOf({ repoUrl: "r", defaultBranch: "main" }), signal);
    return locateEntries(index, { text, subjectTerms, mechanismNames: [], centralTerms: [] });
  };
  const text = "PATCH /user lets anyone change the login mobile number without OTP verification.";
  assert.deepEqual(await entriesFor('router.post("/user", updateMyProfileHandler);\n', text, []), [], "POST /user is not PATCH /user");
  assert.deepEqual(await entriesFor('router.patch("/:id", updateMyProfileHandler);\n', text, []), [], "PATCH /:id is not PATCH /user");
  assert.deepEqual(await entriesFor('router.use("/user", updateMyProfileHandler);\n', text, []), [], "router.use is a mount");
  const both = await entriesFor('router.patch("/user", updateMyProfileHandler);\nrouter.delete("/plans/:id", adminDeletePlanHandler);\n', text, ["plans", "delete"]);
  assert.deepEqual(both.map((e) => e.located), ["named_in_item"], "the named entry excludes inferred ones");
  assert.deepEqual(await entriesFor('router.use("/profile/delete", updateMyProfileHandler);\n', "A user can delete their profile.", ["profile", "delete"]), [], "a mount is never an inferred entry either");
  const generic = await entriesFor('router.delete("/plans/:id", adminDeletePlanHandler);\n', "A user can delete every profile on their account.", ["delete"]);
  assert.deepEqual(generic, [], "one generic action word does not pick an unrelated route");
});

test("flow tracing: the reference must reach the mechanism's own symbol, not just any symbol in its file", async () => {
  const files = {
    "backend/src/auth/otp.service.ts": "export function sendOTP(id: string) {\n  return id;\n}\nexport function verifySecondaryOTP(id: string, otp: string) {\n  return otp.length === 6;\n}\n",
    "backend/src/user/user.controller.ts": 'import { sendOTP } from "../auth/otp.service";\nexport async function updateMyProfileHandler(req: any) {\n  sendOTP(req.user);\n}\n',
    "backend/src/user/user.routes.ts": 'import { updateMyProfileHandler } from "./user.controller";\nrouter.patch("/user", updateMyProfileHandler);\n',
  };
  const { investigation: inv } = await run(files, "PATCH /user lets anyone change the login mobile number without OTP verification.");
  assert.equal(inv.flow?.status, "FLOW_NOT_ESTABLISHED", "the handler reaches sendOTP, not verifySecondaryOTP");
});
