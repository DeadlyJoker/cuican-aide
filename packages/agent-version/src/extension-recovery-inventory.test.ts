import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  commitExtensionRecoveryCapsule,
  listExtensionRecoveryCapsules,
  putExtensionRecoveryFile,
  type ExtensionRecoveryInputFile,
  type ExtensionRecoveryManifest,
} from "./extension-recovery.ts";

const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const files = [
  "plugin-bindings.json",
  "plugin-assets.json",
  "base-bindings.json",
  "bootstrap.json",
  "release.json",
  "snapshot-00.json",
] as const satisfies readonly ExtensionRecoveryInputFile[];
function fixture(t: TestContext) {
  const owned = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-capsule-inventory-")),
  );
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  const dataRoot = join(owned, "data");
  mkdirSync(dataRoot);
  return { owned, dataRoot, root: join(dataRoot, "extension-recoveries") };
}
async function completed(dataRoot: string, name: string) {
  const selection = { dataRoot, capsuleId: digest(name) };
  const pins = [];
  // These fixtures prove only committed JSON byte verification, never runtime readiness.
  for (const file of files)
    pins.push(
      await putExtensionRecoveryFile({
        selection,
        file,
        bytes: Buffer.from(`${JSON.stringify({ file, fixture: true })}\n`),
      }),
    );
  const manifest: ExtensionRecoveryManifest = {
    schemaVersion: "crewon.extension-recovery-capsule.v0",
    capsuleId: selection.capsuleId,
    owner: {
      tenantId: "tenant",
      spaceId: "space",
      actorId: "actor",
      principalId: "principal",
    },
    implementationDigest: digest("source-fixture"),
    buildIdentityDigest: digest("collection-fixture"),
    providerBinding: {
      providerId: "local-model",
      endpoint: "http://127.0.0.1:8000/v1",
      responsesEndpoint: "http://127.0.0.1:8000/v1/responses",
      credentialRequired: false,
    },
    releaseId: "release-fixture",
    registrations: [
      {
        pluginId: "crewon.fixture",
        pluginVersion: "1.0.0",
        manifestDigest: digest("manifest-fixture"),
        implementationDigest: digest("registration-fixture"),
      },
    ],
    targets: [
      {
        executionAuthority: "crewonKernel",
        agentVersionId: "agent-fixture",
        agentVersionContentDigest: digest("content-fixture"),
        materializationDigest: digest("materialization-fixture"),
        authorityId: "authority",
        runtimeGeneration: "generation",
        policySnapshotId: "policy",
        workspaceBindingId: null,
      },
    ],
    files: pins,
  };
  return commitExtensionRecoveryCapsule({ selection, manifest });
}

test("missing inventory stays absent and complete capsules are deterministically sorted, pinned and frozen", async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    await listExtensionRecoveryCapsules({ dataRoot: f.dataRoot }),
    { capsules: [], unavailable: [] },
  );
  assert.equal(existsSync(f.root), false);
  const first = await completed(f.dataRoot, "first");
  const second = await completed(f.dataRoot, "second");
  const result = await listExtensionRecoveryCapsules({ dataRoot: f.dataRoot });
  assert.deepEqual(
    result.capsules,
    [first, second].sort((a, b) =>
      a.manifest.capsuleId.localeCompare(b.manifest.capsuleId),
    ),
  );
  assert.deepEqual(result.unavailable, []);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.capsules));
  assert.ok(Object.isFrozen(result.unavailable));
});

test("partial, corrupt, non-directory and orphan-mutation entries are unavailable without promotion or deletion", async (t) => {
  const f = fixture(t);
  const valid = await completed(f.dataRoot, "valid");
  const corrupt = await completed(f.dataRoot, "corrupt");
  writeFileSync(join(corrupt.directory, "snapshot-00.json"), "{}\n");
  const locked = await completed(f.dataRoot, "mutation-orphan");
  writeFileSync(join(locked.directory, ".mutation-lock"), "owned-lock-fixture");
  const partialId = digest("partial");
  const partial = join(f.root, partialId.slice(7));
  mkdirSync(partial);
  writeFileSync(join(partial, "plugin-assets.json"), "{}\n");
  const fileId = digest("non-directory");
  const nonDirectory = join(f.root, fileId.slice(7));
  writeFileSync(nonDirectory, "non-directory-fixture");
  const result = await listExtensionRecoveryCapsules({ dataRoot: f.dataRoot });
  assert.deepEqual(result.capsules, [valid]);
  assert.deepEqual(
    result.unavailable,
    [corrupt.manifest.capsuleId, locked.manifest.capsuleId, partialId, fileId]
      .sort()
      .map((capsuleId) => ({
        capsuleId,
        reasonCode: "extension_recovery_capsule_unavailable",
      })),
  );
  assert.equal(existsSync(join(partial, "manifest.json")), false);
  assert.equal(
    readFileSync(join(corrupt.directory, "snapshot-00.json"), "utf8"),
    "{}\n",
  );
  assert.equal(readFileSync(nonDirectory, "utf8"), "non-directory-fixture");
  assert.ok(existsSync(join(locked.directory, ".mutation-lock")));
});

