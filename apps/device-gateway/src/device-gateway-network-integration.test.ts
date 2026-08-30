import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CrewONAgentKernel, type ModelRequest } from "@crewon/agent-kernel";
import {
  RunApplicationService,
  RunExecutionService,
  ThreadApplicationService,
  ToolApprovalApplicationService,
  type ActorContext,
  type RunRoute,
} from "@crewon/application";
import {
  DEVICE_PROTOCOL_VERSION,
  parseDeviceExecutionAck,
  parseDeviceExecutionCancel,
  parseDeviceExecutionCommand,
  type DeviceExecutionCommand,
  type DeviceExecutionEvent,
} from "@crewon/contracts";
import {
  DeviceToolRuntime,
  Ed25519DeviceCommandSigner,
  HttpsDeviceDispatchClient,
} from "@crewon/device-dispatch";
import {
  NodeSha256ContentDigester,
  PinnedRunExecutionPolicy,
  RuntimeWorker,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "@crewon/runtime-worker";
import { InMemoryRunStore } from "@crewon/store";
import WebSocket, { type RawData } from "ws";

import { Ed25519DeviceCommandAuthorizationVerifier } from "./device-command-authorization-verifier.ts";
import { DeviceGatewayServer } from "./device-gateway-server.ts";
import { MtlsDeviceIdentityVerifier } from "./mtls-device-identity-verifier.ts";
import {
  TEST_CA_CERT,
  TEST_DEVICE_CERT,
  TEST_DEVICE_KEY,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
  TEST_WORKER_CERT,
  TEST_WORKER_KEY,
} from "./mtls-test-certificates.test-support.ts";
import { MtlsWorkerIdentityVerifier } from "./mtls-worker-identity-verifier.ts";
import { SqliteDeviceDispatchStore } from "./sqlite-device-dispatch-store.ts";

const now = () => new Date("2026-08-09T00:00:00.000Z");
const route: RunRoute = {
  authorityId: "authority-1",
  runtimeGeneration: "ts-v0",
  agentVersionId: "agent-version-1",
  policySnapshotId: "policy-1",
  workspaceBindingId: "workspace-1",
};

test("executes over real mTLS HTTPS/WSS and replays receipt after Gateway restart", async (context) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "crewon-device-network-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "gateway.sqlite");
  const commandKeys = generateKeyPairSync("ed25519");
  const signer = new Ed25519DeviceCommandSigner({
    keyId: "control-key-1",
    privateKey: commandKeys.privateKey,
    now,
    authorizationTtlMs: 60_000,
  });
  const command = await signer.sign({
    command: commandDraft(),
    approvalProof: null,
  });

  const first = await openGateway(databasePath, commandKeys.publicKey);
  const device = await connectDevice(first.port);
  const client = workerClient(first.port);
  try {
    assert.deepEqual(
      await client.execute(command, new AbortController().signal),
      {
        status: "completed",
        executionId: "execution-1",
        providerReceiptId: "receipt-1",
        output: "device output",
        artifactRef: null,
      },
    );
  } finally {
    await client.close();
    await first.server.close();
    device.terminate();
  }

  const restarted = await openGateway(databasePath, commandKeys.publicKey);
  const replayClient = workerClient(restarted.port);
  try {
    assert.deepEqual(
      await replayClient.reconcile(command, new AbortController().signal),
      {
        status: "completed",
        executionId: "execution-1",
        providerReceiptId: "receipt-1",
        output: "device output",
        artifactRef: null,
      },
    );
  } finally {
    await replayClient.close();
    await restarted.server.close();
  }
});

