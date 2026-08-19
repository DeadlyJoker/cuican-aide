import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildProductionBackupManifest,
  fileDescriptor,
  parseProductionBackupManifest,
  snapshotArtifactAuthority,
  snapshotServerRelease,
  verifyBackupFiles,
} from "./production-backup-tools.mjs";
import { buildServerReleaseManifest } from "./server-release-tools.mjs";

test("snapshots one quiesced encrypted Artifact authority", () => {
  const fixture = artifactFixture();
  try {
    const snapshot = snapshotArtifactAuthority({
      databasePath: fixture.databasePath,
      destinationDirectory: fixture.destination,
      rootDirectory: fixture.rootDirectory,
    });
    assert.deepEqual(
      snapshot.blobs.map((blob) => blob.path),
      [
        "artifacts/files/blobs/tenant-a/artifact-a.bin",
        "artifacts/files/blobs/tenant-b/artifact-b.bin",
      ],
    );
    assert.equal(snapshot.metadata.path, "artifacts/metadata.sqlite3");
    const copied = new DatabaseSync(
      join(fixture.destination, "metadata.sqlite3"),
      { readOnly: true },
    );
    try {
      assert.deepEqual(
        copied
          .prepare("SELECT state FROM artifacts ORDER BY state")
          .all()
          .map((row) => ({ ...row })),
        [{ state: "ready" }, { state: "ready" }],
      );
    } finally {
      copied.close();
    }
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("fails snapshot rather than capturing an in-flight Artifact", () => {
  const fixture = artifactFixture({ pending: true });
  try {
    assert.throws(
      () =>
        snapshotArtifactAuthority({
          databasePath: fixture.databasePath,
          destinationDirectory: fixture.destination,
          rootDirectory: fixture.rootDirectory,
        }),
      /artifact_write_in_progress/u,
    );
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("binds PostgreSQL, Artifact and signed server release evidence", () => {
  const base = mkdtempSync(join(tmpdir(), "crewon-backup-manifest-"));
  try {
    const releasePath = join(base, "source-release.json");
    writeFileSync(
      releasePath,
      `${JSON.stringify(releaseManifest(), null, 2)}\n`,
    );
    const release = snapshotServerRelease({
      destinationPath: join(base, "server-release-manifest.json"),
      manifestPath: releasePath,
    });
    const dump = join(base, "postgres.dump");
    const metadata = join(base, "metadata.sqlite3");
    const blob = join(base, "artifact.bin");
    writeFileSync(dump, "postgres custom dump");
    writeFileSync(metadata, "sqlite snapshot");
    writeFileSync(blob, "ciphertext");
    const manifest = buildProductionBackupManifest({
      artifactKeyId: "artifact-key-v1",
      artifacts: {
        metadata: fileDescriptor(metadata, "artifacts/metadata.sqlite3"),
        blobs: [fileDescriptor(blob, "artifacts/files/blobs/a/artifact.bin")],
      },
      createdAt: "2026-08-19T00:00:00.000Z",
      databaseSchema: "crewon",
      postgresDump: fileDescriptor(dump, "postgres.dump"),
      serverRelease: release,
    });
    assert.deepEqual(parseProductionBackupManifest(manifest), manifest);

    const backup = join(base, "backup");
    mkdirSync(join(backup, "artifacts", "files", "blobs", "a"), {
      recursive: true,
    });
    for (const [source, target] of [
      [dump, join(backup, "postgres.dump")],
      [metadata, join(backup, "artifacts", "metadata.sqlite3")],
      [blob, join(backup, "artifacts", "files", "blobs", "a", "artifact.bin")],
      [
        join(base, "server-release-manifest.json"),
        join(backup, "server-release-manifest.json"),
      ],
    ]) {
      writeFileSync(target, readFileSync(source));
    }
    assert.deepEqual(verifyBackupFiles(backup, manifest), manifest);
    writeFileSync(join(backup, "postgres.dump"), "tampered");
    assert.throws(
      () => verifyBackupFiles(backup, manifest),
      /digest_mismatch/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function artifactFixture(options = {}) {
  const base = mkdtempSync(join(tmpdir(), "crewon-artifact-snapshot-"));
  const rootDirectory = join(base, "files");
  const destination = join(base, "snapshot");
  const databasePath = join(base, "metadata.sqlite3");
  mkdirSync(join(rootDirectory, "blobs", "tenant-b"), { recursive: true });
  mkdirSync(join(rootDirectory, "blobs", "tenant-a"), { recursive: true });
  writeFileSync(
    join(rootDirectory, "blobs", "tenant-b", "artifact-b.bin"),
    "b",
  );
  writeFileSync(
    join(rootDirectory, "blobs", "tenant-a", "artifact-a.bin"),
    "a",
  );
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE artifacts (state TEXT NOT NULL);
    INSERT INTO artifacts VALUES ('ready'), ('${options.pending ? "writing" : "ready"}');
  `);
  database.close();
  return { base, databasePath, destination, rootDirectory };
}

function releaseManifest() {
  return buildServerReleaseManifest({
    commit: "a".repeat(40),
    images: ["control-api", "runtime-worker", "web-bff", "web"].map(
      (component, index) => ({
        component,
        image: `ghcr.io/crewon/crewon-${component}`,
        digest: `sha256:${String(index + 1).repeat(64)}`,
      }),
    ),
    publishedAt: "2026-08-19T00:00:00.000Z",
    repository: "crewon/cuican-aide",
    tag: "server-v1.2.3",
  });
}
