import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  attestNodeDistribution,
  collectDesktopArtifacts,
  latestManifest,
  nodeReleasePlan,
  scanArtifactRoots,
  verifyReleaseChecks,
  windowsSigningConfig,
  writeUpdaterPublicKey,
} from "./desktop-release-tools.mjs";

test("plans official Node 24 distributions for both desktop targets", () => {
  assert.deepEqual(nodeReleasePlan("aarch64-apple-darwin", "24.18.1\n"), {
    archive: "node-v24.18.1-darwin-arm64.tar.gz",
    binaryRelativePath: "node-v24.18.1-darwin-arm64/bin/node",
    checksumsUrl: "https://nodejs.org/dist/v24.18.1/SHASUMS256.txt",
    downloadUrl:
      "https://nodejs.org/dist/v24.18.1/node-v24.18.1-darwin-arm64.tar.gz",
    platformKey: "darwin-aarch64",
    target: "aarch64-apple-darwin",
    version: "24.18.1",
  });
  assert.equal(
    nodeReleasePlan("x86_64-pc-windows-msvc", "24.18.1").binaryRelativePath,
    "node-v24.18.1-win-x64/node.exe",
  );
  assert.throws(
    () => nodeReleasePlan("aarch64-apple-darwin", "22.1.0"),
    /must_be_24/u,
  );
});

test("attests the archive against SHASUMS256 and binds the extracted binary digest", () => {
  const root = temporaryDirectory();
  const archive = join(root, "node-v24.18.1-darwin-arm64.tar.gz");
  const binary = join(root, "node-v24.18.1-darwin-arm64", "bin", "node");
  mkdirSync(join(root, "node-v24.18.1-darwin-arm64", "bin"), {
    recursive: true,
  });
  writeFileSync(archive, "official archive");
  writeFileSync(binary, "official node");
  const archiveDigest = digest(readFileSync(archive));
  const checksums = join(root, "SHASUMS256.txt");
  writeFileSync(
    checksums,
    `${archiveDigest}  node-v24.18.1-darwin-arm64.tar.gz\n`,
  );
  assert.equal(
    attestNodeDistribution({
      archivePath: archive,
      checksumsPath: checksums,
      extractedRoot: root,
      target: "aarch64-apple-darwin",
      versionText: "24.18.1",
    }).binarySha256,
    digest(Buffer.from("official node")),
  );
  writeFileSync(archive, "tampered");
  assert.throws(
    () =>
      attestNodeDistribution({
        archivePath: archive,
        checksumsPath: checksums,
        extractedRoot: root,
        target: "aarch64-apple-darwin",
        versionText: "24.18.1",
      }),
    /checksum_mismatch/u,
  );
});

test("scans packaged bytes including markers split across read chunks", () => {
  const root = temporaryDirectory();
  const clean = join(root, "clean.bin");
  writeFileSync(clean, Buffer.alloc(70_000, 0x61));
  assert.doesNotThrow(() => scanArtifactRoots([root]));
  writeFileSync(clean, `${"a".repeat(65_530)}crewon-device-runtime`);
  assert.throws(
    () => scanArtifactRoots([root]),
    /desktop_artifact_removed_marker/u,
  );
});

test("collects signed updater assets for macOS and Windows", () => {
  const mac = fixture("mac", "Crewon.dmg", "Crewon.app.tar.gz");
  assert.deepEqual(
    collectDesktopArtifacts({
      bundleRoot: mac.bundle,
      outputDirectory: mac.output,
      target: "aarch64-apple-darwin",
    }),
    {
      installerFile: "Crewon.dmg",
      platformKey: "darwin-aarch64",
      signature: "signed-mac",
      signatureFile: "Crewon.app.tar.gz.sig",
      target: "aarch64-apple-darwin",
      updaterFile: "Crewon.app.tar.gz",
    },
  );
  const windows = fixture(
    "windows",
    "Crewon_0.1.0_x64-setup.exe",
    "Crewon_0.1.0_x64-setup.exe",
  );
  assert.equal(
    collectDesktopArtifacts({
      bundleRoot: windows.bundle,
      outputDirectory: windows.output,
      target: "x86_64-pc-windows-msvc",
    }).platformKey,
    "windows-x86_64",
  );
});