test("recovers one acknowledged side effect over real mTLS WSS and persists its terminal receipt", async (context) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "crewon-device-recovery-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "gateway.sqlite");
  const commandKeys = generateKeyPairSync("ed25519");
  const signer = new Ed25519DeviceCommandSigner({
    keyId: "control-key-1",
    privateKey: commandKeys.privateKey,
    now,
    authorizationTtlMs: 60_000,
  });
  const command = await signer.sign({
    command: commandDraft(),
    approvalProof: null,
  });
  const first = await openGateway(databasePath, commandKeys.publicKey);
  const client = workerClient(first.port);
  let sideEffectStarts = 0;
  let replayedCommands = 0;
  const interruptedDevice = await connectInterruptedDevice(first.port, () => {
    sideEffectStarts += 1;
  });
  try {
    assert.deepEqual(
      await client.execute(command, new AbortController().signal),
      {
        status: "unknownOutcome",
        executionId: "execution-1",
        providerReceiptId: "receipt-1",
      },
    );
    assert.equal(sideEffectStarts, 1);
  } finally {
    await client.close();
    interruptedDevice.terminate();
    await first.server.close();
  }

  const recovering = await openGateway(databasePath, commandKeys.publicKey);
  const recoveryClient = workerClient(recovering.port);
  const resumedDevice = await connectResumingDevice(
    recovering.port,
    command,
    () => {
      replayedCommands += 1;
    },
  );
  try {
    assert.deepEqual(
      await recoveryClient.reconcile(command, new AbortController().signal),
      {
        status: "completed",
        executionId: "execution-1",
        providerReceiptId: "receipt-1",
        output: "device output",
        artifactRef: null,
      },
    );
    assert.equal(sideEffectStarts, 1);
    assert.equal(replayedCommands, 1);
  } finally {
    await recoveryClient.close();
    resumedDevice.terminate();
    await recovering.server.close();
  }

  const restarted = await openGateway(databasePath, commandKeys.publicKey);
  const replayClient = workerClient(restarted.port);
  try {
    assert.deepEqual(
      await replayClient.reconcile(command, new AbortController().signal),
      {
        status: "completed",
        executionId: "execution-1",
        providerReceiptId: "receipt-1",
        output: "device output",
        artifactRef: null,
      },
    );
    assert.equal(sideEffectStarts, 1);
  } finally {
    await replayClient.close();
    await restarted.server.close();
  }
});

test("cancels an acknowledged unknown side effect over real mTLS WSS before terminalizing it", async (context) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "crewon-device-cancel-recovery-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "gateway.sqlite");
  const commandKeys = generateKeyPairSync("ed25519");
  const signer = new Ed25519DeviceCommandSigner({
    keyId: "control-key-1",
    privateKey: commandKeys.privateKey,
    now,
    authorizationTtlMs: 60_000,
  });
  const command = await signer.sign({
    command: commandDraft(),
    approvalProof: null,
  });
  const gateway = await openGateway(databasePath, commandKeys.publicKey);
  const client = workerClient(gateway.port);
  let sideEffectStarts = 0;
  let replayedCommands = 0;
  const interruptedDevice = await connectInterruptedDevice(gateway.port, () => {
    sideEffectStarts += 1;
  });
  let cancelingDevice: WebSocket | null = null;
  try {
    assert.equal(
      (await client.execute(command, new AbortController().signal)).status,
      "unknownOutcome",
    );
    cancelingDevice = await connectCancelingDevice(
      gateway.port,
      command,
      () => {
        replayedCommands += 1;
      },
    );
    assert.deepEqual(
      await client.cancel(command, new AbortController().signal),
      {
        status: "canceled",
        executionId: "execution-1",
        providerReceiptId: "receipt-1",
      },
    );
    assert.equal(sideEffectStarts, 1);
    assert.equal(replayedCommands, 1);
  } finally {
    await client.close();
    interruptedDevice.terminate();
    cancelingDevice?.terminate();
    await gateway.server.close();
  }

  const restarted = await openGateway(databasePath, commandKeys.publicKey);
  const replayClient = workerClient(restarted.port);
  try {
    assert.deepEqual(
      await replayClient.reconcile(command, new AbortController().signal),
      {
        status: "canceled",
        executionId: "execution-1",
        providerReceiptId: "receipt-1",
      },
    );
  } finally {
    await replayClient.close();
    await restarted.server.close();
  }
});

