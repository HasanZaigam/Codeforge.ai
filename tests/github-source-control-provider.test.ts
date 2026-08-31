import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubSourceControlProvider } from "../src/source-control/github-source-control-provider.js";
import type { GitHubCredentialRepository } from "../src/persistence/repositories/github-credential-repository.js";
import type { Project } from "../src/domain/types.js";

import { encryptSecret } from "../src/auth/credential-encryption.js";

// Mock credential repository to return a known token
const testKey = Buffer.alloc(32);
const mockCredentials = {
  findByUserId: (userId: string) => {
    return { secret: encryptSecret("ghp_testtoken123", testKey) };
  },
  touch: () => {}
} as unknown as GitHubCredentialRepository;

// Mock encryption key resolver
const mockEncryptionKey = () => testKey;

test("resolveCloneCredential issues a Basic auth header, not a Bearer token (which Git over HTTPS rejects)", async () => {
  const provider = new GitHubSourceControlProvider(mockCredentials, mockEncryptionKey);
  const project = { ownerId: "user-1" } as Project;
  const credential = await provider.resolveCloneCredential(project, new AbortController().signal);
  
  const expectedBasic = Buffer.from("x-access-token:ghp_testtoken123").toString("base64");
  assert.equal(credential.header, `Authorization: Basic ${expectedBasic}`);
  assert.ok(!credential.header.includes("Bearer"));
});
