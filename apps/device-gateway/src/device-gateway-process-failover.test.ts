import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEVICE_PROTOCOL_VERSION,
  parseDeviceExecutionAck,
  parseDeviceExecutionCancel,
  parseDeviceExecutionCommand,
  parseDeviceGatewayWelcome,
  type DeviceExecutionCommand,
  type DeviceExecutionEvent,
} from "@crewon/contracts";
import {
  DeviceDispatchClientError,
  HttpsDeviceDispatchClient,
} from "@crewon/device-dispatch";
import { Pool } from "pg";
import WebSocket, { type RawData } from "ws";

import {
  TEST_CA_CERT,
  TEST_DEVICE_CERT,
  TEST_DEVICE_KEY,
} from "./mtls-test-certificates.test-support.ts";

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;

if (postgresUrl === undefined) {
  test.skip("process failover requires CREWON_TEST_POSTGRES_URL", () =>
    undefined);
} else {
  test("recovers reconcile and cancel without repeating side effects after owner SIGKILL", async () => {
    for (const operation of ["reconcile", "cancel"] as const) {
      await exerciseOwnerKill(postgresUrl, operation);
    }
  });
}

async function exerciseOwnerKill(
  connectionString: string,
  operation: "reconcile" | "cancel",
): Promise<void> {
  const schema = `device_process_${operation}_${randomUUID().replaceAll("-", "")}`;
  let target: GatewayProcess | null = null;
  let source: GatewayProcess | null = null;
  let interruptedDevice: InterruptedDevice | null = null;
  let recoveredDevice: WebSocket | null = null;
  let worker: HttpsDeviceDispatchClient | null = null;
  try {
    target = await startGatewayProcess({
      gatewayId: "gateway-2",
      connectionString,
      schema,
      inboundGatewayId: "gateway-1",
    });
    source = await startGatewayProcess({
      gatewayId: "gateway-1",
      connectionString,
      schema,
      peer: {
        gatewayId: "gateway-2",
        endpoint: `https://127.0.0.1:${target.port}`,
      },
    });
    const command = processCommand(operation);
    let sideEffectStarts = 0;
    let recoveryAttaches = 0;
    interruptedDevice = await connectInterruptedDevice(
      target.port,
      command,
      () => {
        sideEffectStarts += 1;
      },
    );
    worker = workerClient(source.port);
    const initialDispatch = worker
      .execute(command, new AbortController().signal)
      .then(
        (resolution) => ({ status: "resolved" as const, resolution }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    await interruptedDevice.acceptedAcknowledged;
    await target.stop("SIGKILL");
    const initial = await initialDispatch;
    assert.equal(initial.status, "rejected");
    assert.ok(
      initial.error instanceof DeviceDispatchClientError &&
        initial.error.code === "device_gateway_peer_unavailable" &&
        initial.error.retryable,
    );
    await expireDeviceRoute(connectionString, schema);
    recoveredDevice = await connectRecoveringDevice(
      source.port,
      command,
      operation,
      () => {
        recoveryAttaches += 1;
      },
    );
    const resolution = await worker[operation](
      command,
      new AbortController().signal,
    );
    assert.deepEqual(
      resolution,
      operation === "reconcile"
        ? {
            status: "completed",
            executionId: command.executionId,
            providerReceiptId: `receipt-${operation}`,
            output: "device output",
            artifactRef: null,
          }
        : {
            status: "canceled",
            executionId: command.executionId,
            providerReceiptId: `receipt-${operation}`,
          },
    );
    assert.equal(sideEffectStarts, 1);
    assert.equal(recoveryAttaches, 1);
  } finally {
    await worker?.close().catch(() => undefined);
    recoveredDevice?.terminate();
    interruptedDevice?.socket.terminate();
    await source?.stop("SIGTERM");
    await target?.stop("SIGKILL");
    await dropSchema(connectionString, schema);
  }
}

type GatewayProcess = Readonly<{
  port: number;
  stop(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}>;

type GatewayChild = ChildProcessByStdio<null, Readable, Readable>;

async function startGatewayProcess(config: {
  gatewayId: string;
  connectionString: string;
  schema: string;
  peer?: Readonly<{ gatewayId: string; endpoint: string }>;
  inboundGatewayId?: string;
}): Promise<GatewayProcess> {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL("./test-fixtures/gateway-process.ts", import.meta.url),
      ),
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        CREWON_TEST_GATEWAY_ID: config.gatewayId,
        CREWON_TEST_POSTGRES_URL: config.connectionString,
        CREWON_TEST_POSTGRES_SCHEMA: config.schema,
        ...(config.peer === undefined
          ? {}
          : {
              CREWON_TEST_PEER_GATEWAY_ID: config.peer.gatewayId,
              CREWON_TEST_PEER_ENDPOINT: config.peer.endpoint,
            }),
        ...(config.inboundGatewayId === undefined
          ? {}
          : {
              CREWON_TEST_INBOUND_GATEWAY_ID: config.inboundGatewayId,
            }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = childExit(child);
  const ready = await gatewayReady(child, exited);
  assert.equal(ready.gatewayId, config.gatewayId);
  return {
    port: ready.port,
    async stop(signal) {
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        return;
      }
      child.kill(signal);
      await exited;
    },
  };
}

type ReadyFrame = Readonly<{
  schemaVersion: "crewon.test-gateway-ready.v0";
  gatewayId: string;
  port: number;
}>;

async function gatewayReady(
  child: GatewayChild,
  exited: Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >,
): Promise<ReadyFrame> {
  let output = "";
  const ready = new Promise<ReadyFrame>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > 64 * 1024) {
        reject(new Error("gateway_process_stdout_too_large"));
        return;
      }
      const newline = output.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        const value = JSON.parse(output.slice(0, newline)) as ReadyFrame;
        if (
          value.schemaVersion !== "crewon.test-gateway-ready.v0" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value.gatewayId) ||
          !Number.isSafeInteger(value.port) ||
          value.port < 1 ||
          value.port > 65_535
        ) {
          reject(new Error("gateway_process_ready_invalid"));
          return;
        }
        resolve(value);
      } catch (error) {
        reject(new Error("gateway_process_ready_invalid", { cause: error }));
      }
    });
    child.once("error", reject);
  });
  return Promise.race([
    ready,
    exited.then(({ code, signal }) => {
      throw new Error(`gateway_process_exited_${code ?? signal ?? "unknown"}`);
    }),
  ]);
}