test("completes an approved RuntimeWorker Device Tool over the real network", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "crewon-device-run-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const commandKeys = generateKeyPairSync("ed25519");
  const runtimeNow = () => new Date();
  const gateway = await openGateway(
    path.join(directory, "gateway.sqlite"),
    commandKeys.publicKey,
    runtimeNow,
  );
  const device = await connectDevice(gateway.port);
  const dispatch = workerClient(gateway.port);
  const signer = new Ed25519DeviceCommandSigner({
    keyId: "control-key-1",
    privateKey: commandKeys.privateKey,
    now: runtimeNow,
    authorizationTtlMs: 60_000,
  });
  const signedCommands: DeviceExecutionCommand[] = [];
  const toolRuntime = createNetworkDeviceToolRuntime(
    dispatch,
    signer,
    signedCommands,
  );
  const fixture = await createRuntimeFixture(toolRuntime);
  try {
    assert.equal((await fixture.worker.wake()).kind, "waitingApproval");
    await approvePendingDeviceTool(fixture, "approve-device-1");

    assert.deepEqual(await fixture.worker.wake(), {
      kind: "completed",
      runId: fixture.runId,
    });
    assert.equal(signedCommands.length, 1);
    assert.deepEqual(
      (
        await fixture.store.listMessages(
          { tenantId: actor().tenantId, threadId: fixture.threadId },
          0,
          10,
        )
      ).map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "write through Device" },
        { role: "assistant", content: "runtime done" },
      ],
    );
    assert.deepEqual(fixture.modelRequests[1]?.input.items.at(-1), {
      type: "tool_result",
      kind: "function",
      callId: "device-call-1",
      output: "device output",
    });
  } finally {
    await fixture.worker.close();
    await fixture.store.close();
    await toolRuntime.close();
    await gateway.server.close();
    device.terminate();
  }
});

test("samples again after a signed raw workspace read crosses the authenticated Gateway", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "crewon-device-raw-read-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const commandKeys = generateKeyPairSync("ed25519");
  const runtimeNow = () => new Date();
  const gateway = await openGateway(
    path.join(directory, "gateway.sqlite"),
    commandKeys.publicKey,
    runtimeNow,
  );
  const device = await connectDevice(gateway.port);
  const dispatch = workerClient(gateway.port);
  const signer = new Ed25519DeviceCommandSigner({
    keyId: "control-key-1",
    privateKey: commandKeys.privateKey,
    now: runtimeNow,
    authorizationTtlMs: 60_000,
  });
  const signedCommands: DeviceExecutionCommand[] = [];
  const toolRuntime = createNetworkDeviceToolRuntime(
    dispatch,
    signer,
    signedCommands,
    "rawRead",
  );
  const fixture = await createRuntimeFixture(toolRuntime, "rawRead");
  try {
    assert.deepEqual(await fixture.worker.wake(), {
      kind: "completed",
      runId: fixture.runId,
    });
    assert.equal(fixture.modelRequests.length, 2);
    assert.deepEqual(fixture.modelRequests[1]?.input.items.at(-1), {
      type: "tool_result",
      kind: "function",
      callId: "device-call-1",
      output: "device output",
    });
    const command = signedCommands[0];
    assert.ok(command !== undefined);
    assert.equal(command.capability, "workspace.read_file.raw_tool.v0");
    assert.equal(command.workspaceBindingId, route.workspaceBindingId);
    assert.deepEqual(command.arguments, rawReadArguments());
    assert.match(command.leaseId, /.+/u);
    assert.equal(command.leaseEpoch, 1);
    assert.equal(command.authorization.keyId, "control-key-1");
  } finally {
    await fixture.worker.close();
    await fixture.store.close();
    await toolRuntime.close();
    await gateway.server.close();
    device.terminate();
  }
});

