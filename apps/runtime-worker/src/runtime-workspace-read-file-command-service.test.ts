import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeviceExecutionCommand,
  UnsignedDeviceExecutionCommand,
} from "@crewon/contracts";
import type { DeviceCommandSignInput } from "@crewon/device-dispatch";

import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import type {
  RuntimeWorkspaceBindingQuery,
  RuntimeWorkspaceBindingResolverPort,
} from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";
import {
  canonicalRuntimeWorkspaceReadFileIntent,
  RuntimeWorkspaceReadFileCommandService,
  type CanonicalRuntimeWorkspaceReadFileIntent,
} from "./runtime-workspace-read-file-command-service.ts";

test("freezes exact execution and current deployment authority into one signed read", async () => {
  const queries: RuntimeWorkspaceBindingQuery[] = [];
  const signed: DeviceCommandSignInput[] = [];
  const service = commandService({ queries, signed });
  const command = await service.produce(
    { authority: authority(), relativePathSegments: ["docs", "README.md"] },
    new AbortController().signal,
  );

  assert.deepEqual(queries, [bindingQuery()]);
  assert.deepEqual(command, signedCommand(signed[0]!.command));
  assert.deepEqual(command, {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: "lease-1",
    leaseEpoch: 4,
    expiresAt: "2026-08-11T16:10:00.000Z",
    runId: "run-frozen-1",
    stepId: "step-frozen-1",
    attemptId: "attempt-frozen-1",
    executionId: "execution-frozen-1",
    workspaceBindingId: "workspace-1",
    capability: "workspace.read_file.v0",
    actionDigest: command.actionDigest,
    arguments: {
      schemaVersion: "crewon.device-filesystem-read-arguments.v0",
      workspaceIncarnationId: "incarnation-1",
      relativePathSegments: ["docs", "README.md"],
      encoding: "utf8",
    },
    payloadRef: null,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 16_777_216,
    },
    idempotencyKey: `workspace-read:${command.actionDigest.slice(7)}`,
    traceContext: { traceparent: null, tracestate: null },
    authorization: authorization(),
  });
  assert.match(command.actionDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(signed[0]!.approvalProof, null);
  assert.equal("rawPath" in command.arguments, false);
  assert.equal("deviceId" in authority(), false);
  assert.equal("workspaceBindingId" in authority(), false);
});

test("adapts the signed read into a complete null-receipt durable reference", async () => {
  const frozen = await commandService().create(
    {
      tenantId: "tenant-1",
      spaceId: "space-1",
      threadId: "thread-1",
      expectedThreadRevision: 7,
      principalId: "principal-1",
      actorId: "actor-1",
      runId: "run-frozen-1",
      stepId: "step-frozen-1",
      attemptId: "attempt-frozen-1",
      executionId: "execution-frozen-1",
      leaseId: "lease-1",
      leaseEpoch: 4,
      expiresAt: "2026-08-11T16:10:00.000Z",
      idempotency: {
        scope: "workspace-read-file",
        key: "read-key-1",
        requestFingerprint: `sha256:${"a".repeat(64)}`,
      },
      relativePathSegments: ["docs", "README.md"],
    },
    new AbortController().signal,
  );

  assert.deepEqual(frozen.routeIntent, {
    deviceBindingId: "device-binding-1",
    runtimeBindingId: "runtime-binding-1",
  });
  assert.deepEqual(frozen.reference, {
    deviceId: "device-1",
    executionId: "execution-frozen-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    runtimeBindingId: "runtime-binding-1",
    actionDigest: frozen.command.actionDigest,
    commandDigest: frozen.reference.commandDigest,
    leaseId: "lease-1",
    leaseEpoch: 4,
    receiptId: null,
  });
  assert.match(frozen.reference.commandDigest, /^sha256:[a-f0-9]{64}$/u);
});

test("rejects stale Thread and malformed path before signing", async () => {
  let signs = 0;
  const service = commandService({
    resolver: {
      async resolve() {
        return null;
      },
    },
    signer: {
      async sign() {
        signs += 1;
        return assert.fail("not signed");
      },
    },
  });
  await assert.rejects(
    service.produce(
      { authority: authority(), relativePathSegments: ["README.md"] },
      new AbortController().signal,
    ),
    /runtime_workspace_binding_unavailable/,
  );
  await assert.rejects(
    service.produce(
      { authority: authority(), relativePathSegments: ["..", "secret"] },
      new AbortController().signal,
    ),
    /runtime_workspace_read_path_invalid/,
  );
  assert.equal(signs, 0);
});

test("aborts a pending Thread check and the final pre-sign boundary", async () => {
  let signs = 0;
  const signer = {
    async sign() {
      signs += 1;
      return assert.fail("not signed");
    },
  };
  const pendingController = new AbortController();
  const pending = commandService({
    resolver: {
      async resolve() {
        return new Promise(() => undefined);
      },
    },
    signer,
  }).produce(
    { authority: authority(), relativePathSegments: ["README.md"] },
    pendingController.signal,
  );
  pendingController.abort("caller gone");
  await assert.rejects(pending, /runtime_workspace_aborted/);

  const boundaryController = new AbortController();
  const boundary = commandService({
    resolver: {
      async resolve() {
        boundaryController.abort("lease lost");
        return binding();
      },
    },
    signer,
  });
  await assert.rejects(
    boundary.produce(
      { authority: authority(), relativePathSegments: ["README.md"] },
      boundaryController.signal,
    ),
    /runtime_workspace_aborted/,
  );
  assert.equal(signs, 0);

  const reason = new RuntimeWorkspaceError("runtime_workspace_lease_lost", {
    retryable: true,
  });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(reason);
  await assert.rejects(
    commandService().produce(
      { authority: authority(), relativePathSegments: ["README.md"] },
      alreadyAborted.signal,
    ),
    (error) => error === reason,
  );
});

