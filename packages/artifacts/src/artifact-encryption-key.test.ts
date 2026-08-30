import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ArtifactStoreError } from "@crewon/application";

import { loadArtifactEncryptionKey } from "./artifact-encryption-key.ts";

test("loads exact raw and canonical base64 256-bit keys", (context) => {
  const directory = temporaryDirectory(context);
  const expected = Buffer.alloc(32, 0x4a);
  const raw = path.join(directory, "raw.key");
  const base64 = path.join(directory, "base64.key");
  writeFileSync(raw, expected, { mode: 0o600 });
  writeFileSync(base64, `${expected.toString("base64")}\n`, { mode: 0o600 });

  assert.deepEqual(loadArtifactEncryptionKey(raw), new Uint8Array(expected));
  assert.deepEqual(loadArtifactEncryptionKey(base64), new Uint8Array(expected));
});

test("rejects malformed keys and group/world-readable key files", (context) => {
  const directory = temporaryDirectory(context);
  const malformed = path.join(directory, "malformed.key");
  writeFileSync(malformed, Buffer.alloc(31), { mode: 0o600 });
  assert.throws(
    () => loadArtifactEncryptionKey(malformed),
    (error) => artifactError(error, "artifact_key_file_invalid"),
  );

  if (process.platform !== "win32") {
    const exposed = path.join(directory, "exposed.key");
    writeFileSync(exposed, Buffer.alloc(32), { mode: 0o600 });
    chmodSync(exposed, 0o644);
    assert.throws(
      () => loadArtifactEncryptionKey(exposed),
      (error) => artifactError(error, "artifact_key_file_permissions_invalid"),
    );
  }
});

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "crewon-artifact-key-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function artifactError(error: unknown, code: string): boolean {
  return error instanceof ArtifactStoreError && error.code === code;
}