test("moves a real RuntimeWorker mutation through unknown, reconnect reconciliation and completion", async (context) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "crewon-device-worker-recovery-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const commandKeys = generateKeyPairSync("ed25519");
  const runtimeNow = () => new Date();
  const gateway = await openGateway(
    path.join(directory, "gateway.sqlite"),
    commandKeys.publicKey,
    runtimeNow,
  );
  const dispatch = workerClient(gateway.port);
  const signer = new Ed25519DeviceCommandSigner({
    keyId: "control-key-1",
    privateKey: commandKeys.privateKey,
    now: runtimeNow,
    authorizationTtlMs: 60_000,
  });
  const signedCommands: DeviceExecutionCommand[] = [];
  const toolRuntime = createNetworkDeviceToolRuntime(
    dispatch,
    signer,
    signedCommands,
  );
  const fixture = await createRuntimeFixture(toolRuntime);
  let sideEffectStarts = 0;
  let replayedCommands = 0;
  const interruptedDevice = await connectInterruptedDevice(gateway.port, () => {
    sideEffectStarts += 1;
  });
  let resumedDevice: WebSocket | null = null;
  try {
    assert.equal((await fixture.worker.wake()).kind, "waitingApproval");
    await approvePendingDeviceTool(fixture, "approve-recovering-device-1");

    assert.deepEqual(await fixture.worker.wake(), {
      kind: "retried",
      runId: fixture.runId,
      code: "tool_outcome_unknown",
    });
    assert.equal(sideEffectStarts, 1);
    assert.equal(
      (
        await fixture.store.loadRun({
          tenantId: actor().tenantId,
          runId: fixture.runId,
        })
      )?.status,
      "reconciling",
    );
    const originalCommand = signedCommands[0];
    assert.ok(originalCommand !== undefined);

    resumedDevice = await connectResumingDevice(
      gateway.port,
      originalCommand,
      () => {
        replayedCommands += 1;
      },
    );
    assert.deepEqual(await fixture.worker.wake(), {
      kind: "completed",
      runId: fixture.runId,
    });
    assert.equal(sideEffectStarts, 1);
    assert.equal(replayedCommands, 1);
    assert.equal(signedCommands.length, 2);
    assert.deepEqual(fixture.modelRequests[1]?.input.items.at(-1), {
      type: "tool_result",
      kind: "function",
      callId: "device-call-1",
      output: "device output",
    });
  } finally {
    await fixture.worker.close();
    await fixture.store.close();
    await toolRuntime.close();
    interruptedDevice.terminate();
    resumedDevice?.terminate();
    await gateway.server.close();
  }
});

async function openGateway(
  databasePath: string,
  commandPublicKey: ReturnType<typeof generateKeyPairSync>["publicKey"],
  clock: () => Date = now,
) {
  const authorizationVerifier = new Ed25519DeviceCommandAuthorizationVerifier(
    [
      {
        keyId: "control-key-1",
        publicKeyPem: commandPublicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    ],
    { now: clock },
  );
  const server = new DeviceGatewayServer({
    tls: {
      key: TEST_SERVER_KEY,
      cert: TEST_SERVER_CERT,
      ca: TEST_CA_CERT,
    },
    identityVerifier: new MtlsDeviceIdentityVerifier(
      [
        {
          deviceId: "device-1",
          credentialId: "device-credential-1",
          fingerprint256: new X509Certificate(TEST_DEVICE_CERT).fingerprint256,
        },
      ],
      { now: clock },
    ),
    workerIdentityVerifier: new MtlsWorkerIdentityVerifier(
      [
        {
          workerId: "worker-1",
          credentialId: "worker-credential-1",
          fingerprint256: new X509Certificate(TEST_WORKER_CERT).fingerprint256,
        },
      ],
      { now: clock },
    ),
    authorizationVerifier,
    dispatchStore: new SqliteDeviceDispatchStore(databasePath),
    now: clock,
  });
  const address = await server.listen("127.0.0.1", 0);
  return { server, port: address.port };
}

async function connectDevice(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`wss://127.0.0.1:${port}/device/v1`, {
    key: TEST_DEVICE_KEY,
    cert: TEST_DEVICE_CERT,
    ca: TEST_CA_CERT,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  });
  socket.on("error", () => undefined);
  let command: DeviceExecutionCommand | null = null;
  socket.on("message", (data: RawData) => {
    const frame = JSON.parse(rawDataBuffer(data).toString("utf8")) as {
      schemaVersion?: unknown;
    };
    if (frame.schemaVersion === "crewon.device-command.v0") {
      command = parseDeviceExecutionCommand(frame);
      socket.send(JSON.stringify(accepted(command)));
      return;
    }
    if (frame.schemaVersion === "crewon.device-ack.v0") {
      const ack = parseDeviceExecutionAck(frame);
      if (ack.throughSequence === 1 && command !== null) {
        socket.send(JSON.stringify(completed(command)));
      }
    }
  });
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      schemaVersion: "crewon.device-hello.v0",
      supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
      deviceId: "device-1",
      connectionId: "connection-1",
      capabilities: ["workspace.read", "workspace.read_file.raw_tool.v0"],
      lastAcknowledged: [],
      sentAt: now().toISOString(),
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  return socket;
}

