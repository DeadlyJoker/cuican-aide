import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalDeviceFilesystemReadCommandDigest,
  parseDeviceFilesystemReadCommand,
  parseDeviceFilesystemReadAck,
  parseDeviceFilesystemReadEvent,
  parseDeviceFilesystemReadResult,
  parseDeviceRawFilesystemReadCommand,
} from "./device-filesystem-read.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  valid: {
    filesystemReadCommand: unknown;
    filesystemReadResult: unknown;
    filesystemReadEvents: unknown[];
    filesystemReadAck: unknown;
  };
};

test("parses the shared bounded filesystem read command", () => {
  assert.deepEqual(
    parseDeviceFilesystemReadCommand(fixture.valid.filesystemReadCommand),
    fixture.valid.filesystemReadCommand,
  );
  assert.equal(
    canonicalDeviceFilesystemReadCommandDigest(
      fixture.valid.filesystemReadCommand,
      digestUtf8,
    ),
    (fixture.valid.filesystemReadEvents[0] as any).commandDigest,
  );
});

test("keeps dedicated and raw Tool read capability parsers disjoint", () => {
  const raw = structuredClone(fixture.valid.filesystemReadCommand) as any;
  raw.capability = "workspace.read_file.raw_tool.v0";
  assert.equal(
    parseDeviceRawFilesystemReadCommand(raw).capability,
    "workspace.read_file.raw_tool.v0",
  );
  assert.throws(
    () => parseDeviceFilesystemReadCommand(raw),
    /device_filesystem_read_command_invalid/,
  );
});

test("parses durable read events and cumulative ACK from the shared fixture", () => {
  for (const event of fixture.valid.filesystemReadEvents) {
    assert.deepEqual(parseDeviceFilesystemReadEvent(event, digestUtf8), event);
  }
  assert.deepEqual(
    parseDeviceFilesystemReadAck(fixture.valid.filesystemReadAck),
    fixture.valid.filesystemReadAck,
  );
  const drift = structuredClone(fixture.valid.filesystemReadEvents[1]) as any;
  drift.sequence = 1;
  assert.throws(
    () => parseDeviceFilesystemReadEvent(drift, digestUtf8),
    /device_filesystem_read_event_invalid/,
  );
  const badTime = structuredClone(fixture.valid.filesystemReadEvents[0]) as any;
  badTime.observedAt = "not-a-timestamp";
  assert.throws(() => parseDeviceFilesystemReadEvent(badTime, digestUtf8));
  for (const nonCanonicalTime of ["2026-08-08", "2026-08-08T08:00:03+08:00"]) {
    const nonCanonical = structuredClone(
      fixture.valid.filesystemReadEvents[0],
    ) as any;
    nonCanonical.observedAt = nonCanonicalTime;
    assert.throws(() =>
      parseDeviceFilesystemReadEvent(nonCanonical, digestUtf8),
    );
  }
  const digestDrift = structuredClone(
    fixture.valid.filesystemReadEvents[1],
  ) as any;
  digestDrift.data.result.content = "changed";
  digestDrift.data.result.byteLength = 7;
  assert.throws(() => parseDeviceFilesystemReadEvent(digestDrift, digestUtf8));
});

function digestUtf8(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

test("parses the shared UTF-8 result under its serialized output cap", () => {
  assert.deepEqual(
    parseDeviceFilesystemReadResult(fixture.valid.filesystemReadResult, 256),
    fixture.valid.filesystemReadResult,
  );
  assert.throws(
    () =>
      parseDeviceFilesystemReadResult(fixture.valid.filesystemReadResult, 32),
    /device_filesystem_read_result_invalid/,
  );
});

test("rejects traversal and mutation approval authority", () => {
  const command = structuredClone(fixture.valid.filesystemReadCommand) as any;
  command.arguments.relativePathSegments = [".."];
  assert.throws(
    () => parseDeviceFilesystemReadCommand(command),
    /device_filesystem_read_path_invalid/,
  );
});
