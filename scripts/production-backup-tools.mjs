#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseServerReleaseManifest } from "./server-release-tools.mjs";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const MAX_BLOBS = 100_000;

export function snapshotArtifactAuthority({
  databasePath,
  destinationDirectory,
  rootDirectory,
}) {
  const sourceDatabase = absoluteExistingFile(
    databasePath,
    "backup_artifact_database_invalid",
  );
  const sourceRoot = absoluteExistingDirectory(
    rootDirectory,
    "backup_artifact_root_invalid",
  );
  const destination = absoluteNewDirectory(
    destinationDirectory,
    "backup_artifact_destination_invalid",
  );
  if (
    containsPath(sourceRoot, destination) ||
    containsPath(sourceRoot, sourceDatabase)
  ) {
    throw new Error("backup_artifact_path_overlap");
  }
  const database = new DatabaseSync(sourceDatabase);
  let transaction = false;
  try {
    const checkpoint = database
      .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
      .get();
    if (
      checkpoint === undefined ||
      checkpoint.busy !== 0 ||
      checkpoint.log !== checkpoint.checkpointed
    ) {
      throw new Error("backup_artifact_checkpoint_busy");
    }
    database.exec("BEGIN EXCLUSIVE");
    transaction = true;
    const pending = database
      .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE state <> 'ready'")
      .get();
    if (pending === undefined || pending.count !== 0) {
      throw new Error("backup_artifact_write_in_progress");
    }

    mkdirSync(destination, { recursive: false, mode: 0o700 });
    const metadataPath = join(destination, "metadata.sqlite3");
    copyDurably(sourceDatabase, metadataPath);
    const blobRoot = join(destination, "files");
    mkdirSync(blobRoot, { recursive: false, mode: 0o700 });
    const sourceFiles = regularFiles(sourceRoot);
    if (sourceFiles.length > MAX_BLOBS)
      throw new Error("backup_artifact_blob_limit_exceeded");
    const blobs = sourceFiles.map((sourcePath) => {
      const relativePath = normalizedRelativePath(sourceRoot, sourcePath);
      const targetPath = join(blobRoot, ...relativePath.split("/"));
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      copyDurably(sourcePath, targetPath);
      return fileDescriptor(targetPath, `artifacts/files/${relativePath}`);
    });
    blobs.sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    );
    database.exec("ROLLBACK");
    transaction = false;
    return {
      metadata: fileDescriptor(metadataPath, "artifacts/metadata.sqlite3"),
      blobs,
    };
  } finally {
    if (transaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original snapshot failure.
      }
    }
    database.close();
  }
}

export function snapshotServerRelease({ destinationPath, manifestPath }) {
  const source = absoluteExistingFile(
    manifestPath,
    "backup_server_release_manifest_invalid",
  );
  const destination = requireAbsolutePath(
    destinationPath,
    "backup_server_release_destination_invalid",
  );
  if (lstatSync(source).size > 1024 * 1024)
    throw new Error("backup_server_release_manifest_invalid");
  const raw = readFileSync(source);
  const release = parseServerReleaseManifest(JSON.parse(raw.toString("utf8")));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, raw, { flag: "wx", mode: 0o600 });
  syncFile(destination);
  return {
    manifest: fileDescriptor(destination, basename(destination)),
    tag: release.tag,
    commit: release.commit,
    images: Object.fromEntries(
      Object.entries(release.images).map(([component, image]) => [
        component,
        image.reference,
      ]),
    ),
  };
}

export function buildProductionBackupManifest({
  artifactKeyId,
  artifacts,
  createdAt,
  databaseSchema,
  postgresDump,
  serverRelease,
}) {
  if (!OPAQUE_PATTERN.test(artifactKeyId))
    throw new Error("backup_artifact_key_id_invalid");
  if (!SCHEMA_PATTERN.test(databaseSchema))
    throw new Error("backup_database_schema_invalid");
  requireCanonicalDate(createdAt);
  const manifest = {
    schemaVersion: "crewon.production-backup.v0",
    createdAt,
    database: {
      schema: databaseSchema,
      dump: validateDescriptor(postgresDump, "postgres.dump"),
    },
    artifacts: {
      keyId: artifactKeyId,
      metadata: validateDescriptor(
        artifacts?.metadata,
        "artifacts/metadata.sqlite3",
      ),
      blobs: validateBlobDescriptors(artifacts?.blobs),
    },
    serverRelease: validateReleaseEvidence(serverRelease),
  };
  return manifest;
}

export function parseProductionBackupManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("backup_manifest_invalid");
  const expected = [
    "artifacts",
    "createdAt",
    "database",
    "schemaVersion",
    "serverRelease",
  ].sort();
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected) ||
    value.schemaVersion !== "crewon.production-backup.v0"
  ) {
    throw new Error("backup_manifest_invalid");
  }
  const rebuilt = buildProductionBackupManifest({
    artifactKeyId: value.artifacts?.keyId,
    artifacts: value.artifacts,
    createdAt: value.createdAt,
    databaseSchema: value.database?.schema,
    postgresDump: value.database?.dump,
    serverRelease: value.serverRelease,
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(value))
    throw new Error("backup_manifest_invalid");
  return rebuilt;
}