async function connectInterruptedDevice(
  port: number,
  onSideEffectStart: () => void,
): Promise<WebSocket> {
  const socket = deviceSocket(port);
  let command: DeviceExecutionCommand | null = null;
  socket.on("message", (data: RawData) => {
    const frame = JSON.parse(rawDataBuffer(data).toString("utf8")) as {
      schemaVersion?: unknown;
    };
    if (frame.schemaVersion === "crewon.device-command.v0") {
      command = parseDeviceExecutionCommand(frame);
      onSideEffectStart();
      socket.send(JSON.stringify(accepted(command)));
      return;
    }
    if (
      frame.schemaVersion === "crewon.device-ack.v0" &&
      parseDeviceExecutionAck(frame).throughSequence === 1 &&
      command !== null
    ) {
      socket.close(1000, "fixture_disconnect_after_accept");
    }
  });
  await openDeviceSocket(socket, "connection-interrupted", []);
  return socket;
}

async function connectResumingDevice(
  port: number,
  expectedCommand: DeviceExecutionCommand,
  onReplay: () => void,
): Promise<WebSocket> {
  const socket = deviceSocket(port);
  let replayed = false;
  socket.on("message", (data: RawData) => {
    const frame = JSON.parse(rawDataBuffer(data).toString("utf8")) as {
      schemaVersion?: unknown;
    };
    if (frame.schemaVersion === "crewon.device-command.v0") {
      assert.deepEqual(parseDeviceExecutionCommand(frame), expectedCommand);
      assert.equal(replayed, false);
      replayed = true;
      onReplay();
      socket.send(JSON.stringify(accepted(expectedCommand)));
      return;
    }
    if (
      frame.schemaVersion === "crewon.device-ack.v0" &&
      parseDeviceExecutionAck(frame).throughSequence === 1 &&
      replayed
    ) {
      socket.send(JSON.stringify(completed(expectedCommand)));
    }
  });
  await openDeviceSocket(socket, "connection-resumed", [
    { executionId: expectedCommand.executionId, sequence: 1 },
  ]);
  return socket;
}

async function connectCancelingDevice(
  port: number,
  expectedCommand: DeviceExecutionCommand,
  onReplay: () => void,
): Promise<WebSocket> {
  const socket = deviceSocket(port);
  let acceptedAcknowledged = false;
  let cancelReceived = false;
  let terminalSent = false;
  const sendTerminalWhenReady = () => {
    if (acceptedAcknowledged && cancelReceived && !terminalSent) {
      terminalSent = true;
      socket.send(JSON.stringify(canceled(expectedCommand)));
    }
  };
  socket.on("message", (data: RawData) => {
    const frame = JSON.parse(rawDataBuffer(data).toString("utf8")) as {
      schemaVersion?: unknown;
    };
    if (frame.schemaVersion === "crewon.device-command.v0") {
      assert.deepEqual(parseDeviceExecutionCommand(frame), expectedCommand);
      onReplay();
      socket.send(JSON.stringify(accepted(expectedCommand)));
      return;
    }
    if (frame.schemaVersion === "crewon.device-cancel.v0") {
      const cancel = parseDeviceExecutionCancel(frame);
      assert.equal(cancel.executionId, expectedCommand.executionId);
      assert.equal(cancel.leaseId, expectedCommand.leaseId);
      assert.equal(cancel.leaseEpoch, expectedCommand.leaseEpoch);
      assert.equal(cancel.reasonCode, "worker_cancel_requested");
      cancelReceived = true;
      sendTerminalWhenReady();
      return;
    }
    if (
      frame.schemaVersion === "crewon.device-ack.v0" &&
      parseDeviceExecutionAck(frame).throughSequence === 1
    ) {
      acceptedAcknowledged = true;
      sendTerminalWhenReady();
    }
  });
  await openDeviceSocket(socket, "connection-canceling", [
    { executionId: expectedCommand.executionId, sequence: 1 },
  ]);
  return socket;
}

