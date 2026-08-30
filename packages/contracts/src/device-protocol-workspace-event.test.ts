import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseDeviceWorkspaceListAck,
  parseDeviceWorkspaceListAckForEvent,
  parseDeviceWorkspaceListEvent,
  parseDeviceWorkspaceListEventForCommand,
} from "./device-protocol-workspace-event.ts";
import {
  deviceWorkspaceListAckJsonSchema,
  deviceWorkspaceListEventJsonSchema,
} from "./device-protocol-workspace-event-schema.ts";

const reference = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  schemaVersion: string;
  signingPayloadSha256: string;
  valid: Readonly<{
    command: unknown;
    workspaceCommand: never;
    workspaceAck: unknown;
    workspaceEvents: readonly unknown[];
    hello: unknown;
    welcome: unknown;
    ack: unknown;
    cancel: unknown;
    events: readonly unknown[];
  }>;
  invalid: readonly Readonly<{
    parser: string;
    code: string;
    value: unknown;
  }>[];
  workspaceInvalid: readonly Readonly<{
    parser: string;
    code: string;
    value: unknown;
  }>[];
}>;

test("parses independent workspace events and ACK from the shared Rust fixture", () => {
  const events = reference.valid.workspaceEvents.map(
    parseDeviceWorkspaceListEvent,
  );
  const ack = parseDeviceWorkspaceListAck(reference.valid.workspaceAck);
  assert.deepEqual(events, reference.valid.workspaceEvents);
  assert.deepEqual(ack, reference.valid.workspaceAck);
  assert.deepEqual(
    parseDeviceWorkspaceListEventForCommand(
      events[0],
      reference.valid.workspaceCommand,
      3,
    ),
    events[0],
  );
  assert.deepEqual(
    parseDeviceWorkspaceListEventForCommand(
      events[1],
      reference.valid.workspaceCommand,
      3,
    ),
    events[1],
  );
  assert.deepEqual(parseDeviceWorkspaceListAckForEvent(ack, events[1]!), ack);
});

test("binds every route and capability identity to command and ACK", () => {
  const completed = reference.valid.workspaceEvents[1] as Record<
    string,
    unknown
  >;
  for (const [field, value] of [
    ["deviceId", "device-2"],
    ["workspaceBindingId", "workspace-binding-2"],
    ["incarnationId", "incarnation-2"],
    ["deviceBindingId", "device-binding-2"],
    ["runtimeBindingId", "runtime-binding-2"],
    ["actionDigest", `sha256:${"c".repeat(64)}`],
    ["commandDigest", `sha256:${"d".repeat(64)}`],
  ] as const) {
    const changed = { ...completed, [field]: value };
    if (field === "actionDigest" || field === "commandDigest") {
      changed.data = {
        result: {
          ...(completed.data as { result: object }).result,
          [field]: value,
        },
      };
    }
    assert.throws(
      () =>
        parseDeviceWorkspaceListEventForCommand(
          changed,
          reference.valid.workspaceCommand,
          3,
        ),
      hasCode("device_workspace_event_identity_mismatch"),
    );
  }
  assert.throws(
    () =>
      parseDeviceWorkspaceListAckForEvent(
        { ...(reference.valid.workspaceAck as object), connectionEpoch: 4 },
        parseDeviceWorkspaceListEvent(completed),
      ),
    hasCode("device_workspace_ack_identity_mismatch"),
  );
});

test("enforces exact N3c result shape, UTF-8 byte order and hard caps", () => {
  const completed = reference.valid.workspaceEvents[1] as Record<
    string,
    unknown
  >;
  const data = completed.data as { result: Record<string, unknown> };
  for (const [result, code] of [
    [
      { ...data.result, providerMessage: "secret" },
      "device_workspace_fields_invalid",
    ],
    [
      {
        ...data.result,
        entries: [{ name: "x".repeat(256), kind: "file" }],
      },
      "device_workspace_entry_name_invalid",
    ],
    [
      {
        ...data.result,
        entries: [{ name: "bad\ud800", kind: "file" }],
      },
      "device_workspace_entry_name_invalid",
    ],
  ] as const) {
    assert.throws(
      () =>
        parseDeviceWorkspaceListEvent({
          ...completed,
          data: { result },
        }),
      hasCode(code),
    );
  }
});

test("matches shared reject vectors and JSON Schema top-level exact keys", () => {
  for (const invalid of reference.workspaceInvalid) {
    if (invalid.parser === "workspaceEvent") {
      assert.throws(
        () => parseDeviceWorkspaceListEvent(invalid.value),
        hasCode(invalid.code),
      );
    }
    if (invalid.parser === "workspaceAck") {
      assert.throws(
        () => parseDeviceWorkspaceListAck(invalid.value),
        hasCode(invalid.code),
      );
    }
  }
  assert.deepEqual(
    [...deviceWorkspaceListEventJsonSchema.oneOf[0].required].sort(),
    Object.keys(reference.valid.workspaceEvents[0] as object).sort(),
  );
  assert.deepEqual(
    [...deviceWorkspaceListAckJsonSchema.required].sort(),
    Object.keys(reference.valid.workspaceAck as object).sort(),
  );
});

test("keeps the pre-existing Tool v0 fixture subtree byte stable", () => {
  const toolOnly = {
    schemaVersion: reference.schemaVersion,
    signingPayloadSha256: reference.signingPayloadSha256,
    valid: {
      command: reference.valid.command,
      hello: reference.valid.hello,
      welcome: reference.valid.welcome,
      ack: reference.valid.ack,
      cancel: reference.valid.cancel,
      events: reference.valid.events,
    },
    invalid: reference.invalid.filter(
      ({ parser }) => !parser.startsWith("workspace"),
    ),
  };
  assert.equal(
    createHash("sha256").update(JSON.stringify(toolOnly)).digest("hex"),
    "70faed2046b76d91c707a8617a14968cd5b976c510a2e649db23558fbf908310",
  );
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ContractValidationError && error.code === code;
}
