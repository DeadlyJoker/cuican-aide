import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionRunBinding } from "@crewon/domain";
import { CurrentExtensionExecutionAuthorization } from "./extension-execution-authorization.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";

const actor: ActorContext = {
  principalId: "current-principal",
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
};
const digest = `sha256:${"a".repeat(64)}`;
const binding: ExtensionRunBinding = {
  schemaVersion: "crewon.extension-run-binding.v0",
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  actorId: actor.actorId,
  pluginId: "crewon.comfyui-krea2",
  runId: "run-1",
  threadId: "thread-1",
  configurationRevision: 1,
  configurationDigest: digest,
  target: {
    executionAuthority: "crewonKernel",
    agentVersionId: "agent-1",
    agentVersionContentDigest: digest,
    materializationDigest: digest,
    authorityId: "authority-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  },
  inputDigest: digest,
  bindingDigest: digest,
  source: null,
};
const request = () => ({
  binding: structuredClone(binding),
  source: null,
  action: "submit" as const,
  signal: new AbortController().signal,
});

test("background execution resolves the current principal for every call and fails closed on missing/mismatched identity", async () => {
  const checked: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  let identity: ActorContext | null = actor;
  const access = new CurrentExtensionExecutionAuthorization({
    resolveActor: async (owner) => {
      assert.deepEqual(owner, {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        actorId: actor.actorId,
      });
      return identity;
    },
    authorization: {
      authorize: async (value) => {
        checked.push(value);
        return { outcome: "allow" };
      },
    },
  });
  assert.deepEqual(await access.authorize(request()), { outcome: "allow" });
  identity = { ...actor, principalId: "rotated-principal" };
  assert.deepEqual(
    await access.authorize({ ...request(), action: "observe" }),
    { outcome: "allow" },
  );
  assert.deepEqual(
    checked.map((value) => value.action),
    ["run:execute", "extension:run", "run:execute", "extension:query"],
  );
  assert.equal(checked[2]!.actor.principalId, "rotated-principal");
  for (const value of [
    null,
    { ...actor, tenantId: "other" },
    { ...actor, spaceId: "other" },
    { ...actor, actorId: "other" },
    { ...actor, principalId: "" },
  ]) {
    identity = value;
    assert.deepEqual(await access.authorize(request()), {
      outcome: "deny",
      reasonCode: "extension_execution_identity_unavailable",
    });
  }
  assert.equal(checked.length, 4);
});

test("query access requires the original Run permission; invalid source or generation from a query is denied", async () => {
  const source = structuredClone(binding);
  const query = {
    ...binding,
    runId: "query-run",
    threadId: "query-thread",
    source: {
      runId: source.runId,
      bindingDigest: source.bindingDigest,
      operationId: "00000000-0000-0000-0000-000000000000",
    },
  };
  const checked: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const access = new CurrentExtensionExecutionAuthorization({
    resolveActor: async () => actor,
    authorization: {
      authorize: async (value) => {
        checked.push(value);
        return value.action === "run:read"
          ? { outcome: "deny", reasonCode: "owner_revoked" }
          : { outcome: "allow" };
      },
    },
  });
  const input = {
    ...request(),
    binding: query,
    source,
    action: "observe" as const,
  };
  assert.deepEqual(await access.authorize(input), {
    outcome: "deny",
    reasonCode: "extension_execution_access_denied",
  });
  assert.deepEqual(
    checked.map((value) => value.action),
    ["run:execute", "extension:query", "run:read"],
  );
  assert.equal(checked[2]!.resource.kind, "run");
  assert.deepEqual(checked[2]!.resource, {
    kind: "run",
    tenantId: source.tenantId,
    spaceId: source.spaceId,
    threadId: source.threadId,
    runId: source.runId,
  });
  for (const invalid of [
    { ...input, source: null },
    { ...input, action: "submit" as const },
    { ...input, source: { ...source, tenantId: "other" } },
    { ...input, source: { ...source, spaceId: "other" } },
    { ...input, source: { ...source, pluginId: "other.plugin" } },
    { ...input, source: { ...source, runId: "other-run" } },
    {
      ...input,
      source: { ...source, bindingDigest: `sha256:${"b".repeat(64)}` },
    },
    { ...input, source: query },
  ])
    assert.deepEqual(await access.authorize(invalid), {
      outcome: "deny",
      reasonCode: "extension_query_source_invalid",
    });
  assert.equal(checked.length, 3);
});

test("denial and cancellation stop subsequent authorization calls", async () => {
  const controller = new AbortController();
  let calls = 0;
  const access = new CurrentExtensionExecutionAuthorization({
    resolveActor: async () => actor,
    authorization: {
      authorize: async () => {
        calls++;
        return { outcome: "deny", reasonCode: "run_revoked" };
      },
    },
  });
  assert.equal((await access.authorize(request())).outcome, "deny");
  assert.equal(calls, 1);
  controller.abort(new Error("test_canceled"));
  await assert.rejects(
    access.authorize({ ...request(), signal: controller.signal }),
    /test_canceled/,
  );
  assert.equal(calls, 1);
  const duringResolution = new AbortController();
  const canceled = new CurrentExtensionExecutionAuthorization({
    resolveActor: async () => {
      duringResolution.abort(new Error("resolution_canceled"));
      return actor;
    },
    authorization: { authorize: async () => assert.fail("must not authorize") },
  });
  await assert.rejects(
    canceled.authorize({ ...request(), signal: duringResolution.signal }),
    /resolution_canceled/,
  );
});

test("caller mutations during asynchronous identity lookup cannot change the resource being authorized", async () => {
  const input = request();
  let resolveActor!: (value: ActorContext) => void;
  const ready = new Promise<ActorContext>((resolve) => {
    resolveActor = resolve;
  });
  const checked: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const access = new CurrentExtensionExecutionAuthorization({
    resolveActor: async () => ready,
    authorization: {
      authorize: async (value) => {
        checked.push(value);
        return { outcome: "allow" };
      },
    },
  });
  const pending = access.authorize(input);
  Object.assign(input.binding, {
    runId: "other-run",
    tenantId: "other-tenant",
  });
  resolveActor(actor);
  assert.deepEqual(await pending, { outcome: "allow" });
  assert.deepEqual(checked[0]!.resource, {
    kind: "run",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    threadId: "thread-1",
    runId: "run-1",
  });
});
