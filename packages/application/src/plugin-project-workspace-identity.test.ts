import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { pluginProjectWorkspaceId } from "./plugin-project-workspace-identity.ts";
import { ApplicationError } from "./application-error.ts";

const owner = {
  tenantId: "tenant-a",
  spaceId: "space-a",
  principalId: "principal-a",
  actorId: "actor-a",
  profileId: "profile-a",
  pluginId: "example.project",
  publisherId: "example.publisher",
  projectId: "project-a",
};
test("injected hashing preserves persisted workspace identity bytes and owner isolation", () => {
  const bytes = JSON.stringify([
    "tenant-a",
    "space-a",
    "principal-a",
    "actor-a",
    "profile-a",
    "example.project",
    "example.publisher",
    "project-a",
  ]);
  const legacy = `workspace-project-${createHash("sha256").update(bytes).digest("hex")}`;
  const digester = {
    sha256: (input: string) =>
      `sha256:${createHash("sha256").update(input).digest("hex")}`,
  };
  assert.equal(pluginProjectWorkspaceId(owner, digester), legacy);
  assert.equal(
    pluginProjectWorkspaceId(
      Object.fromEntries(Object.entries(owner).reverse()) as typeof owner,
      digester,
    ),
    legacy,
  );
  for (const key of Object.keys(owner) as (keyof typeof owner)[])
    assert.notEqual(
      pluginProjectWorkspaceId(
        { ...owner, [key]: `other.${key.toLowerCase()}` },
        digester,
      ),
      legacy,
    );
});
test("invalid digest adapters cannot create a persisted workspace identifier", () => {
  for (const digest of [
    "",
    "other",
    `sha256:${"A".repeat(64)}`,
    "sha256:short",
  ])
    assert.throws(
      () => pluginProjectWorkspaceId(owner, { sha256: () => digest }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "plugin_project_workspace_digest_invalid",
    );
});
