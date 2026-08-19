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
  createProductionBackup,
  restoreProductionBackup,
} from "./production-backup-main.mjs";
import { parseProductionBackupManifest } from "./production-backup-tools.mjs";
import { buildServerReleaseManifest } from "./server-release-tools.mjs";

test("creates one atomic production backup without putting secrets in command arguments", async () => {
  const fixture = backupFixture();
  const calls = [];
  try {
    const manifest = await createProductionBackup({
      ...fixture.config,
      createdAt: "2026-08-19T00:00:00.000Z",
      runProgram: async (program, args, environment) => {
        calls.push({ program, args, environment });
        writeFileSync(args[args.indexOf("--file") + 1], "custom pg dump");
      },
    });
    assert.deepEqual(
      parseProductionBackupManifest(
        JSON.parse(
          readFileSync(
            join(fixture.config.outputDirectory, "backup-manifest.json"),
            "utf8",
          ),
        ),
      ),
      manifest,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].program, "pg_dump");
    assert.equal(
      calls[0].args.includes(fixture.config.connectionString),
      false,
    );
    assert.equal(
      calls[0].environment.PGDATABASE,
      fixture.config.connectionString,
    );
    assert.equal(
      calls[0].args.includes(fixture.config.connectionString),
      false,
    );
    assert.equal(calls[0].args.includes("--schema=crewon"), true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("restores only verified evidence into a new Artifact authority", async () => {
  const fixture = backupFixture();
  try {
    await createProductionBackup({
      ...fixture.config,
      createdAt: "2026-08-19T00:00:00.000Z",
      runProgram: async (_program, args) => {
        writeFileSync(args[args.indexOf("--file") + 1], "custom pg dump");
      },
    });
    const calls = [];
    const restored = join(fixture.base, "restored-authority");
    const manifest = await restoreProductionBackup({
      artifactAuthorityDirectory: restored,
      artifactKeyId: fixture.config.artifactKeyId,
      backupDirectory: fixture.config.outputDirectory,
      connectionString: fixture.config.connectionString,
      databaseSchema: fixture.config.databaseSchema,
      expectedServerReleaseManifestPath:
        fixture.config.serverReleaseManifestPath,
      expectedServerReleaseSignaturePath:
        fixture.config.serverReleaseSignaturePath,
      runProgram: async (program, args, environment) => {
        calls.push({ program, args, environment });
      },
    });
    assert.deepEqual(calls, [
      {
        program: "pg_restore",
        args: [
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--no-privileges",
          "--schema=crewon",
          join(fixture.config.outputDirectory, "postgres.dump"),
        ],
        environment: calls[0].environment,
      },
    ]);
    assert.equal(
      calls[0].environment.PGDATABASE,
      fixture.config.connectionString,
    );
    assert.equal(
      readFileSync(join(restored, "files", "blobs", "artifact.bin"), "utf8"),
      "ciphertext",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(restored, "restore-evidence.json"), "utf8")),
      {
        schemaVersion: "crewon.production-restore.v0",
        backupCreatedAt: manifest.createdAt,
        backupManifestDigest: JSON.parse(
          readFileSync(join(restored, "restore-evidence.json"), "utf8"),
        ).backupManifestDigest,
        artifactKeyId: "artifact-key-v1",
        serverReleaseTag: "server-v1.2.3",
        serverReleaseCommit: "a".repeat(40),
      },
    );
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("restore rejects a wrong key, release, schema, tamper and existing target before PostgreSQL", async () => {
  const fixture = backupFixture();
  try {
    await createProductionBackup({
      ...fixture.config,
      createdAt: "2026-08-19T00:00:00.000Z",
      runProgram: async (_program, args) => {
        writeFileSync(args[args.indexOf("--file") + 1], "custom pg dump");
      },
    });
    const baseRestore = {
      artifactAuthorityDirectory: join(fixture.base, "restored"),
      artifactKeyId: fixture.config.artifactKeyId,
      backupDirectory: fixture.config.outputDirectory,
      connectionString: fixture.config.connectionString,
      databaseSchema: fixture.config.databaseSchema,
      expectedServerReleaseManifestPath:
        fixture.config.serverReleaseManifestPath,
      expectedServerReleaseSignaturePath:
        fixture.config.serverReleaseSignaturePath,
      runProgram: async () => assert.fail("PostgreSQL must not run"),
    };
    await assert.rejects(
      restoreProductionBackup({ ...baseRestore, artifactKeyId: "wrong-key" }),
      /artifact_key_mismatch/u,
    );
    await assert.rejects(
      restoreProductionBackup({ ...baseRestore, databaseSchema: "other" }),
      /database_schema_mismatch/u,
    );
    const otherRelease = join(fixture.base, "other-release.json");
    writeFileSync(otherRelease, JSON.stringify(releaseManifest("b")));
    await assert.rejects(
      restoreProductionBackup({
        ...baseRestore,
        expectedServerReleaseManifestPath: otherRelease,
      }),
      /server_release_manifest_mismatch/u,
    );
    const otherSignature = join(fixture.base, "other-release.sigstore.json");
    writeFileSync(
      otherSignature,
      JSON.stringify({
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        verificationMaterial: { different: true },
      }),
    );
    await assert.rejects(
      restoreProductionBackup({
        ...baseRestore,
        expectedServerReleaseSignaturePath: otherSignature,
      }),
      /server_release_signature_mismatch/u,
    );
    writeFileSync(
      join(fixture.config.outputDirectory, "postgres.dump"),
      "tampered",
    );
    await assert.rejects(
      restoreProductionBackup(baseRestore),
      /digest_mismatch/u,
    );
    writeFileSync(join(fixture.base, "existing-target"), "occupied");
    await assert.rejects(
      restoreProductionBackup({
        ...baseRestore,
        artifactAuthorityDirectory: join(fixture.base, "existing-target"),
      }),
      /artifact_target_invalid/u,
    );
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

function backupFixture() {
  const base = mkdtempSync(join(tmpdir(), "crewon-production-backup-"));
  const artifactRootDirectory = join(base, "artifact-files");
  const artifactDatabasePath = join(base, "artifact-metadata.sqlite3");
  mkdirSync(join(artifactRootDirectory, "blobs"), { recursive: true });
  writeFileSync(
    join(artifactRootDirectory, "blobs", "artifact.bin"),
    "ciphertext",
  );
  const database = new DatabaseSync(artifactDatabasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE artifacts (state TEXT NOT NULL, relative_path TEXT NOT NULL);
    INSERT INTO artifacts VALUES ('ready', 'blobs/artifact.bin');
  `);
  database.close();
  const serverReleaseManifestPath = join(base, "server-release.json");
  const serverReleaseSignaturePath = join(base, "server-release.sigstore.json");
  writeFileSync(
    serverReleaseManifestPath,
    `${JSON.stringify(releaseManifest("a"), null, 2)}\n`,
  );
  writeFileSync(
    serverReleaseSignaturePath,
    JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {},
    }),
  );
  return {
    base,
    config: {
      artifactDatabasePath,
      artifactKeyId: "artifact-key-v1",
      artifactRootDirectory,
      connectionString: "postgresql://crewon:secret@127.0.0.1/crewon",
      databaseSchema: "crewon",
      outputDirectory: join(base, "backup"),
      serverReleaseManifestPath,
      serverReleaseSignaturePath,
    },
  };
}

function releaseManifest(digestCharacter) {
  return buildServerReleaseManifest({
    commit: digestCharacter.repeat(40),
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