test("capsule and pinned-file symlinks are not followed", async (t) => {
  const f = fixture(t);
  const valid = await completed(f.dataRoot, "valid-target");
  const aliasId = digest("symlink-capsule");
  symlinkSync(valid.directory, join(f.root, aliasId.slice(7)), "dir");
  const linked = await completed(f.dataRoot, "linked-input");
  const original = join(linked.directory, "bootstrap.json");
  rmSync(original);
  symlinkSync(join(valid.directory, "bootstrap.json"), original);
  const result = await listExtensionRecoveryCapsules({ dataRoot: f.dataRoot });
  assert.deepEqual(result.capsules, [valid]);
  assert.deepEqual(
    result.unavailable.map((item) => item.capsuleId),
    [aliasId, linked.manifest.capsuleId].sort(),
  );
  assert.ok(existsSync(join(valid.directory, "manifest.json")));
});

test("root and ancestor symlinks are rejected and fixed allocation locks do not count as capsules", async (t) => {
  const f = fixture(t);
  const valid = await completed(f.dataRoot, "valid");
  writeFileSync(join(f.root, ".allocation-lock"), "allocation-fixture");
  assert.deepEqual(
    (await listExtensionRecoveryCapsules({ dataRoot: f.dataRoot })).capsules,
    [valid],
  );
  const ancestor = join(f.owned, "ancestor-link");
  symlinkSync(f.owned, ancestor, "dir");
  await assert.rejects(
    listExtensionRecoveryCapsules({ dataRoot: join(ancestor, "data") }),
    /extension_recovery_directory_invalid/u,
  );
  const dataAlias = join(f.owned, "data-alias");
  symlinkSync(f.dataRoot, dataAlias, "dir");
  await assert.rejects(
    listExtensionRecoveryCapsules({ dataRoot: dataAlias }),
    /extension_recovery_directory_invalid/u,
  );
  const otherData = join(f.owned, "other-data");
  mkdirSync(otherData);
  symlinkSync(f.root, join(otherData, "extension-recoveries"), "dir");
  await assert.rejects(
    listExtensionRecoveryCapsules({ dataRoot: otherData }),
    /extension_recovery_directory_invalid/u,
  );
});

test("inventory rejects unexpected names and nonregular allocation locks", async (t) => {
  for (const name of [
    "arbitrary-worker.mjs",
    "A".repeat(64),
    ".allocation-lock",
  ])
    await t.test(name, async (sub) => {
      const f = fixture(sub);
      mkdirSync(f.root);
      if (name === ".allocation-lock")
        symlinkSync(f.dataRoot, join(f.root, name));
      else writeFileSync(join(f.root, name), "unexpected-fixture");
      await assert.rejects(
        listExtensionRecoveryCapsules({ dataRoot: f.dataRoot }),
        /extension_recovery_inventory_invalid/u,
      );
    });
});

test("all 64 fixed directories are bounded and a 65th is rejected before resolution", async (t) => {
  const f = fixture(t);
  mkdirSync(f.root);
  for (let index = 0; index < 64; index++)
    mkdirSync(join(f.root, digest(`partial-${index}`).slice(7)));
  writeFileSync(join(f.root, ".allocation-lock"), "allocation-fixture");
  const result = await listExtensionRecoveryCapsules({ dataRoot: f.dataRoot });
  assert.equal(result.capsules.length, 0);
  assert.equal(result.unavailable.length, 64);
  mkdirSync(join(f.root, digest("partial-65").slice(7)));
  await assert.rejects(
    listExtensionRecoveryCapsules({ dataRoot: f.dataRoot }),
    /extension_recovery_inventory_invalid/u,
  );
});

test("inventory copies strict path inputs before its first await", async (t) => {
  const f = fixture(t);
  const valid = await completed(f.dataRoot, "snapshot");
  const input = { dataRoot: f.dataRoot };
  const result = listExtensionRecoveryCapsules(input);
  input.dataRoot = "/changed/unavailable/root";
  assert.deepEqual((await result).capsules, [valid]);
  let reads = 0;
  const accessor = Object.defineProperty({}, "dataRoot", {
    enumerable: true,
    get() {
      reads++;
      return f.dataRoot;
    },
  });
  for (const value of [
    accessor,
    { dataRoot: f.dataRoot, unexpected: true },
    { dataRoot: "relative" },
    { dataRoot: `${f.dataRoot}\n` },
  ])
    await assert.rejects(
      listExtensionRecoveryCapsules(value as { dataRoot: string }),
      /extension_recovery_.*invalid/u,
    );
  assert.equal(reads, 0);
});