test("merges exactly the two signed updater platforms", () => {
  const fragments = [
    {
      platformKey: "darwin-aarch64",
      signature: "mac",
      updaterFile: "Crewon.app.tar.gz",
    },
    {
      platformKey: "windows-x86_64",
      signature: "win",
      updaterFile: "Crewon setup.exe",
    },
  ];
  assert.deepEqual(
    latestManifest({
      fragments,
      publishedAt: "2026-08-14T00:00:00.000Z",
      repository: "DeadlyJoker/cuican-aide",
      tag: "desktop-v0.1.0",
      version: "0.1.0",
    }),
    {
      version: "0.1.0",
      notes: "Crewon desktop 0.1.0",
      pub_date: "2026-08-14T00:00:00.000Z",
      platforms: {
        "darwin-aarch64": {
          signature: "mac",
          url: "https://github.com/DeadlyJoker/cuican-aide/releases/download/desktop-v0.1.0/Crewon.app.tar.gz",
        },
        "windows-x86_64": {
          signature: "win",
          url: "https://github.com/DeadlyJoker/cuican-aide/releases/download/desktop-v0.1.0/Crewon%20setup.exe",
        },
      },
    },
  );
  assert.throws(
    () =>
      latestManifest({
        fragments: fragments.slice(0, 1),
        publishedAt: "2026-08-14T00:00:00.000Z",
        repository: "DeadlyJoker/cuican-aide",
        tag: "desktop-v0.1.0",
        version: "0.1.0",
      }),
    /platform_set_invalid/u,
  );
});

test("writes only a SHA-256 HTTPS Windows signing override", () => {
  assert.deepEqual(
    windowsSigningConfig({
      thumbprint: "A".repeat(40),
      timestampUrl: "https://timestamp.example.test",
    }),
    {
      bundle: {
        windows: {
          certificateThumbprint: "A".repeat(40),
          digestAlgorithm: "sha256",
          timestampUrl: "https://timestamp.example.test/",
        },
      },
    },
  );
  assert.throws(
    () =>
      windowsSigningConfig({
        thumbprint: "bad",
        timestampUrl: "http://timestamp.test",
      }),
    /thumbprint_invalid/u,
  );
});

test("writes the exact updater public key embedded in Tauri config", () => {
  const root = temporaryDirectory();
  const output = join(root, "updater.pub");
  writeUpdaterPublicKey({
    configPath: join(
      import.meta.dirname,
      "..",
      "apps",
      "crewon-ui",
      "src-tauri",
      "tauri.conf.json",
    ),
    outputPath: output,
  });
  assert.equal(
    readFileSync(output, "utf8"),
    "untrusted comment: minisign public key: 118CA5AE059C230D\n" +
      "RWQNI5wFrqWMES5TzpOjJSNXOhYk1H311BPkej9W69zdDPDtOcQe4zI7\n",
  );
  assert.throws(
    () =>
      writeUpdaterPublicKey({
        configPath: join(
          import.meta.dirname,
          "..",
          "apps",
          "crewon-ui",
          "src-tauri",
          "tauri.conf.json",
        ),
        outputPath: output,
      }),
    /public_key_output_invalid/u,
  );
});

test("rejects malformed updater public key configuration", () => {
  const root = temporaryDirectory();
  const config = join(root, "tauri.conf.json");
  writeFileSync(
    config,
    JSON.stringify({ plugins: { updater: { pubkey: "!!!!" } } }),
  );
  assert.throws(
    () =>
      writeUpdaterPublicKey({
        configPath: config,
        outputPath: join(root, "updater.pub"),
      }),
    /public_key_invalid/u,
  );
  writeFileSync(config, "not json");
  assert.throws(
    () =>
      writeUpdaterPublicKey({
        configPath: config,
        outputPath: join(root, "updater.pub"),
      }),
    /updater_config_invalid/u,
  );
});

