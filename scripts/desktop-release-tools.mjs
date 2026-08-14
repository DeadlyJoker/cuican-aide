#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { REMOVED_RUNTIME_MARKERS } from "./stage-desktop-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = {
  "aarch64-apple-darwin": {
    nodePlatform: "darwin-arm64",
    nodeBinary: "bin/node",
    platformKey: "darwin-aarch64",
    installerPattern: /\.dmg$/u,
    updaterPattern: /\.app\.tar\.gz$/u,
  },
  "x86_64-pc-windows-msvc": {
    nodePlatform: "win-x64",
    nodeBinary: "node.exe",
    platformKey: "windows-x86_64",
    installerPattern: /-setup\.exe$/u,
    updaterPattern: /-setup\.exe$/u,
  },
};
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function nodeReleasePlan(target, versionText) {
  const descriptor = targets[target];
  if (descriptor === undefined)
    throw new Error(`desktop_target_unsupported:${target}`);
  const version = versionText.trim();
  if (!/^24\.\d+\.\d+$/u.test(version))
    throw new Error("desktop_node_version_must_be_24");
  const distribution = `node-v${version}-${descriptor.nodePlatform}`;
  const archive = `${distribution}${target.includes("windows") ? ".zip" : ".tar.gz"}`;
  const baseUrl = `https://nodejs.org/dist/v${version}`;
  return {
    archive,
    binaryRelativePath: join(distribution, descriptor.nodeBinary),
    checksumsUrl: `${baseUrl}/SHASUMS256.txt`,
    downloadUrl: `${baseUrl}/${archive}`,
    platformKey: descriptor.platformKey,
    target,
    version,
  };
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function attestNodeDistribution({
  archivePath,
  checksumsPath,
  extractedRoot,
  target,
  versionText,
}) {
  const plan = nodeReleasePlan(target, versionText);
  const matches = readFileSync(checksumsPath, "utf8")
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/u.exec(line.trim());
      return match?.[2] === plan.archive ? [match[1]] : [];
    });
  if (matches.length !== 1)
    throw new Error("desktop_node_checksum_entry_invalid");
  if (sha256File(archivePath) !== matches[0])
    throw new Error("desktop_node_archive_checksum_mismatch");
  const binaryPath = resolve(extractedRoot, plan.binaryRelativePath);
  if (!lstatSync(binaryPath).isFile())
    throw new Error("desktop_node_binary_missing");
  return { ...plan, binaryPath, binarySha256: sha256File(binaryPath) };
}

export function scanArtifactRoots(roots) {
  for (const root of roots) {
    for (const path of regularFiles(resolve(root))) scanFile(path);
  }
}

export function collectDesktopArtifacts({
  bundleRoot,
  outputDirectory,
  target,
}) {
  const descriptor = targets[target];
  if (descriptor === undefined)
    throw new Error(`desktop_target_unsupported:${target}`);
  const files = regularFiles(resolve(bundleRoot));
  const installer = exactlyOne(
    files.filter((path) => descriptor.installerPattern.test(path)),
    "installer",
  );
  const updater = exactlyOne(
    files.filter((path) => descriptor.updaterPattern.test(path)),
    "updater",
  );
  const signature = `${updater}.sig`;
  if (!files.includes(signature))
    throw new Error("desktop_updater_signature_missing");
  const signatureText = readFileSync(signature, "utf8").trim();
  if (signatureText.length === 0 || signatureText.length > 16_384) {
    throw new Error("desktop_updater_signature_invalid");
  }
  mkdirSync(outputDirectory, { recursive: true });
  const copied = new Set();
  for (const path of [installer, updater, signature]) {
    if (!copied.has(path))
      copyFileSync(path, join(outputDirectory, basename(path)));
    copied.add(path);
  }
  const fragment = {
    installerFile: basename(installer),
    platformKey: descriptor.platformKey,
    signature: signatureText,
    signatureFile: basename(signature),
    target,
    updaterFile: basename(updater),
  };
  writeFileSync(
    join(outputDirectory, `fragment-${descriptor.platformKey}.json`),
    `${JSON.stringify(fragment, null, 2)}\n`,
  );
  return fragment;
}