export function fileDescriptor(path, archivePath) {
  const stats = lstatSync(path);
  if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0)
    throw new Error("backup_file_invalid");
  return {
    path: archivePath,
    bytes: stats.size,
    digest: `sha256:${digestFile(path)}`,
  };
}

export function verifyBackupFiles(rootDirectory, manifest) {
  const root = absoluteExistingDirectory(
    rootDirectory,
    "backup_directory_invalid",
  );
  const parsed = parseProductionBackupManifest(manifest);
  const descriptors = [
    parsed.database.dump,
    parsed.artifacts.metadata,
    ...parsed.artifacts.blobs,
    parsed.serverRelease.manifest,
  ];
  for (const descriptor of descriptors) {
    const path = resolve(root, ...descriptor.path.split("/"));
    if (relative(root, path).startsWith(".."))
      throw new Error("backup_file_path_invalid");
    if (
      JSON.stringify(fileDescriptor(path, descriptor.path)) !==
      JSON.stringify(descriptor)
    )
      throw new Error("backup_file_digest_mismatch");
  }
  const release = parseServerReleaseManifest(
    JSON.parse(
      readFileSync(
        resolve(root, ...parsed.serverRelease.manifest.path.split("/")),
        "utf8",
      ),
    ),
  );
  if (
    release.tag !== parsed.serverRelease.tag ||
    release.commit !== parsed.serverRelease.commit ||
    JSON.stringify(
      Object.fromEntries(
        Object.entries(release.images).map(([component, image]) => [
          component,
          image.reference,
        ]),
      ),
    ) !== JSON.stringify(parsed.serverRelease.images)
  ) {
    throw new Error("backup_server_release_mismatch");
  }
  return parsed;
}

function validateReleaseEvidence(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    !/^server-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.tag) ||
    !/^[a-f0-9]{40}$/u.test(value.commit) ||
    value.images === null ||
    typeof value.images !== "object" ||
    Array.isArray(value.images)
  ) {
    throw new Error("backup_server_release_invalid");
  }
  const components = ["control-api", "runtime-worker", "web-bff", "web"];
  if (
    JSON.stringify(Object.keys(value.images).sort()) !==
    JSON.stringify([...components].sort())
  ) {
    throw new Error("backup_server_release_invalid");
  }
  const images = Object.fromEntries(
    components.map((component) => {
      const reference = value.images[component];
      if (
        typeof reference !== "string" ||
        !/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(reference)
      ) {
        throw new Error("backup_server_release_invalid");
      }
      return [component, reference];
    }),
  );
  if (value.manifest?.bytes > 1024 * 1024)
    throw new Error("backup_server_release_invalid");
  return {
    manifest: validateDescriptor(
      value.manifest,
      "server-release-manifest.json",
    ),
    tag: value.tag,
    commit: value.commit,
    images,
  };
}

function validateBlobDescriptors(value) {
  if (!Array.isArray(value) || value.length > MAX_BLOBS)
    throw new Error("backup_artifact_blob_list_invalid");
  const blobs = value.map((descriptor) => validateDescriptor(descriptor));
  for (let index = 0; index < blobs.length; index += 1) {
    if (!/^artifacts\/files\/[A-Za-z0-9._/-]+$/u.test(blobs[index].path))
      throw new Error("backup_artifact_blob_path_invalid");
    if (
      index > 0 &&
      Buffer.compare(
        Buffer.from(blobs[index - 1].path),
        Buffer.from(blobs[index].path),
      ) >= 0
    ) {
      throw new Error("backup_artifact_blob_order_invalid");
    }
  }
  return blobs;
}

function validateDescriptor(value, expectedPath) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.path !== "string" ||
    (expectedPath !== undefined && value.path !== expectedPath) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    typeof value.digest !== "string" ||
    !DIGEST_PATTERN.test(value.digest)
  ) {
    throw new Error("backup_file_descriptor_invalid");
  }
  return { path: value.path, bytes: value.bytes, digest: value.digest };
}

function regularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("backup_artifact_link_forbidden");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("backup_artifact_file_type_forbidden");
      if (files.length > MAX_BLOBS)
        throw new Error("backup_artifact_blob_limit_exceeded");
    }
  };
  visit(root);
  return files;
}

function normalizedRelativePath(root, path) {
  const value = relative(root, path).split("\\").join("/");
  if (
    value.length === 0 ||
    value.startsWith("../") ||
    value.includes("/../") ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    !/^[A-Za-z0-9._/-]+$/u.test(value)
  ) {
    throw new Error("backup_artifact_path_invalid");
  }
  return value;
}

function copyDurably(source, destination) {
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  syncFile(destination);
}

function syncFile(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function digestFile(path) {
  const descriptor = openSync(path, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      digest.update(buffer.subarray(0, length));
    }
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function containsPath(root, candidate) {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function requireCanonicalDate(value) {
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error("backup_created_at_invalid");
  }
  if (canonical !== value) throw new Error("backup_created_at_invalid");
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

function absoluteExistingFile(value, code) {
  const path = requireAbsolutePath(value, code);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(code);
  return path;
}

function absoluteExistingDirectory(value, code) {
  const path = requireAbsolutePath(value, code);
  if (!existsSync(path) || !lstatSync(path).isDirectory())
    throw new Error(code);
  return path;
}

function absoluteNewDirectory(value, code) {
  const path = requireAbsolutePath(value, code);
  if (existsSync(path)) throw new Error(code);
  return path;
}
