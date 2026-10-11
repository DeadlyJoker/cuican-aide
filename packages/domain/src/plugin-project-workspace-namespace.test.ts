import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePluginProjectWorkspaceNamespace,
  parsePluginProjectWorkspaceOwnerScope,
  pluginProjectWorkspaceIdentityInput,
} from "./plugin-project-workspace-namespace.ts";

const body = {
  schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
  owner: {
    tenantId: "tenant-a",
    spaceId: "space-a",
    principalId: "principal-a",
    actorId: "actor-a",
    profileId: "profile-a",
    pluginId: "example.project",
    publisherId: "example.publisher",
    projectId: "project-a",
  },
  workspaceId: "workspace-opaque",
  createdAt: "2026-10-11T00:00:00.000Z",
};
test("workspace identity preserves original Native owner bytes in a fixed field order", () => {
  const original = JSON.stringify([
    "tenant-a",
    "space-a",
    "principal-a",
    "actor-a",
    "profile-a",
    "example.project",
    "example.publisher",
    "project-a",
  ]);
  assert.equal(pluginProjectWorkspaceIdentityInput(body.owner), original);
  const reversed = Object.fromEntries(
    Object.entries(body.owner).reverse(),
  ) as typeof body.owner;
  assert.equal(pluginProjectWorkspaceIdentityInput(reversed), original);
  for (const field of Object.keys(body.owner) as (keyof typeof body.owner)[]) {
    const value = { ...body.owner, [field]: `other.${field.toLowerCase()}` };
    assert.notEqual(pluginProjectWorkspaceIdentityInput(value), original);
  }
  assert.throws(() =>
    pluginProjectWorkspaceIdentityInput({
      ...body.owner,
      root: "/tmp/other",
    } as typeof body.owner),
  );
});
test("namespace is a bounded, stable opaque ownership record independent of package selection", () => {
  const value = parsePluginProjectWorkspaceNamespace(body);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), body);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.owner));
  const { projectId: _p, ...scope } = body.owner;
  assert.deepEqual(parsePluginProjectWorkspaceOwnerScope(scope), scope);
  assert.throws(() =>
    parsePluginProjectWorkspaceNamespace({
      ...body,
      owner: { ...body.owner, version: "1.0.0" },
    }),
  );
  assert.throws(() =>
    parsePluginProjectWorkspaceNamespace({
      ...body,
      owner: { ...body.owner, packageDigest: `sha256:${"a".repeat(64)}` },
    }),
  );
  assert.throws(() =>
    parsePluginProjectWorkspaceNamespace({ ...body, rootPath: "/tmp/project" }),
  );
  for (const workspaceId of [
    null,
    "",
    "/tmp/project",
    "../project",
    "file:///tmp/project",
    "a".repeat(257),
  ])
    assert.throws(() =>
      parsePluginProjectWorkspaceNamespace({ ...body, workspaceId }),
    );
  assert.throws(() =>
    parsePluginProjectWorkspaceNamespace({
      ...body,
      schemaVersion: "crewon.plugin-project-workspace-namespace.v0",
    }),
  );
  let reads = 0;
  const accessor = Object.defineProperty({ ...body }, "owner", {
    enumerable: true,
    get() {
      reads++;
      return body.owner;
    },
  });
  assert.throws(() => parsePluginProjectWorkspaceNamespace(accessor));
  assert.equal(reads, 0);
});