function childExit(
  child: GatewayChild,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

type InterruptedDevice = Readonly<{
  socket: WebSocket;
  acceptedAcknowledged: Promise<void>;
}>;

async function connectInterruptedDevice(
  port: number,
  expectedCommand: DeviceExecutionCommand,
  onSideEffectStart: () => void,
): Promise<InterruptedDevice> {
  const socket = deviceSocket(port);
  let dispatched: DeviceExecutionCommand | null = null;
  let resolveAccepted: () => void = () => undefined;
  const acceptedAcknowledged = new Promise<void>((resolve) => {
    resolveAccepted = resolve;
  });
  socket.on("message", (data: RawData) => {
    const frame = decodeFrame(data);
    if (frame.schemaVersion === "crewon.device-command.v0") {
      dispatched = parseDeviceExecutionCommand(frame);
      assert.deepEqual(dispatched, expectedCommand);
      onSideEffectStart();
      socket.send(JSON.stringify(accepted(expectedCommand)));
      return;
    }
    if (
      frame.schemaVersion === "crewon.device-ack.v0" &&
      parseDeviceExecutionAck(frame).throughSequence === 1 &&
      dispatched !== null
    ) {
      resolveAccepted();
    }
  });
  await openDeviceSocket(socket, "connection-interrupted", []);
  return { socket, acceptedAcknowledged };
}

async function connectRecoveringDevice(
  port: number,
  expectedCommand: DeviceExecutionCommand,
  operation: "reconcile" | "cancel",
  onAttach: () => void,
): Promise<WebSocket> {
  const socket = deviceSocket(port);
  let acceptedAcknowledged = false;
  let cancelReceived = false;
  let terminalSent = false;
  const sendTerminalWhenReady = () => {
    if (terminalSent || !acceptedAcknowledged) {
      return;
    }
    if (operation === "cancel" && !cancelReceived) {
      return;
    }
    terminalSent = true;
    socket.send(
      JSON.stringify(
        operation === "cancel"
          ? canceled(expectedCommand)
          : completed(expectedCommand),
      ),
    );
  };
  socket.on("message", (data: RawData) => {
    const frame = decodeFrame(data);
    if (frame.schemaVersion === "crewon.device-command.v0") {
      assert.deepEqual(parseDeviceExecutionCommand(frame), expectedCommand);
      onAttach();
      socket.send(JSON.stringify(accepted(expectedCommand)));
      return;
    }
    if (frame.schemaVersion === "crewon.device-cancel.v0") {
      const cancel = parseDeviceExecutionCancel(frame);
      assert.equal(cancel.executionId, expectedCommand.executionId);
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
  await openDeviceSocket(socket, `connection-recovered-${operation}`, [
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
  let resolveWelcome: () => void = () => undefined;
  const welcomed = new Promise<void>((resolve) => {
    resolveWelcome = resolve;
  });
  const onMessage = (data: RawData) => {
    const frame = decodeFrame(data);
    if (frame.schemaVersion === "crewon.device-welcome.v0") {
      parseDeviceGatewayWelcome(frame);
      socket.off("message", onMessage);
      resolveWelcome();
    }
  };
  socket.on("message", onMessage);
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      schemaVersion: "crewon.device-hello.v0",
      supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
      deviceId: "device-1",
      connectionId,
      capabilities: ["workspace.read"],
      lastAcknowledged,
      sentAt: new Date().toISOString(),
    }),
  );
  await welcomed;
}

function workerClient(port: number): HttpsDeviceDispatchClient {
  return new HttpsDeviceDispatchClient({
    endpoint: `https://127.0.0.1:${port}`,
    tls: {
      key: TEST_DEVICE_KEY,
      cert: TEST_DEVICE_CERT,
      ca: TEST_CA_CERT,
      servername: "localhost",
    },
  });
}

function processCommand(
  operation: "reconcile" | "cancel",
): DeviceExecutionCommand {
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    deviceId: "device-1",
    leaseId: `lease-${operation}`,
    leaseEpoch: 1,
    expiresAt: "2099-08-09T00:00:00.000Z",
    runId: `run-${operation}`,
    stepId: `step-${operation}`,
    attemptId: `attempt-${operation}`,
    executionId: `execution-${operation}`,
    workspaceBindingId: "workspace-1",
    capability: "workspace.read",
    actionDigest: `sha256:${"a".repeat(64)}`,
    arguments: { path: "relative/file.txt" },
    payloadRef: null,
    limits: {
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    idempotencyKey: `device:${operation}:${"a".repeat(48)}`,
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "control-key-1",
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2099-08-08T23:59:00.000Z",
      approvalProof: null,
      signature: "A".repeat(86),
    },
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
    receiptId: `receipt-${
      command.executionId === "execution-cancel" ? "cancel" : "reconcile"
    }`,
    sequence,
    observedAt: new Date().toISOString(),
  };
}

function decodeFrame(data: RawData): Record<string, unknown> {
  return JSON.parse(rawDataBuffer(data).toString("utf8")) as Record<
    string,
    unknown
  >;
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

async function expireDeviceRoute(url: string, schema: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await pool.query(
      `UPDATE ${quoteIdentifier(schema)}.device_connection_routes
       SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE device_id = $1`,
      ["device-1"],
    );
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.end();
  }
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
    );
  } finally {
    await pool.end();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
