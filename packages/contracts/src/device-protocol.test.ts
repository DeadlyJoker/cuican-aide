import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  DEVICE_EXECUTION_EVENT_TYPES,
  DEVICE_PROTOCOL_VERSION,
  parseDeviceExecutionAck,
  parseDeviceExecutionCancel,
  parseDeviceExecutionCommand,
  parseDeviceExecutionEvent,
  parseDeviceGatewayWelcome,
  parseDeviceHello,
  canonicalDeviceCommandSigningPayload,
  canonicalUnsignedDeviceCommandSigningPayload,
} from "./device-protocol.ts";
import { parseDeviceWorkspaceListCommand } from "./device-protocol-workspace.ts";
import {
  deviceExecutionCommandJsonSchema,
  deviceExecutionEventJsonSchema,
} from "./device-protocol-schema.ts";

const digest = `sha256:${"a".repeat(64)}`;
const reference = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  schemaVersion: "crewon.device-protocol-reference.v0";
  signingPayloadSha256: string;
  valid: Readonly<{
    command: unknown;
    workspaceCommand: unknown;
    hello: unknown;
    welcome: unknown;
    ack: unknown;
    cancel: unknown;
    events: readonly unknown[];
  }>;
  invalid: readonly Readonly<{
    parser:
      | "command"
      | "workspaceCommand"
      | "event"
      | "hello"
      | "welcome"
      | "ack"
      | "cancel";
    code: string;
    value: unknown;
  }>[];
}>;

const command = {
  schemaVersion: "crewon.device-command.v0",
  protocolVersion: DEVICE_PROTOCOL_VERSION,
  deviceId: "device-1",
  leaseId: "lease-1",
  leaseEpoch: 2,
  expiresAt: "2026-08-08T01:00:00Z",
  runId: "run-1",
  stepId: "step-1",
  attemptId: "attempt-1",
  executionId: "execution-1",
  workspaceBindingId: "workspace-opaque-1",
  capability: "workspace.read",
  actionDigest: digest,
  authorization: {
    schemaVersion: "crewon.device-authorization.v0",
    scheme: "ed25519",
    keyId: "control-key-1",
    issuedAt: "2026-08-08T00:00:00Z",
    expiresAt: "2026-08-08T00:30:00Z",
    approvalProof: null,
    signature: "A".repeat(86),
  },
  arguments: { path: "relative/file.txt" },
  payloadRef: null,
  limits: {
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    maxArtifactBytes: 16 * 1024 * 1024,
  },
  idempotencyKey: "run-1:step-1:attempt-1",
  traceContext: { traceparent: null, tracestate: null },
} as const;

const completedEvent = {
  schemaVersion: "crewon.device-event.v0",
  protocolVersion: DEVICE_PROTOCOL_VERSION,
  deviceId: "device-1",
  executionId: "execution-1",
  receiptId: "receipt-1",
  sequence: 3,
  observedAt: "2026-08-08T00:00:03Z",
  type: "execution.completed",
  data: {
    output: "done",
    artifactRef: null,
    outputDigest: digest,
    stdoutDigest: digest,
    stderrDigest: digest,
    exitCode: 0,
    exitSignal: null,
  },
} as const;

test("accepts a versioned digest-bound Device command and terminal receipt", () => {
  assert.deepEqual(parseDeviceExecutionCommand(command), command);
  assert.deepEqual(parseDeviceExecutionEvent(completedEvent), completedEvent);
});

test("canonicalizes a signed Device command without signing its signature bytes", () => {
  const { signature: _signature, ...unsignedAuthorization } =
    command.authorization;
  assert.equal(
    canonicalDeviceCommandSigningPayload(command),
    canonicalUnsignedDeviceCommandSigningPayload({
      ...command,
      authorization: unsignedAuthorization,
    }),
  );
  assert.equal(
    canonicalDeviceCommandSigningPayload(command),
    canonicalDeviceCommandSigningPayload({
      ...command,
      authorization: {
        ...command.authorization,
        signature: "B".repeat(86),
      },
    }),
  );
  assert.notEqual(
    canonicalDeviceCommandSigningPayload(command),
    canonicalDeviceCommandSigningPayload({
      ...command,
      leaseEpoch: 3,
    }),
  );
});

test("keeps Device schema fields and event discriminants aligned", () => {
  assert.deepEqual(
    [...deviceExecutionCommandJsonSchema.required].sort(),
    Object.keys(command).sort(),
  );
  assert.deepEqual(
    deviceExecutionEventJsonSchema.oneOf.map(
      (variant) => variant.properties.type.const,
    ),
    DEVICE_EXECUTION_EVENT_TYPES,
  );
});

test("requires exactly one bounded inline argument or opaque payload reference", () => {
  assert.deepEqual(
    parseDeviceExecutionCommand({
      ...command,
      arguments: null,
      payloadRef: "payload-1",
    }).payloadRef,
    "payload-1",
  );
  for (const input of [
    { ...command, arguments: null, payloadRef: null },
    { ...command, payloadRef: "payload-1" },
    { ...command, arguments: { text: "x".repeat(128 * 1024) } },
  ]) {
    assert.throws(
      () => parseDeviceExecutionCommand(input),
      hasCode(
        input.arguments === null || input.payloadRef !== null
          ? "device_payload_choice_invalid"
          : "device_arguments_invalid",
      ),
    );
  }
});