export function latestManifest({
  fragments,
  publishedAt,
  repository,
  tag,
  version,
}) {
  if (!semver.test(version) || tag !== `desktop-v${version}`)
    throw new Error("desktop_release_version_invalid");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository))
    throw new Error("desktop_release_repository_invalid");
  if (!Number.isFinite(Date.parse(publishedAt)))
    throw new Error("desktop_release_date_invalid");
  const byPlatform = new Map(
    fragments.map((fragment) => [fragment.platformKey, fragment]),
  );
  const requiredPlatforms = ["darwin-aarch64", "windows-x86_64"];
  if (
    fragments.length !== requiredPlatforms.length ||
    requiredPlatforms.some((key) => !byPlatform.has(key))
  ) {
    throw new Error("desktop_release_platform_set_invalid");
  }
  return {
    version,
    notes: `Crewon desktop ${version}`,
    pub_date: publishedAt,
    platforms: Object.fromEntries(
      requiredPlatforms.map((key) => {
        const fragment = byPlatform.get(key);
        if (
          typeof fragment.signature !== "string" ||
          fragment.signature.length === 0
        ) {
          throw new Error("desktop_release_signature_invalid");
        }
        return [
          key,
          {
            signature: fragment.signature,
            url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(fragment.updaterFile)}`,
          },
        ];
      }),
    ),
  };
}

export function windowsSigningConfig({ thumbprint, timestampUrl }) {
  if (!/^[A-F0-9]{40}$/u.test(thumbprint))
    throw new Error("windows_certificate_thumbprint_invalid");
  const parsed = new URL(timestampUrl);
  if (parsed.protocol !== "https:")
    throw new Error("windows_timestamp_url_invalid");
  return {
    bundle: {
      windows: {
        certificateThumbprint: thumbprint,
        digestAlgorithm: "sha256",
        timestampUrl: parsed.toString(),
      },
    },
  };
}

export function writeUpdaterPublicKey({ configPath, outputPath }) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("desktop_updater_config_invalid");
  }
  const encoded = config?.plugins?.updater?.pubkey;
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length > 16_384 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    throw new Error("desktop_updater_public_key_invalid");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded)
    throw new Error("desktop_updater_public_key_invalid");
  let publicKey;
  try {
    publicKey = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(decoded);
  } catch {
    throw new Error("desktop_updater_public_key_invalid");
  }
  if (
    !/^untrusted comment: [^\r\n]{1,1024}\n[A-Za-z0-9+/]{56}\n$/u.test(
      publicKey,
    )
  ) {
    throw new Error("desktop_updater_public_key_invalid");
  }
  try {
    writeFileSync(outputPath, decoded, { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("desktop_updater_public_key_output_invalid");
  }
}

export function verifyReleaseChecks({
  branchProtection,
  checkRuns,
  commitSha,
  rules,
}) {
  if (!/^[a-f0-9]{40}$/u.test(commitSha))
    throw new Error("desktop_release_commit_invalid");
  if (!Array.isArray(rules) || rules.length >= 100)
    throw new Error("desktop_release_rules_invalid");
  const requirements = new Map();
  for (const rule of rules) {
    if (rule?.type !== "required_status_checks") continue;
    const required = rule.parameters?.required_status_checks;
    if (!Array.isArray(required))
      throw new Error("desktop_release_rules_invalid");
    for (const value of required) {
      const context = value?.context;
      const integrationId = value?.integration_id ?? null;
      if (
        typeof context !== "string" ||
        context.length === 0 ||
        context.length > 512 ||
        /[\r\n]/u.test(context) ||
        (integrationId !== null &&
          (!Number.isSafeInteger(integrationId) || integrationId <= 0))
      ) {
        throw new Error("desktop_release_rules_invalid");
      }
      requirements.set(`${context}\0${integrationId ?? "any"}`, {
        context,
        integrationId,
      });
    }
  }
  const protection = branchProtection?.data?.repository?.branchProtectionRules;
  if (
    !Number.isSafeInteger(protection?.totalCount) ||
    !Array.isArray(protection?.nodes) ||
    protection.totalCount !== protection.nodes.length ||
    protection.pageInfo?.hasNextPage !== false
  ) {
    throw new Error("desktop_release_branch_protection_invalid");
  }
  for (const rule of protection.nodes) {
    const matchingRefs = rule?.matchingRefs;
    if (
      !Number.isSafeInteger(matchingRefs?.totalCount) ||
      !Array.isArray(matchingRefs?.nodes) ||
      matchingRefs.totalCount !== matchingRefs.nodes.length ||
      matchingRefs.pageInfo?.hasNextPage !== false
    ) {
      throw new Error("desktop_release_branch_protection_invalid");
    }
    if (!matchingRefs.nodes.some((ref) => ref?.name === "main")) continue;
    if (
      rule.requiresStatusChecks !== true ||
      !Array.isArray(rule.requiredStatusChecks)
    )
      throw new Error("desktop_release_branch_protection_invalid");
    for (const value of rule.requiredStatusChecks) {
      const context = value?.context;
      const integrationId = value?.app?.databaseId ?? null;
      if (
        typeof context !== "string" ||
        context.length === 0 ||
        context.length > 512 ||
        /[\r\n]/u.test(context) ||
        (integrationId !== null &&
          (!Number.isSafeInteger(integrationId) || integrationId <= 0))
      ) {
        throw new Error("desktop_release_branch_protection_invalid");
      }
      requirements.set(`${context}\0${integrationId ?? "any"}`, {
        context,
        integrationId,
      });
    }
  }
  if (requirements.size === 0)
    throw new Error("desktop_release_required_checks_missing");
  if (
    !Number.isSafeInteger(checkRuns?.total_count) ||
    !Array.isArray(checkRuns?.check_runs) ||
    checkRuns.total_count !== checkRuns.check_runs.length
  ) {
    throw new Error("desktop_release_check_runs_incomplete");
  }

  for (const requirement of requirements.values()) {
    const matches = checkRuns.check_runs.filter(
      (run) =>
        run?.name === requirement.context &&
        run?.head_sha === commitSha &&
        (requirement.integrationId === null ||
          run?.app?.id === requirement.integrationId),
    );
    if (matches.length !== 1)
      throw new Error(
        `desktop_release_required_check_ambiguous:${requirement.context}`,
      );
    if (
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    ) {
      throw new Error(
        `desktop_release_required_check_failed:${requirement.context}`,
      );
    }
  }
}

function exactlyOne(values, kind) {
  if (values.length !== 1)
    throw new Error(`desktop_${kind}_count_invalid:${values.length}`);
  return values[0];
}

function regularFiles(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  return readdirSync(root).flatMap((entry) => regularFiles(join(root, entry)));
}

function scanFile(path) {
  const markerBuffers = REMOVED_RUNTIME_MARKERS.map((marker) => [
    marker,
    Buffer.from(marker),
  ]);
  const overlap =
    Math.max(...markerBuffers.map(([, marker]) => marker.length)) - 1;
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let carry = Buffer.alloc(0);
  const descriptor = openSync(path, "r");
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = Buffer.concat([carry, buffer.subarray(0, count)]);
      for (const [marker, encoded] of markerBuffers) {
        if (chunk.includes(encoded))
          throw new Error(`desktop_artifact_removed_marker:${marker}:${path}`);
      }
      carry = chunk.subarray(Math.max(0, chunk.length - overlap));
    }
  } finally {
    closeSync(descriptor);
  }
}

function options(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error("desktop_release_arguments_invalid");
    const values = parsed.get(key) ?? [];
    values.push(value);
    parsed.set(key, values);
  }
  return {
    one(name) {
      const values = parsed.get(`--${name}`) ?? [];
      if (values.length !== 1)
        throw new Error(`desktop_release_argument_invalid:${name}`);
      return values[0];
    },
    many(name) {
      return parsed.get(`--${name}`) ?? [];
    },
  };
}

function appendOutputs(path, values) {
  for (const [key, value] of Object.entries(values)) {
    const text = String(value);
    if (/[\r\n]/u.test(text))
      throw new Error(`desktop_release_output_invalid:${key}`);
    appendFileSync(path, `${key}=${text}\n`);
  }
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  const input = options(argv);
  if (command === "node-plan") {
    const plan = nodeReleasePlan(
      input.one("target"),
      readFileSync(join(repoRoot, ".node-version"), "utf8"),
    );
    appendOutputs(input.one("github-output"), {
      archive: plan.archive,
      checksums_url: plan.checksumsUrl,
      download_url: plan.downloadUrl,
      platform_key: plan.platformKey,
      version: plan.version,
    });
    return;
  }
  if (command === "attest-node") {
    const result = attestNodeDistribution({
      archivePath: input.one("archive"),
      checksumsPath: input.one("checksums"),
      extractedRoot: input.one("extracted-root"),
      target: input.one("target"),
      versionText: readFileSync(join(repoRoot, ".node-version"), "utf8"),
    });
    appendOutputs(input.one("github-output"), {
      node_binary: result.binaryPath,
      node_binary_sha256: result.binarySha256,
    });
    return;
  }
  if (command === "scan") {
    const roots = input.many("root");
    if (roots.length === 0)
      throw new Error("desktop_release_scan_roots_required");
    scanArtifactRoots(roots);
    return;
  }
  if (command === "collect") {
    collectDesktopArtifacts({
      bundleRoot: input.one("bundle-root"),
      outputDirectory: input.one("output"),
      target: input.one("target"),
    });
    return;
  }
  if (command === "merge") {
    const fragmentDirectory = input.one("fragments");
    const fragments = readdirSync(fragmentDirectory)
      .filter((name) => /^fragment-.+\.json$/u.test(name))
      .map((name) =>
        JSON.parse(readFileSync(join(fragmentDirectory, name), "utf8")),
      );
    const version = JSON.parse(
      readFileSync(join(repoRoot, "apps", "crewon-ui", "package.json"), "utf8"),
    ).version;
    const manifest = latestManifest({
      fragments,
      publishedAt: new Date().toISOString(),
      repository: input.one("repository"),
      tag: input.one("tag"),
      version,
    });
    writeFileSync(
      input.one("output"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return;
  }
  if (command === "windows-config") {
    const config = windowsSigningConfig({
      thumbprint: input.one("thumbprint"),
      timestampUrl: input.one("timestamp-url"),
    });
    writeFileSync(input.one("output"), `${JSON.stringify(config, null, 2)}\n`);
    return;
  }
  if (command === "updater-public-key") {
    writeUpdaterPublicKey({
      configPath: input.one("config"),
      outputPath: input.one("output"),
    });
    return;
  }
  if (command === "verify-release-checks") {
    verifyReleaseChecks({
      branchProtection: JSON.parse(
        readFileSync(input.one("branch-protection"), "utf8"),
      ),
      checkRuns: JSON.parse(readFileSync(input.one("check-runs"), "utf8")),
      commitSha: input.one("commit"),
      rules: JSON.parse(readFileSync(input.one("rules"), "utf8")),
    });
    return;
  }
  throw new Error(`desktop_release_command_invalid:${command ?? ""}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