function deviceSocket(port: number): WebSocket {
  const socket = new WebSocket(`wss://127.0.0.1:${port}/device/v1`, {
    key: TEST_DEVICE_KEY,
    cert: TEST_DEVICE_CERT,
    ca: TEST_CA_CERT,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  });
  socket.on("error", () => undefined);
  return socket;
}

async function openDeviceSocket(
  socket: WebSocket,
  connectionId: string,
  lastAcknowledged: ReadonlyArray<{
    executionId: string;
    sequence: number;
  }>,
): Promise<void> {
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      schemaVersion: "crewon.device-hello.v0",
      supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
      deviceId: "device-1",
      connectionId,
      capabilities: ["workspace.read", "workspace.read_file.raw_tool.v0"],
      lastAcknowledged,
      sentAt: now().toISOString(),
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function workerClient(port: number): HttpsDeviceDispatchClient {
  return new HttpsDeviceDispatchClient({
    endpoint: `https://127.0.0.1:${port}`,
    tls: {
      key: TEST_WORKER_KEY,
      cert: TEST_WORKER_CERT,
      ca: TEST_CA_CERT,
      servername: "localhost",
    },
    requestTimeoutMs: 10_000,
  });
}

function createNetworkDeviceToolRuntime(
  dispatch: HttpsDeviceDispatchClient,
  signer: Ed25519DeviceCommandSigner,
  signedCommands: DeviceExecutionCommand[],
  mode: "mutation" | "rawRead" = "mutation",
): DeviceToolRuntime {
  const rawRead = mode === "rawRead";
  return new DeviceToolRuntime({
    definitions: [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: rawRead ? "read_file" : "workspace_write",
        description: rawRead
          ? "Reads one bounded workspace file."
          : "Writes one bounded workspace value.",
        execution: "serial",
        inputSchema: { type: "object" },
      },
    ],
    policies: new Map([
      [
        rawRead ? "function:read_file" : "function:workspace_write",
        {
          effect: rawRead ? "readOnly" : "mutation",
          recovery: rawRead ? "replaySafe" : "reconcilable",
          resourceBindingId: null,
          credentialBindingId: null,
          executionTarget: {
            kind: "device",
            bindingId: "device-binding-1",
          },
          capability: rawRead
            ? "workspace.read_file.raw_tool.v0"
            : "workspace.read",
          approvalRequirement: rawRead ? "none" : "perAction",
          limits: {
            timeoutMs: 30_000,
            maxOutputBytes: 64 * 1024,
            maxArtifactBytes: 16 * 1024 * 1024,
          },
        },
      ],
    ]),
    bindings: {
      resolve: async (bindingId) =>
        bindingId === "device-binding-1" ? { deviceId: "device-1" } : null,
    },
    signer: {
      async sign(input) {
        const command = await signer.sign(input);
        signedCommands.push(command);
        return command;
      },
    },
    dispatch,
  });
}

async function approvePendingDeviceTool(
  fixture: Awaited<ReturnType<typeof createRuntimeFixture>>,
  idempotencyKey: string,
): Promise<void> {
  const waiting = await fixture.store.loadRun({
    tenantId: actor().tenantId,
    runId: fixture.runId,
  });
  const approvalId = waiting?.waitingApproval?.approvalId;
  assert.ok(approvalId !== undefined);
  const approval = await fixture.approvals.getApproval(actor(), approvalId);
  await fixture.approvals.decideApproval(actor(), {
    kind: "toolApproval.decide",
    approvalId,
    expectedRevision: approval.revision,
    idempotencyKey,
    decision: "approved",
    comment: "allow this exact signed Device action",
  });
}

