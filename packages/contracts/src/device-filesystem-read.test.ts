import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseDeviceFilesystemReadCommand,
  parseDeviceFilesystemReadResult,
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
  valid: { filesystemReadCommand: unknown; filesystemReadResult: unknown };
};

test("parses the shared bounded filesystem read command", () => {
  assert.deepEqual(
    parseDeviceFilesystemReadCommand(fixture.valid.filesystemReadCommand),
    fixture.valid.filesystemReadCommand,
  );
});

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