test("fails closed when the signer changes frozen command authority", async () => {
  const service = commandService({
    signer: {
      async sign(input) {
        return signedCommand({ ...input.command, runId: "run-substituted" });
      },
    },
  });
  await assert.rejects(
    service.produce(
      { authority: authority(), relativePathSegments: ["README.md"] },
      new AbortController().signal,
    ),
    /runtime_workspace_read_signature_mismatch/,
  );
});

test("canonical digest binds device, runtime, policy, lease, capability, and limits", async () => {
  const digester = new NodeSha256ContentDigester();
  const base = canonicalReadIntent();
  const digest = (value: CanonicalRuntimeWorkspaceReadFileIntent) =>
    digester.sha256(canonicalRuntimeWorkspaceReadFileIntent(value));
  const baseDigest = digest(base);
  const variants: CanonicalRuntimeWorkspaceReadFileIntent[] = [
    { ...base, leaseEpoch: base.leaseEpoch + 1 },
    { ...base, expiresAt: "2026-08-11T16:11:00.000Z" },
    {
      ...base,
      binding: { ...base.binding, deviceBindingId: "device-binding-2" },
    },
    { ...base, binding: { ...base.binding, deviceId: "device-2" } },
    {
      ...base,
      binding: { ...base.binding, runtimeBindingId: "runtime-binding-2" },
    },
    { ...base, policySnapshotId: "policy-2" },
    { ...base, limits: { ...base.limits, maxOutputBytes: 32_768 } },
  ];
  assert.deepEqual(
    variants.map(digest).map((value) => value === baseDigest),
    variants.map(() => false),
  );

  const signed: DeviceCommandSignInput[] = [];
  const command = await commandService({ signed }).produce(
    { authority: authority(), relativePathSegments: ["docs", "README.md"] },
    new AbortController().signal,
  );
  assert.equal(command.actionDigest, baseDigest);
  assert.equal(signed[0]!.command.actionDigest, baseDigest);
  assert.deepEqual(signed[0]!.command.limits, base.limits);
  assert.equal(signed[0]!.command.deviceId, base.binding.deviceId);
  assert.equal(
    signed[0]!.command.workspaceBindingId,
    base.binding.workspaceBindingId,
  );
});

function commandService(
  overrides: Partial<{
    resolver: RuntimeWorkspaceBindingResolverPort;
    signer: {
      sign(input: DeviceCommandSignInput): Promise<DeviceExecutionCommand>;
    };
    queries: RuntimeWorkspaceBindingQuery[];
    signed: DeviceCommandSignInput[];
  }> = {},
): RuntimeWorkspaceReadFileCommandService {
  return new RuntimeWorkspaceReadFileCommandService({
    bindings: overrides.resolver ?? {
      async resolve(query) {
        overrides.queries?.push(query);
        return binding();
      },
    },
    signer: overrides.signer ?? {
      async sign(input) {
        overrides.signed?.push(input);
        return signedCommand(input.command);
      },
    },
    digester: new NodeSha256ContentDigester(),
  });
}

function authority() {
  return {
    ...bindingQuery(),
    runId: "run-frozen-1",
    stepId: "step-frozen-1",
    attemptId: "attempt-frozen-1",
    executionId: "execution-frozen-1",
    leaseId: "lease-1",
    leaseEpoch: 4,
    expiresAt: "2026-08-11T16:10:00.000Z",
  };
}

function bindingQuery(): RuntimeWorkspaceBindingQuery {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 7,
    principalId: "principal-1",
    actorId: "actor-1",
  };
}

function binding() {
  return {
    ...bindingQuery(),
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
  };
}

function signedCommand(
  command: Omit<DeviceExecutionCommand, "authorization">,
): DeviceExecutionCommand {
  const unsigned: UnsignedDeviceExecutionCommand = {
    ...command,
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "key-1",
      issuedAt: "2026-08-11T16:00:00.000Z",
      expiresAt: "2026-08-11T16:05:00.000Z",
      approvalProof: null,
    },
  };
  return { ...unsigned, authorization: authorization() };
}

function authorization() {
  return {
    schemaVersion: "crewon.device-authorization.v0" as const,
    scheme: "ed25519" as const,
    keyId: "key-1",
    issuedAt: "2026-08-11T16:00:00.000Z",
    expiresAt: "2026-08-11T16:05:00.000Z",
    approvalProof: null,
    signature: "A".repeat(86),
  };
}

function canonicalReadIntent(): CanonicalRuntimeWorkspaceReadFileIntent {
  return {
    schemaVersion: "crewon.runtime-workspace-read-file-action.v0",
    ...bindingQuery(),
    runId: "run-frozen-1",
    stepId: "step-frozen-1",
    attemptId: "attempt-frozen-1",
    executionId: "execution-frozen-1",
    leaseId: "lease-1",
    leaseEpoch: 4,
    expiresAt: "2026-08-11T16:10:00.000Z",
    binding: {
      workspaceBindingId: "workspace-1",
      incarnationId: "incarnation-1",
      deviceBindingId: "device-binding-1",
      deviceId: "device-1",
      runtimeBindingId: "runtime-binding-1",
    },
    policySnapshotId: "policy-1",
    capability: "workspace.read_file.v0",
    relativePathSegments: ["docs", "README.md"],
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 16_777_216,
    },
  };
}
