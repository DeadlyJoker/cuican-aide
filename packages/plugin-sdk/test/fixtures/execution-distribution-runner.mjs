import assert from "node:assert/strict";
import {
  parsePluginNodeDefinition,
  CREWON_EXECUTION_SERVICE,
  CREWON_EXECUTION_API_VERSION,
} from "@crewon/plugin-sdk/node";
import {
  CREWON_EXECUTION_SERVICE as ContractsService,
  CREWON_EXECUTION_API_VERSION as ContractsVersion,
} from "@crewon/plugin-sdk/contracts";
import plugin, {
  contexts,
  signals,
  events,
  requiredServiceNames,
} from "./dist/external-execution-node.js";

const identity = Object.freeze({
  pluginId: "example.execution",
  version: "0.1.0",
  packageDigest: `sha256:${"c".repeat(64)}`,
});
const callbacks = [];
let factory;
await parsePluginNodeDefinition(plugin).setup(
  Object.freeze({
    identity,
    services: Object.freeze({
      get(service, version) {
        assert.equal(service, CREWON_EXECUTION_SERVICE);
        assert.equal(version, CREWON_EXECUTION_API_VERSION);
        return {
          register(value) {
            factory = value;
            return {
              dispose() {
                factory = undefined;
              },
            };
          },
        };
      },
      provide() {
        throw new Error("execution registration is host-owned");
      },
    }),
    onDispose(callback) {
      callbacks.push(callback);
    },
  }),
);
assert.equal(ContractsService, "crewon.execution");
assert.equal(ContractsVersion, "1");
assert.ok(factory);
assert.deepEqual(requiredServiceNames, ["externalOperations", "jsonHttp"]);
assert.deepEqual(factory.requiredServices, []);
const digest = `sha256:${"d".repeat(64)}`;
const context = Object.freeze({
  identity,
  scope: Object.freeze({
    tenantId: "tenant",
    spaceId: "space",
    profileId: "profile",
  }),
  run: Object.freeze({
    runId: "run",
    threadId: "thread",
    bindingDigest: digest,
    inputDigest: digest,
    source: null,
  }),
  configuration: Object.freeze({
    revision: 1,
    contentDigest: digest,
    parameters: Object.freeze({ prompt: "fixture" }),
    credentialBindings: Object.freeze([]),
  }),
  target: Object.freeze({
    executionAuthority: "crewonKernel",
    agentVersionId: "agent",
    agentVersionContentDigest: digest,
    materializationDigest: digest,
    authorityId: "authority",
    runtimeGeneration: "generation",
    policySnapshotId: "policy",
    workspaceBindingId: null,
  }),
});
const runtime = await factory.create(context);
assert.equal(contexts[0], context);
assert.equal(runtime.canRetire(), true);
assert.equal(runtime.definitions()[0].name, "fixture_echo");
assert.equal(
  runtime.executionPolicy("function", "fixture_echo").recovery,
  "replaySafe",
);
assert.equal(runtime.executionPolicy("function", "missing"), null);
const command = Object.freeze({
  schemaVersion: "crewon.tool-invocation.v0",
  idempotencyKey: "key",
  runId: "run",
  segmentId: "segment",
  callId: "call",
  kind: "function",
  name: "fixture_echo",
  input: "fixture-output",
  executionId: "execution",
  executionLease: Object.freeze({
    workItemId: "item",
    stepId: "step",
    attemptId: "attempt",
    leaseId: "lease",
    leaseEpoch: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
  }),
  actionDigest: digest,
  actionIntent: Object.freeze({
    schemaVersion: "crewon.action-intent.v0",
    runId: "run",
    segmentId: "segment",
    callId: "call",
    tool: Object.freeze({
      kind: "function",
      name: "fixture_echo",
      inputDigest: digest,
    }),
    policySnapshotId: "policy",
    workspaceBindingId: null,
    ...runtime.executionPolicy("function", "fixture_echo"),
  }),
  approvalProof: null,
});
const controller = new AbortController();
const reservation = runtime.reserveExecution(command, controller.signal, {
  resultOwner: { tenantId: "tenant" },
});
const completed = await reservation.execute();
assert.equal(signals[0], controller.signal);
assert.equal(completed.result.output, "fixture-output");
assert.equal(runtime.canRetire(), false);
assert.deepEqual(
  await runtime.reconcile(command, controller.signal),
  completed,
);
assert.equal(events.filter((event) => event === "execute:execution").length, 1);
assert.deepEqual(runtime.readRetainedExecutionResult(command), completed);
assert.deepEqual(runtime.cancelRetainedExecution(command), completed);
assert.equal(
  runtime.retainedExecutionResults({ runId: "other-run", limit: 1 }).length,
  0,
);
assert.equal(
  runtime.scanRetainedExecutionResults({ limit: 1 })[0].tenantId,
  "tenant",
);
assert.equal(
  runtime.acknowledgeExecutionResult({
    ...command,
    status: completed.status,
    providerReceiptId: completed.providerReceiptId,
  }),
  true,
);
assert.equal(runtime.readRetainedExecutionResult(command), null);
assert.equal(runtime.canRetire(), true);
reservation.release();
await assert.rejects(reservation.execute(), /fixture_reservation_released/);
const missing = { ...command, executionId: "missing", callId: "missing-call" };
assert.equal(
  (await runtime.reconcile(missing, controller.signal)).status,
  "unknownOutcome",
);
assert.equal(
  (await runtime.cancel(missing, controller.signal)).status,
  "canceled",
);
assert.equal(events.includes("execute:missing"), false);
const waiting = runtime.execute(
  { ...command, executionId: "aborted", input: "await-abort" },
  controller.signal,
);
assert.equal(runtime.canRetire(), false);
const aborted = assert.rejects(waiting, (error) => error === reason);
const reason = new Error("native-signal-revoked");
controller.abort(reason);
await aborted;
assert.equal(signals[1], controller.signal);
assert.equal(runtime.canRetire(), true);
await assert.rejects(
  runtime.execute(command, controller.signal),
  (error) => error === reason,
);
await runtime.close();
assert.equal(runtime.canRetire(), false);
for (const callback of callbacks.reverse()) await callback();
assert.equal(factory, undefined);
console.log(
  "Execution factory ABI compiled Node-only and invoked with native cancellation, reconciliation and retained-result lifecycle through the isolated installed SDK.",
);
