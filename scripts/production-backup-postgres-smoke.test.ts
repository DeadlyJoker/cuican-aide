import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilesystemArtifactStore } from "../packages/artifacts/src/filesystem-artifact-store.ts";
import { createArtifactRecord } from "../packages/domain/src/artifact.ts";

import { buildServerReleaseManifest } from "./server-release-tools.mjs";

const image =
  process.env.CREWON_RUNTIME_WORKER_BACKUP_IMAGE ??
  "crewon-runtime-worker:backup-verify";
const components = ["control-api", "runtime-worker", "web-bff", "web"];

test(
  "backs up and restores PostgreSQL 16 plus one encrypted Artifact",
  { timeout: 180_000 },
  async () => {
    docker(["image", "inspect", image]);
    const suffix = randomUUID().replaceAll("-", "");
    const network = `crewon-backup-${suffix}`;
    const postgres = `crewon-backup-pg-${suffix}`;
    const fixture = mkdtempSync(join(tmpdir(), "crewon-backup-smoke-"));
    const password = randomBytes(24).toString("hex");
    const key = randomBytes(32);
    const keyId = "backup-smoke-key-v1";
    const databaseSchema = "crewon";
    const sourceDatabase = "crewon_source";
    const restoredDatabase = "crewon_restored";
    try {
      docker(["network", "create", network]);
      docker(
        [
          "run",
          "--detach",
          "--name",
          postgres,
          "--network",
          network,
          "--env",
          "POSTGRES_PASSWORD",
          "--env",
          `POSTGRES_DB=${sourceDatabase}`,
          "postgres:16-alpine",
        ],
        { POSTGRES_PASSWORD: password },
      );
      await waitForPostgres(postgres, sourceDatabase);
      postgresSql(
        postgres,
        sourceDatabase,
        `CREATE SCHEMA ${databaseSchema};
         CREATE TABLE ${databaseSchema}.backup_proof (
           proof_id text PRIMARY KEY,
           payload text NOT NULL
         );
         INSERT INTO ${databaseSchema}.backup_proof VALUES
           ('proof-1', 'durable-postgres-value');`,
      );
      postgresSql(
        postgres,
        sourceDatabase,
        `CREATE DATABASE ${restoredDatabase}`,
      );

      const artifact = await createEncryptedArtifact(fixture, key, keyId);
      const release = createReleaseEvidence(fixture);
      makeWorldWritable(fixture);

      const sourceUrl = postgresUrl(postgres, password, sourceDatabase);
      runBackupContainer({
        fixture,
        network,
        connectionString: sourceUrl,
        arguments: [
          "backup",
          "--artifact-database",
          "/fixture/artifact-authority/metadata.sqlite3",
          "--artifact-key-id",
          keyId,
          "--artifact-root",
          "/fixture/artifact-authority/files",
          "--output",
          "/fixture/backups/backup-v1",
          "--server-release-manifest",
          "/fixture/server-release-manifest.json",
          "--server-release-signature",
          "/fixture/server-release-manifest.sigstore.json",
        ],
      });

      runBackupContainer({
        fixture,
        network,
        connectionString: postgresUrl(postgres, password, restoredDatabase),
        arguments: [
          "restore",
          "--artifact-authority-directory",
          "/fixture/restored/authority",
          "--artifact-key-id",
          keyId,
          "--backup",
          "/fixture/backups/backup-v1",
          "--server-release-manifest",
          "/fixture/server-release-manifest.json",
          "--server-release-signature",
          "/fixture/server-release-manifest.sigstore.json",
        ],
      });

      assert.equal(
        postgresQuery(
          postgres,
          restoredDatabase,
          `SELECT proof_id || ':' || payload
             FROM ${databaseSchema}.backup_proof`,
        ),
        "proof-1:durable-postgres-value",
      );
      docker([
        "run",
        "--rm",
        "--user",
        "root",
        "--volume",
        `${fixture}:/fixture`,
        "--entrypoint",
        "chmod",
        image,
        "-R",
        "a+rwX",
        "/fixture",
      ]);

      const restoredStore = new FilesystemArtifactStore({
        rootDirectory: join(fixture, "restored", "authority", "files"),
        databasePath: join(
          fixture,
          "restored",
          "authority",
          "metadata.sqlite3",
        ),
        encryptionKey: key,
        keyId,
      });
      try {
        const restored = await restoredStore.read({
          tenantId: artifact.tenantId,
          artifactId: artifact.artifactId,
        });
        assert.ok(restored);
        assert.deepEqual(restored.record, artifact.record);
        assert.deepEqual(Buffer.from(restored.content), artifact.content);
      } finally {
        await restoredStore.close();
      }
      assert.equal(
        JSON.parse(
          readFileSync(
            join(fixture, "restored", "authority", "restore-evidence.json"),
            "utf8",
          ),
        ).serverReleaseCommit,
        release.commit,
      );
    } finally {
      bestEffortDocker(["rm", "--force", postgres]);
      bestEffortDocker(["network", "rm", network]);
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);

async function createEncryptedArtifact(
  fixture: string,
  key: Buffer,
  keyId: string,
) {
  const authority = join(fixture, "artifact-authority");
  const rootDirectory = join(authority, "files");
  const databasePath = join(authority, "metadata.sqlite3");
  const content = Buffer.from("durable encrypted artifact value", "utf8");
  const record = createArtifactRecord({
    schemaVersion: "crewon.artifact.v0",
    artifactId: "artifact-backup-smoke-1",
    tenantId: "tenant-backup-smoke",
    spaceId: "space-backup-smoke",
    ownerActorId: "actor-backup-smoke",
    kind: "toolOutput",
    mediaType: "text/plain",
    sensitivity: "workspaceSensitive",
    source: {
      kind: "toolOutput",
      runId: "run-backup-smoke",
      stepId: "step-backup-smoke",
      attemptId: "attempt-backup-smoke",
      callId: "call-backup-smoke",
    },
    contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    byteLength: content.byteLength,
    retention: { kind: "run", expiresAt: "2027-08-19T00:00:00.000Z" },
    encryption: { scheme: "aes256gcm", keyId },
    scan: { status: "notRequired", scannedAt: null, scanner: null },
    createdAt: "2026-08-19T00:00:00.000Z",
  });
  const store = new FilesystemArtifactStore({
    rootDirectory,
    databasePath,
    encryptionKey: key,
    keyId,
  });
  try {
    await store.put({
      idempotencyKey: "artifact-backup-smoke-put-v1",
      content,
      record,
    });
  } finally {
    await store.close();
  }
  const ciphertext = readFileSync(onlyFile(join(rootDirectory, "blobs")));
  assert.equal(ciphertext.includes(content), false);
  mkdirSync(join(fixture, "backups"));
  mkdirSync(join(fixture, "restored"));
  return {
    artifactId: record.artifactId,
    tenantId: record.tenantId,
    content,
    record,
  };
}

function createReleaseEvidence(fixture: string) {
  const manifest = buildServerReleaseManifest({
    commit: "a".repeat(40),
    images: components.map((component, index) => ({
      component,
      image: `ghcr.io/crewon/crewon-${component}`,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    })),
    publishedAt: "2026-08-19T00:00:00.000Z",
    repository: "crewon/cuican-aide",
    tag: "server-v1.0.0",
  });
  writeFileSync(
    join(fixture, "server-release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(fixture, "server-release-manifest.sigstore.json"),
    `${JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    })}\n`,
  );
  return manifest;
}

function runBackupContainer(input: {
  fixture: string;
  network: string;
  connectionString: string;
  arguments: string[];
}) {
  docker(
    [
      "run",
      "--rm",
      "--network",
      input.network,
      "--volume",
      `${input.fixture}:/fixture`,
      "--env",
      "CREWON_CONTROL_DATABASE_URL",
      "--env",
      "CREWON_CONTROL_DATABASE_SCHEMA=crewon",
      "--entrypoint",
      "node",
      image,
      "/app/ops/production-backup-main.mjs",
      ...input.arguments,
    ],
    { CREWON_CONTROL_DATABASE_URL: input.connectionString },
  );
}

async function waitForPostgres(container: string, database: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      docker([
        "exec",
        container,
        "pg_isready",
        "--host",
        "127.0.0.1",
        "--username",
        "postgres",
        "--dbname",
        database,
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("backup_smoke_postgres_not_ready");
}

function postgresSql(container: string, database: string, sql: string) {
  docker([
    "exec",
    container,
    "psql",
    "--set=ON_ERROR_STOP=1",
    "--username",
    "postgres",
    "--dbname",
    database,
    "--command",
    sql,
  ]);
}

function postgresQuery(container: string, database: string, sql: string) {
  return docker([
    "exec",
    container,
    "psql",
    "--tuples-only",
    "--no-align",
    "--username",
    "postgres",
    "--dbname",
    database,
    "--command",
    sql,
  ]).trim();
}

function postgresUrl(container: string, password: string, database: string) {
  return `postgresql://postgres:${password}@${container}:5432/${database}`;
}

function docker(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function bestEffortDocker(args: string[]) {
  try {
    docker(args);
  } catch {
    // Cleanup must preserve the original smoke failure.
  }
}

function makeWorldWritable(root: string) {
  chmodSync(root, 0o777);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) makeWorldWritable(path);
    else chmodSync(path, 0o666);
  }
}

function onlyFile(directory: string): string {
  const files = readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? [onlyFile(path)] : [path];
    },
  );
  assert.equal(files.length, 1);
  return files[0]!;
}