test("requires every ruleset-bound check run to succeed on the release commit", () => {
  const commitSha = "a".repeat(40);
  assert.doesNotThrow(() =>
    verifyReleaseChecks({
      branchProtection: branchProtection([]),
      checkRuns: {
        total_count: 2,
        check_runs: [
          checkRun("TypeScript CI", commitSha, 101),
          checkRun("Bazel", commitSha, 202),
        ],
      },
      commitSha,
      rules: [
        requiredChecksRule([
          { context: "TypeScript CI", integration_id: 101 },
          { context: "Bazel", integration_id: 202 },
        ]),
      ],
    }),
  );
});

test("rejects incomplete, failed, or app-mismatched required check runs", () => {
  const commitSha = "b".repeat(40);
  const rules = [requiredChecksRule([{ context: "CI", integration_id: 101 }])];
  assert.throws(
    () =>
      verifyReleaseChecks({
        branchProtection: branchProtection([]),
        checkRuns: {
          total_count: 2,
          check_runs: [checkRun("CI", commitSha, 101)],
        },
        commitSha,
        rules,
      }),
    /check_runs_incomplete/u,
  );
  assert.throws(
    () =>
      verifyReleaseChecks({
        branchProtection: branchProtection([]),
        checkRuns: {
          total_count: 1,
          check_runs: [checkRun("CI", commitSha, 101, "failure")],
        },
        commitSha,
        rules,
      }),
    /required_check_failed/u,
  );
  assert.throws(
    () =>
      verifyReleaseChecks({
        branchProtection: branchProtection([]),
        checkRuns: {
          total_count: 1,
          check_runs: [checkRun("CI", commitSha, 999)],
        },
        commitSha,
        rules,
      }),
    /required_check_ambiguous/u,
  );
  assert.throws(
    () =>
      verifyReleaseChecks({
        branchProtection: branchProtection([]),
        checkRuns: { total_count: 0, check_runs: [] },
        commitSha: "c".repeat(40),
        rules: [],
      }),
    /required_checks_missing/u,
  );
});

test("accepts classic main branch protection returned by GraphQL", () => {
  const commitSha = "d".repeat(40);
  assert.doesNotThrow(() =>
    verifyReleaseChecks({
      branchProtection: branchProtection([
        {
          matchingRefs: refConnection([{ name: "main" }]),
          requiredStatusChecks: [
            { app: { databaseId: 303 }, context: "Classic CI" },
          ],
          requiresStatusChecks: true,
        },
      ]),
      checkRuns: {
        total_count: 1,
        check_runs: [checkRun("Classic CI", commitSha, 303)],
      },
      commitSha,
      rules: [],
    }),
  );
});

function fixture(name, installerName, updaterName) {
  const root = temporaryDirectory();
  const bundle = join(root, name, "bundle");
  const output = join(root, name, "release");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, installerName), "installer");
  writeFileSync(join(bundle, updaterName), "updater");
  writeFileSync(join(bundle, `${updaterName}.sig`), `signed-${name}`);
  return { bundle, output };
}

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "crewon-desktop-release-"));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredChecksRule(requiredStatusChecks) {
  return {
    type: "required_status_checks",
    parameters: { required_status_checks: requiredStatusChecks },
  };
}

function checkRun(name, headSha, appId, conclusion = "success") {
  return {
    app: { id: appId },
    conclusion,
    head_sha: headSha,
    name,
    status: "completed",
  };
}

function branchProtection(nodes) {
  return {
    data: {
      repository: {
        branchProtectionRules: {
          nodes,
          pageInfo: { hasNextPage: false },
          totalCount: nodes.length,
        },
      },
    },
  };
}

function refConnection(nodes) {
  return {
    nodes,
    pageInfo: { hasNextPage: false },
    totalCount: nodes.length,
  };
}
