#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMPONENTS = ["control-api", "runtime-worker", "web-bff", "web"];
const TAG_PATTERN = /^server-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const IMAGE_PATTERN =
  /^ghcr\.io\/[a-z0-9](?:[a-z0-9._-]{0,254})\/[a-z0-9](?:[a-z0-9._/-]{0,254})$/u;

export function buildServerReleaseManifest({
  commit,
  images,
  publishedAt,
  repository,
  tag,
}) {
  const tagMatch = TAG_PATTERN.exec(tag);
  if (tagMatch === null) throw new Error("server_release_tag_invalid");
  if (!COMMIT_PATTERN.test(commit))
    throw new Error("server_release_commit_invalid");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository))
    throw new Error("server_release_repository_invalid");
  let canonicalDate;
  try {
    canonicalDate = new Date(publishedAt).toISOString();
  } catch {
    throw new Error("server_release_date_invalid");
  }
  if (canonicalDate !== publishedAt)
    throw new Error("server_release_date_invalid");
  if (!Array.isArray(images) || images.length !== COMPONENTS.length)
    throw new Error("server_release_image_set_invalid");
  const byComponent = new Map();
  for (const entry of images) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !COMPONENTS.includes(entry.component) ||
      byComponent.has(entry.component) ||
      typeof entry.image !== "string" ||
      !IMAGE_PATTERN.test(entry.image) ||
      typeof entry.digest !== "string" ||
      !SHA256_PATTERN.test(entry.digest)
    ) {
      throw new Error("server_release_image_invalid");
    }
    byComponent.set(entry.component, {
      digest: entry.digest,
      image: entry.image,
      reference: `${entry.image}@${entry.digest}`,
      sbom: "registry-attestation",
      provenance: "registry-attestation",
      signature: "sigstore-keyless",
    });
  }
  if (COMPONENTS.some((component) => !byComponent.has(component)))
    throw new Error("server_release_image_set_invalid");
  return {
    schemaVersion: "crewon.server-release.v0",
    tag,
    version: tagMatch[1],
    commit,
    repository,
    publishedAt,
    images: Object.fromEntries(
      COMPONENTS.map((component) => [component, byComponent.get(component)]),
    ),
  };
}

export function imageFromBuildMetadata({ component, image, metadata }) {
  if (!COMPONENTS.includes(component))
    throw new Error("server_release_component_invalid");
  if (!IMAGE_PATTERN.test(image))
    throw new Error("server_release_image_invalid");
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !SHA256_PATTERN.test(metadata["containerimage.digest"])
  ) {
    throw new Error("server_release_metadata_invalid");
  }
  return {
    component,
    image,
    digest: metadata["containerimage.digest"],
  };
}

export function parseServerReleaseManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("server_release_manifest_invalid");
  const keys = Object.keys(value).sort();
  const expected = [
    "commit",
    "images",
    "publishedAt",
    "repository",
    "schemaVersion",
    "tag",
    "version",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error("server_release_manifest_invalid");
  if (value.schemaVersion !== "crewon.server-release.v0")
    throw new Error("server_release_manifest_invalid");
  const imageEntries = Object.entries(value.images ?? {});
  const rebuilt = buildServerReleaseManifest({
    commit: value.commit,
    images: imageEntries.map(([component, entry]) => ({
      component,
      image: entry?.image,
      digest: entry?.digest,
    })),
    publishedAt: value.publishedAt,
    repository: value.repository,
    tag: value.tag,
  });
  if (
    rebuilt.version !== value.version ||
    JSON.stringify(rebuilt) !== JSON.stringify(value)
  ) {
    throw new Error("server_release_manifest_invalid");
  }
  return rebuilt;
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined)
      throw new Error("server_release_arguments_invalid");
    const key = name.slice(2);
    const current = values.get(key) ?? [];
    current.push(value);
    values.set(key, current);
  }
  return values;
}

function exactlyOne(args, name) {
  const values = args.get(name);
  if (values?.length !== 1) throw new Error(`server_release_${name}_invalid`);
  return values[0];
}

function runCli(args) {
  const command = args.shift();
  const values = parseArguments(args);
  if (command === "manifest") {
    const images = (values.get("image") ?? []).map((value) => {
      const parts = value.split(",");
      if (parts.length !== 3) throw new Error("server_release_image_invalid");
      const [component, image, metadataPath] = parts;
      return imageFromBuildMetadata({
        component,
        image,
        metadata: JSON.parse(readFileSync(resolve(metadataPath), "utf8")),
      });
    });
    const manifest = buildServerReleaseManifest({
      commit: exactlyOne(values, "commit"),
      images,
      publishedAt: exactlyOne(values, "published-at"),
      repository: exactlyOne(values, "repository"),
      tag: exactlyOne(values, "tag"),
    });
    writeFileSync(
      resolve(exactlyOne(values, "output")),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return;
  }
  if (command === "verify") {
    parseServerReleaseManifest(
      JSON.parse(readFileSync(resolve(exactlyOne(values, "manifest")), "utf8")),
    );
    return;
  }
  throw new Error("server_release_command_invalid");
}

if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  basename(process.argv[1]) === "server-release-tools.mjs"
) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "server_release_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