async function createRuntimeFixture(
  toolRuntime: DeviceToolRuntime,
  mode: "mutation" | "rawRead" = "mutation",
) {
  const store = new InMemoryRunStore();
  const clock = new SystemApplicationClock();
  const ids = new UuidV7ApplicationIdGenerator();
  const digester = new NodeSha256ContentDigester();
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  const threads = new ThreadApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester,
  });
  const runs = new RunApplicationService({
    store,
    authorization,
    clock,
    ids,
  });
  const execution = new RunExecutionService({
    store,
    clock,
    ids,
    digester,
  });
  const approvals = new ToolApprovalApplicationService({
    store,
    authorization,
    clock,
    ids,
  });
  const thread = await threads.createThread(actor(), {
    kind: "thread.create",
    idempotencyKey: "device-thread-1",
    title: null,
  });
  await threads.appendMessage(actor(), {
    kind: "thread.message.append",
    idempotencyKey: "device-message-1",
    threadId: thread.state.threadId,
    expectedRevision: 1,
    role: "user",
    content: mode === "rawRead" ? "read through Device" : "write through Device",
  });
  const run = await runs.createRun(actor(), {
    kind: "run.create",
    idempotencyKey: "device-run-1",
    threadId: thread.state.threadId,
    route,
  });
  const modelRequests: ModelRequest[] = [];
  let samples = 0;
  const transport = {
    adapterName: "device-integration-adapter",
    adapterVersion: "1",
    modelId: "device-integration-model",
    async *stream(request: ModelRequest) {
      modelRequests.push(structuredClone(request));
      samples += 1;
      if (samples === 1) {
        yield {
          type: "tool.call" as const,
          kind: "function" as const,
          callId: "device-call-1",
          name: mode === "rawRead" ? "read_file" : "workspace_write",
          input:
            mode === "rawRead"
              ? JSON.stringify(rawReadArguments())
              : '{"value":"approved"}',
        };
        yield { type: "completed" as const, checkpoint: null };
        return;
      }
      yield { type: "output.delta" as const, delta: "runtime done" };
      yield { type: "completed" as const, checkpoint: null };
    },
  };
  const worker = new RuntimeWorker(
    {
      store,
      execution,
      kernel: new CrewONAgentKernel({
        transport,
        toolCatalog: toolRuntime,
        streamMaxRetries: 0,
      }),
      toolRuntime,
      policy: new PinnedRunExecutionPolicy(route),
    },
    {
      ownerId: "device-network-worker-1",
      nextLeaseId: () => ids.nextId("outboxLease"),
      leaseDurationMs: 10_000,
      retryAfterMs: 0,
      scanIntervalMs: null,
    },
  );
  return {
    store,
    approvals,
    worker,
    modelRequests,
    runId: run.state.runId,
    threadId: thread.state.threadId,
  };
}

function rawReadArguments() {
  return {
    schemaVersion: "crewon.device-filesystem-read-arguments.v0",
    workspaceIncarnationId: "workspace-incarnation-1",
    relativePathSegments: ["notes", "plan.txt"],
    encoding: "utf8",
  };
}

function actor(): ActorContext {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
}

function commandDraft(): Omit<DeviceExecutionCommand, "authorization"> {
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    deviceId: "device-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2026-08-09T00:10:00.000Z",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    workspaceBindingId: "workspace-1",
    capability: "workspace.read_file.raw_tool.v0",
    actionDigest: `sha256:${"a".repeat(64)}`,
    arguments: rawReadArguments(),
    payloadRef: null,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    idempotencyKey: `device:${"a".repeat(64)}`,
    traceContext: { traceparent: null, tracestate: null },
  };
}

function accepted(command: DeviceExecutionCommand): DeviceExecutionEvent {
  return {
    ...eventEnvelope(command, 1),
    type: "execution.accepted",
    data: {
      leaseEpoch: command.leaseEpoch,
      actionDigest: command.actionDigest,
    },
  };
}

function completed(command: DeviceExecutionCommand): DeviceExecutionEvent {
  return {
    ...eventEnvelope(command, 2),
    type: "execution.completed",
    data: {
      output: "device output",
      artifactRef: null,
      outputDigest: sha256("device output"),
      stdoutDigest: sha256(""),
      stderrDigest: sha256(""),
      exitCode: 0,
      exitSignal: null,
    },
  };
}

function canceled(command: DeviceExecutionCommand): DeviceExecutionEvent {
  return {
    ...eventEnvelope(command, 2),
    type: "execution.canceled",
    data: { reasonCode: "worker_cancel_requested" },
  };
}

function eventEnvelope(command: DeviceExecutionCommand, sequence: number) {
  return {
    schemaVersion: "crewon.device-event.v0" as const,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    deviceId: command.deviceId,
    executionId: command.executionId,
    receiptId: "receipt-1",
    sequence,
    observedAt: "2026-08-09T00:00:01.000Z",
  };
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
