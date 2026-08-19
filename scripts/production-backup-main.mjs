#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildProductionBackupManifest,
  fileDescriptor,
  parseProductionBackupManifest,
  snapshotArtifactAuthority,
  snapshotServerRelease,
  verifyBackupFiles,
} from "./production-backup-tools.mjs";

const MANIFEST_FILE = "backup-manifest.json";
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

export async function createProductionBackup({
  artifactDatabasePath,
  artifactKeyId,
  artifactRootDirectory,
  connectionString,
  createdAt = new Date().toISOString(),
  databaseSchema,
  outputDirectory,
  runProgram = runProgramSafely,
  serverReleaseManifestPath,
  serverReleaseSignaturePath,
}) {
  requirePostgresConnection(connectionString);
  requireSchema(databaseSchema);
  const output = newOutputDirectory(outputDirectory, "backup_output_invalid");
  const staging = `${output}.tmp-${process.pid}`;
  if (existsSync(staging)) throw new Error("backup_staging_exists");
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  try {
    const dumpPath = join(staging, "postgres.dump");
    await runProgram(
      "pg_dump",
      [
        "--format=custom",
        "--file",
        dumpPath,
        "--no-owner",
        "--no-privileges",
        `--schema=${databaseSchema}`,
      ],
      postgresEnvironment(connectionString),
    );
    requireRegularFile(dumpPath, "backup_postgres_dump_missing");
    syncFile(dumpPath);
    const artifacts = snapshotArtifactAuthority({
      databasePath: artifactDatabasePath,
      destinationDirectory: join(staging, "artifacts"),
      rootDirectory: artifactRootDirectory,
    });
    const serverRelease = snapshotServerRelease({
      destinationPath: join(staging, "server-release-manifest.json"),
      manifestPath: serverReleaseManifestPath,
      signatureBundlePath: serverReleaseSignaturePath,
    });
    const manifest = buildProductionBackupManifest({
      artifactKeyId,
      artifacts,
      createdAt,
      databaseSchema,
      postgresDump: fileDescriptor(dumpPath, "postgres.dump"),
      serverRelease,
    });
    writeJsonDurably(join(staging, MANIFEST_FILE), manifest);
    verifyBackupFiles(staging, manifest);
    syncDirectory(staging);
    renameSync(staging, output);
    syncDirectory(dirname(output));
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreProductionBackup({
  artifactAuthorityDirectory,
  artifactKeyId,
  backupDirectory,
  connectionString,
  databaseSchema,
  expectedServerReleaseManifestPath,
  expectedServerReleaseSignaturePath,
  runProgram = runProgramSafely,
}) {
  requirePostgresConnection(connectionString);
  requireSchema(databaseSchema);
  const backup = existingDirectory(backupDirectory, "restore_backup_invalid");
  const target = newOutputDirectory(
    artifactAuthorityDirectory,
    "restore_artifact_target_invalid",
  );
  const manifestPath = join(backup, MANIFEST_FILE);
  requireRegularFile(manifestPath, "restore_manifest_missing");
  if (lstatSync(manifestPath).size > MAX_MANIFEST_BYTES)
    throw new Error("restore_manifest_too_large");
  const manifest = verifyBackupFiles(
    backup,
    parseProductionBackupManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    ),
  );
  if (manifest.database.schema !== databaseSchema)
    throw new Error("restore_database_schema_mismatch");
  if (manifest.artifacts.keyId !== artifactKeyId)
    throw new Error("restore_artifact_key_mismatch");
  verifyExpectedServerRelease(
    expectedServerReleaseManifestPath,
    expectedServerReleaseSignaturePath,
    backup,
    manifest,
  );

  const staging = `${target}.tmp-${process.pid}`;
  if (existsSync(staging)) throw new Error("restore_staging_exists");
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  try {
    cpSync(
      join(backup, "artifacts", "metadata.sqlite3"),
      join(staging, "metadata.sqlite3"),
      {
        errorOnExist: true,
        force: false,
        mode: 0,
      },
    );
    cpSync(join(backup, "artifacts", "files"), join(staging, "files"), {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    });
    verifyRestoredArtifacts(staging, manifest);
    writeJsonDurably(join(staging, "restore-evidence.json"), {
      schemaVersion: "crewon.production-restore.v0",
      backupCreatedAt: manifest.createdAt,
      backupManifestDigest: fileDescriptor(manifestPath, MANIFEST_FILE).digest,
      artifactKeyId,
      serverReleaseTag: manifest.serverRelease.tag,
      serverReleaseCommit: manifest.serverRelease.commit,
    });
    syncDirectory(staging);

    await runProgram(
      "pg_restore",
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        `--schema=${databaseSchema}`,
        join(backup, "postgres.dump"),
      ],
      postgresEnvironment(connectionString),
    );
    renameSync(staging, target);
    syncDirectory(dirname(target));
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function verifyExpectedServerRelease(path, signaturePath, backup, manifest) {
  const expected = requireAbsolutePath(
    path,
    "restore_server_release_manifest_invalid",
  );
  requireRegularFile(expected, "restore_server_release_manifest_invalid");
  const bundled = join(backup, manifest.serverRelease.manifest.path);
  if (
    JSON.stringify(
      fileDescriptor(expected, manifest.serverRelease.manifest.path),
    ) !==
    JSON.stringify(
      fileDescriptor(bundled, manifest.serverRelease.manifest.path),
    )
  ) {
    throw new Error("restore_server_release_manifest_mismatch");
  }
  const expectedSignature = requireAbsolutePath(
    signaturePath,
    "restore_server_release_signature_invalid",
  );
  requireRegularFile(
    expectedSignature,
    "restore_server_release_signature_invalid",
  );
  const bundledSignature = join(
    backup,
    manifest.serverRelease.signatureBundle.path,
  );
  if (
    JSON.stringify(
      fileDescriptor(
        expectedSignature,
        manifest.serverRelease.signatureBundle.path,
      ),
    ) !==
    JSON.stringify(
      fileDescriptor(
        bundledSignature,
        manifest.serverRelease.signatureBundle.path,
      ),
    )
  ) {
    throw new Error("restore_server_release_signature_mismatch");
  }
}

function verifyRestoredArtifacts(staging, manifest) {
  const descriptors = [
    manifest.artifacts.metadata,
    ...manifest.artifacts.blobs,
  ];
  for (const descriptor of descriptors) {
    const relativePath = descriptor.path.replace(/^artifacts\//u, "");
    const target = resolve(staging, ...relativePath.split("/"));
    if (relative(staging, target).startsWith(".."))
      throw new Error("restore_artifact_path_invalid");
    syncFile(target);
    if (
      JSON.stringify(fileDescriptor(target, descriptor.path)) !==
      JSON.stringify(descriptor)
    ) {
      throw new Error("restore_artifact_digest_mismatch");
    }
  }
  syncDirectoryTree(staging);
}

async function runProgramSafely(program, args, environment) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(program, args, {
      env: environment,
      stdio: "ignore",
    });
    child.once("error", () =>
      rejectPromise(new Error(`${program}_start_failed`)),
    );
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else rejectPromise(new Error(`${program}_failed`));
    });
  });
}