test("rejects path-like workspace authority, stale wire versions and unsafe limits", () => {
  for (const [input, code] of [
    [
      { ...command, workspaceBindingId: "/Users/private" },
      "device_workspace_binding_invalid",
    ],
    [{ ...command, protocolVersion: 2 }, "device_protocol_unsupported"],
    [
      { ...command, limits: { ...command.limits, timeoutMs: 0 } },
      "device_timeout_invalid",
    ],
    [
      { ...command, actionDigest: "sha256:not-a-digest" },
      "device_action_digest_invalid",
    ],
  ] as const) {
    assert.throws(() => parseDeviceExecutionCommand(input), hasCode(code));
  }
});

test("parses bounded sequenced output and fail-closed unknown outcomes", () => {
  assert.equal(
    parseDeviceExecutionEvent({
      ...completedEvent,
      sequence: 2,
      type: "execution.output",
      data: { channel: "stderr", chunk: "warning" },
    }).type,
    "execution.output",
  );
  assert.equal(
    parseDeviceExecutionEvent({
      ...completedEvent,
      sequence: 4,
      type: "execution.unknown_outcome",
      data: { providerReceiptId: "provider-receipt-1" },
    }).type,
    "execution.unknown_outcome",
  );
  assert.throws(
    () =>
      parseDeviceExecutionEvent({
        ...completedEvent,
        type: "execution.output",
        data: { channel: "stdout", chunk: "x".repeat(20 * 1024) },
      }),
    hasCode("device_output_chunk_invalid"),
  );
  assert.throws(
    () =>
      parseDeviceExecutionEvent({
        ...completedEvent,
        type: "execution.completed",
        data: { ...completedEvent.data, providerMessage: "secret" },
      }),
    hasCode("device_fields_invalid"),
  );
});

test("bounds reconnect hello state and validates explicit acknowledgements", () => {
  const hello = {
    schemaVersion: "crewon.device-hello.v0",
    supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
    deviceId: "device-1",
    connectionId: "connection-1",
    capabilities: ["workspace.read", "process.execute"],
    lastAcknowledged: [{ executionId: "execution-1", sequence: 3 }],
    sentAt: "2026-08-08T00:00:04Z",
  } as const;
  const ack = {
    schemaVersion: "crewon.device-ack.v0",
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    deviceId: "device-1",
    executionId: "execution-1",
    throughSequence: 3,
    acknowledgedAt: "2026-08-08T00:00:05Z",
  } as const;

  assert.deepEqual(parseDeviceHello(hello), hello);
  assert.deepEqual(parseDeviceExecutionAck(ack), ack);
  assert.throws(
    () =>
      parseDeviceHello({
        ...hello,
        capabilities: ["workspace.read", "workspace.read"],
      }),
    hasCode("device_capabilities_invalid"),
  );
  assert.throws(
    () => parseDeviceExecutionAck({ ...ack, throughSequence: 0 }),
    hasCode("device_ack_sequence_invalid"),
  );
});

test("accepts a lease-fenced cancel command and rejects unsafe reasons", () => {
  const cancel = {
    schemaVersion: "crewon.device-cancel.v0",
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    deviceId: "device-1",
    executionId: "execution-1",
    leaseId: "lease-1",
    leaseEpoch: 2,
    reasonCode: "run_canceled",
    requestedAt: "2026-08-08T00:00:06Z",
  } as const;

  assert.deepEqual(parseDeviceExecutionCancel(cancel), cancel);
  assert.throws(
    () =>
      parseDeviceExecutionCancel({
        ...cancel,
        reasonCode: "unsafe reason",
      }),
    hasCode("device_cancel_reason_invalid"),
  );
});

test("matches the shared Rust Device Protocol reference and fail-closed codes", () => {
  assert.equal(reference.schemaVersion, "crewon.device-protocol-reference.v0");
  assert.deepEqual(
    parseDeviceExecutionCommand(reference.valid.command),
    reference.valid.command,
  );
  assert.equal(
    `sha256:${createHash("sha256")
      .update(
        canonicalDeviceCommandSigningPayload(reference.valid.command),
        "utf8",
      )
      .digest("hex")}`,
    reference.signingPayloadSha256,
  );
  assert.deepEqual(
    parseDeviceHello(reference.valid.hello),
    reference.valid.hello,
  );
  assert.deepEqual(
    parseDeviceGatewayWelcome(reference.valid.welcome),
    reference.valid.welcome,
  );
  assert.deepEqual(
    parseDeviceExecutionAck(reference.valid.ack),
    reference.valid.ack,
  );
  assert.deepEqual(
    parseDeviceExecutionCancel(reference.valid.cancel),
    reference.valid.cancel,
  );
  assert.deepEqual(
    reference.valid.events.map(parseDeviceExecutionEvent),
    reference.valid.events,
  );
  for (const invalid of reference.invalid) {
    assert.throws(
      () => sharedParser(invalid.parser)(invalid.value),
      hasCode(invalid.code),
    );
  }
});

function sharedParser(parser: (typeof reference.invalid)[number]["parser"]) {
  switch (parser) {
    case "command":
      return parseDeviceExecutionCommand;
    case "workspaceCommand":
      return parseDeviceWorkspaceListCommand;
    case "event":
      return parseDeviceExecutionEvent;
    case "hello":
      return parseDeviceHello;
    case "welcome":
      return parseDeviceGatewayWelcome;
    case "ack":
      return parseDeviceExecutionAck;
    case "cancel":
      return parseDeviceExecutionCancel;
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ContractValidationError && error.code === code;
}