function postgresEnvironment(connectionString) {
  return {
    ...process.env,
    PGDATABASE: connectionString,
    PGAPPNAME: "crewon-production-backup",
  };
}

function requirePostgresConnection(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("backup_postgres_url_invalid");
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname.length === 0 ||
    parsed.pathname.length <= 1
  ) {
    throw new Error("backup_postgres_url_invalid");
  }
}

function requireSchema(value) {
  if (!SCHEMA_PATTERN.test(value))
    throw new Error("backup_database_schema_invalid");
}

function requireAbsolutePath(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    !isAbsolute(value) ||
    value.includes("\0")
  ) {
    throw new Error(code);
  }
  return resolve(value);
}

function existingDirectory(value, code) {
  const path = requireAbsolutePath(value, code);
  if (!existsSync(path) || !lstatSync(path).isDirectory())
    throw new Error(code);
  return path;
}

function newOutputDirectory(value, code) {
  const path = requireAbsolutePath(value, code);
  if (existsSync(path) || !existsSync(dirname(path))) throw new Error(code);
  return path;
}

function requireRegularFile(path, code) {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(code);
}

function writeJsonDurably(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  syncFile(path);
}

function syncFile(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectoryTree(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) syncDirectoryTree(join(path, entry.name));
  }
  syncDirectory(path);
}

function parseArguments(values) {
  const args = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      !name?.startsWith("--") ||
      value === undefined ||
      args.has(name.slice(2))
    )
      throw new Error("backup_arguments_invalid");
    args.set(name.slice(2), value);
  }
  return args;
}

function requiredArgument(args, name) {
  const value = args.get(name);
  if (value === undefined) throw new Error(`backup_${name}_required`);
  return value;
}

async function runCli(values) {
  const command = values.shift();
  const args = parseArguments(values);
  const common = {
    artifactKeyId: requiredArgument(args, "artifact-key-id"),
    connectionString: requiredEnvironment("CREWON_CONTROL_DATABASE_URL"),
    databaseSchema: requiredEnvironment("CREWON_CONTROL_DATABASE_SCHEMA"),
  };
  if (command === "backup") {
    assertArguments(args, [
      "artifact-database",
      "artifact-key-id",
      "artifact-root",
      "output",
      "server-release-manifest",
      "server-release-signature",
    ]);
    await createProductionBackup({
      ...common,
      artifactDatabasePath: requiredArgument(args, "artifact-database"),
      artifactRootDirectory: requiredArgument(args, "artifact-root"),
      outputDirectory: requiredArgument(args, "output"),
      serverReleaseManifestPath: requiredArgument(
        args,
        "server-release-manifest",
      ),
      serverReleaseSignaturePath: requiredArgument(
        args,
        "server-release-signature",
      ),
    });
    return;
  }
  if (command === "restore") {
    assertArguments(args, [
      "artifact-authority-directory",
      "artifact-key-id",
      "backup",
      "server-release-manifest",
      "server-release-signature",
    ]);
    await restoreProductionBackup({
      ...common,
      artifactAuthorityDirectory: requiredArgument(
        args,
        "artifact-authority-directory",
      ),
      backupDirectory: requiredArgument(args, "backup"),
      expectedServerReleaseManifestPath: requiredArgument(
        args,
        "server-release-manifest",
      ),
      expectedServerReleaseSignaturePath: requiredArgument(
        args,
        "server-release-signature",
      ),
    });
    return;
  }
  throw new Error("backup_command_invalid");
}

function assertArguments(args, expected) {
  const actual = [...args.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
    throw new Error("backup_arguments_invalid");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0)
    throw new Error(`${name}_required`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "production_backup_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
