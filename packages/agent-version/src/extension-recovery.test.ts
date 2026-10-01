import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import fileSystemPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  parseExtensionHostActor,
  parseExtensionHostRegistrationIdentity,
} from "@crewon/contracts";
import { parseExtensionExecutionTarget } from "@crewon/domain";
import {
  commitExtensionRecoveryCapsule,
  extensionRecoveryDirectory,
  parseExtensionRecoveryManifest,
  parseExtensionRecoveryProviderBinding,
  putExtensionRecoveryFile,
  readExtensionRecoveryFile,
  resolveExtensionRecoveryCapsule,
  type ExtensionRecoveryFilePin,
  type ExtensionRecoveryInputFile,
  type ExtensionRecoveryManifest,
  type ExtensionRecoverySelection,
} from "./extension-recovery.ts";

const inputNames = [
  "plugin-bindings.json",
  "plugin-assets.json",
  "base-bindings.json",
  "bootstrap.json",
  "release.json",
  "snapshot-00.json",
] as const satisfies readonly ExtensionRecoveryInputFile[];
const owner = parseExtensionHostActor({
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
});
const registration = parseExtensionHostRegistrationIdentity({
  pluginId: "crewon.comfyui-krea2",
  pluginVersion: "1.0.0",
  manifestDigest: digest("manifest-fixture"),
  implementationDigest: digest("registered-adapter-fixture"),
});
const target = parseExtensionExecutionTarget({
  executionAuthority: "crewonKernel",
  agentVersionId: "prepared-agent-1",
  agentVersionContentDigest: digest("agent-content-fixture"),
  materializationDigest: digest("materialization-fixture"),
  authorityId: "standalone-authority",
  runtimeGeneration: "retained-generation-1",
  policySnapshotId: "standalone-policy-v0",
  workspaceBindingId: null,
});

function digest(input: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function fixture(context: TestContext) {
  const dataRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-recovery-fs-"),
  );
  context.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const selection = { dataRoot, capsuleId: digest("capsule-1") };
  return {
    dataRoot,
    selection,
    directory: join(
      dataRoot,
      "extension-recoveries",
      selection.capsuleId.slice(7),
    ),
  };
}

function manifest(
  selection: ExtensionRecoverySelection,
  files: readonly ExtensionRecoveryFilePin[],
): ExtensionRecoveryManifest {
  return {
    schemaVersion: "crewon.extension-recovery-capsule.v0",
    capsuleId: selection.capsuleId,
    owner,
    implementationDigest: digest("source-build-fixture"),
    buildIdentityDigest: digest("seven-bundle-fixture"),
    providerBinding: {
      providerId: "local-model",
      endpoint: "http://127.0.0.1:8000/v1",
      responsesEndpoint: "http://127.0.0.1:8000/v1/responses",
      credentialRequired: false,
    },
    releaseId: "verified-release-fixture",
    registrations: [registration],
    targets: [target],
    files,
  };
}

async function prepared(context: TestContext) {
  const value = fixture(context);
  const contents = new Map<ExtensionRecoveryInputFile, Buffer>();
  const files: ExtensionRecoveryFilePin[] = [];
  for (const file of inputNames) {
    // These are JSON byte fixtures, not assertions that arbitrary documents are executable.
    const bytes = Buffer.from(JSON.stringify({ file, fixture: true }) + "\n");
    contents.set(file, bytes);
    files.push(
      await putExtensionRecoveryFile({
        selection: value.selection,
        file,
        bytes,
      }),
    );
  }
  return { ...value, contents, manifest: manifest(value.selection, files) };
}

async function completed(context: TestContext) {
  const value = await prepared(context);
  const resolved = await commitExtensionRecoveryCapsule({
    selection: value.selection,
    manifest: value.manifest,
  });
  return { ...value, resolved };
}

function pauseLink(context: TestContext, file: string) {
  const original = fileSystemPromises.link;
  let entered!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  context.mock.method(
    fileSystemPromises,
    "link",
    async (
      source: Parameters<typeof original>[0],
      destination: Parameters<typeof original>[1],
    ) => {
      if (String(destination).endsWith(`/${file}`)) {
        entered();
        await blocked;
      }
      return original(source, destination);
    },
  );
  syncBuiltinESMExports();
  return {
    reached,
    resume,
    restore: () => {
      resume();
      context.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

test(
  "marker publication and new input publication serialize with deterministic real-FS scheduling",
  { timeout: 10_000 },
  async (context) => {
    await context.test(
      "commit owns the lock first, then the new snapshot is rejected as immutable",
      async (context) => {
        const value = await prepared(context);
        const gate = pauseLink(context, "manifest.json");
        try {
          const commit = commitExtensionRecoveryCapsule({
            selection: value.selection,
            manifest: value.manifest,
          });
          await gate.reached;
          assert.equal(
            existsSync(join(value.directory, ".mutation-lock")),
            true,
          );
          assert.equal(
            existsSync(join(value.directory, "manifest.json")),
            false,
          );
          const put = putExtensionRecoveryFile({
            selection: value.selection,
            file: "snapshot-01.json",
            bytes: Buffer.from("{}"),
          });
          const rejected = assert.rejects(
            put,
            /extension_recovery_capsule_immutable/,
          );
          gate.resume();
          await commit;
          await rejected;
          assert.equal(
            existsSync(join(value.directory, "snapshot-01.json")),
            false,
          );
          assert.deepEqual(
            (await resolveExtensionRecoveryCapsule(value.selection)).manifest,
            value.manifest,
          );
        } finally {
          gate.restore();
        }
      },
    );
    await context.test(
      "put owns the lock first, then the marker includes the exact newly pinned input",
      async (context) => {
        const value = await prepared(context);
        const bytes = Buffer.from('{"additional":true}');
        const file = "snapshot-01.json";
        const expected = {
          ...value.manifest,
          files: [...value.manifest.files, { file, digest: digest(bytes) }],
        } satisfies ExtensionRecoveryManifest;
        const gate = pauseLink(context, file);
        try {
          const put = putExtensionRecoveryFile({
            selection: value.selection,
            file,
            bytes,
          });
          await gate.reached;
          const commit = commitExtensionRecoveryCapsule({
            selection: value.selection,
            manifest: expected,
          });
          gate.resume();
          await put;
          await commit;
          assert.deepEqual(
            (await resolveExtensionRecoveryCapsule(value.selection)).manifest,
            expected,
          );
          assert.equal(
            existsSync(join(value.directory, ".mutation-lock")),
            false,
          );
        } finally {
          gate.restore();
        }
      },
    );
    await context.test(
      "put first with a manifest that omits the new pin leaves a partial directory",
      async (context) => {
        const value = await prepared(context);
        const gate = pauseLink(context, "snapshot-01.json");
        try {
          const put = putExtensionRecoveryFile({
            selection: value.selection,
            file: "snapshot-01.json",
            bytes: Buffer.from("{}"),
          });
          await gate.reached;
          const commit = commitExtensionRecoveryCapsule({
            selection: value.selection,
            manifest: value.manifest,
          });
          const rejected = assert.rejects(
            commit,
            /extension_recovery_inventory_invalid/,
          );
          gate.resume();
          await put;
          await rejected;
          assert.equal(
            existsSync(join(value.directory, "manifest.json")),
            false,
          );
          assert.equal(
            existsSync(join(value.directory, "snapshot-01.json")),
            true,
          );
          await assert.rejects(
            resolveExtensionRecoveryCapsule(value.selection),
            { code: "ENOENT" },
          );
          assert.equal(
            existsSync(join(value.directory, ".mutation-lock")),
            false,
          );
        } finally {
          gate.restore();
        }
      },
    );
  },
);

test("partial capsules never resolve and the complete marker is published last", async (context) => {
  const value = await prepared(context);
  const marker = join(value.directory, "manifest.json");
  assert.equal(existsSync(marker), false);
  await assert.rejects(resolveExtensionRecoveryCapsule(value.selection), {
    code: "ENOENT",
  });
  rmSync(join(value.directory, "release.json"));
  await assert.rejects(
    commitExtensionRecoveryCapsule({
      selection: value.selection,
      manifest: value.manifest,
    }),
    /extension_recovery_inventory_invalid/,
  );
  assert.equal(existsSync(marker), false);
  assert.equal(readdirSync(value.directory).length, 5);
  await putExtensionRecoveryFile({
    selection: value.selection,
    file: "release.json",
    bytes: value.contents.get("release.json")!,
  });
  const resolved = await commitExtensionRecoveryCapsule({
    selection: value.selection,
    manifest: value.manifest,
  });
  assert.deepEqual(resolved.manifest, value.manifest);
  assert.equal(readdirSync(value.directory).length, 7);
  assert.deepEqual(
    resolved.files.map(({ file }) => file),
    [...inputNames],
  );
  for (const pin of resolved.files) {
    assert.equal(pin.path, join(value.directory, pin.file));
    assert.equal(digest(readFileSync(pin.path)), pin.digest);
    assert.ok(Object.isFrozen(pin));
  }
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(resolved.files));
  assert.ok(Object.isFrozen(resolved.manifest));
});

test("exact input and marker reuse preserves file identity and conflicting writes never overwrite", async (context) => {
  const value = await completed(context);
  const before = new Map(
    [...inputNames, "manifest.json"].map((file) => {
      const path = join(value.directory, file);
      return [file, { bytes: readFileSync(path), metadata: statSync(path) }];
    }),
  );
  for (const file of inputNames) {
    const pin = await putExtensionRecoveryFile({
      selection: value.selection,
      file,
      bytes: value.contents.get(file)!,
    });
    assert.equal(pin.digest, digest(value.contents.get(file)!));
  }
  await commitExtensionRecoveryCapsule({
    selection: value.selection,
    manifest: value.manifest,
  });
  await assert.rejects(
    putExtensionRecoveryFile({
      selection: value.selection,
      file: "bootstrap.json",
      bytes: Buffer.from('{"changed":true}'),
    }),
    /extension_recovery_file_mismatch/,
  );
  await assert.rejects(
    commitExtensionRecoveryCapsule({
      selection: value.selection,
      manifest: { ...value.manifest, releaseId: "different-release" },
    }),
    /extension_recovery_file_mismatch/,
  );
  for (const [file, old] of before) {
    const path = join(value.directory, file);
    const current = statSync(path);
    assert.deepEqual(readFileSync(path), old.bytes);
    assert.equal(current.ino, old.metadata.ino);
    assert.equal(current.mtimeMs, old.metadata.mtimeMs);
  }
});

test("a completed capsule cannot append another allowed snapshot", async (context) => {
  const value = await completed(context);
  await assert.rejects(
    putExtensionRecoveryFile({
      selection: value.selection,
      file: "snapshot-01.json",
      bytes: Buffer.from("{}"),
    }),
    /extension_recovery_capsule_immutable/,
  );
  assert.equal(existsSync(join(value.directory, "snapshot-01.json")), false);
  await resolveExtensionRecoveryCapsule(value.selection);
});

test("every pinned input is rechecked on resolve and oversized persisted files fail before JSON parsing", async (context) => {
  const value = await completed(context);
  for (const file of inputNames) {
    const path = join(value.directory, file);
    writeFileSync(path, '{"different":true}');
    await assert.rejects(
      resolveExtensionRecoveryCapsule(value.selection),
      /extension_recovery_file_mismatch/,
    );
    writeFileSync(path, value.contents.get(file)!);
  }
  truncateSync(join(value.directory, "snapshot-00.json"), 32 * 1024 + 1);
  await assert.rejects(
    resolveExtensionRecoveryCapsule(value.selection),
    /extension_recovery_file_size_invalid/,
  );
  writeFileSync(
    join(value.directory, "snapshot-00.json"),
    value.contents.get("snapshot-00.json")!,
  );
  truncateSync(join(value.directory, "manifest.json"), 128 * 1024 + 1);
  await assert.rejects(
    resolveExtensionRecoveryCapsule(value.selection),
    /extension_recovery_file_size_invalid/,
  );
});

test("a changed input digest prevents marker publication and every resolve rechecks bytes", async (context) => {
  const value = await prepared(context);
  writeFileSync(join(value.directory, "bootstrap.json"), '{"tampered":true}');
  await assert.rejects(
    commitExtensionRecoveryCapsule({
      selection: value.selection,
      manifest: value.manifest,
    }),
    /extension_recovery_file_mismatch/,
  );
  assert.equal(existsSync(join(value.directory, "manifest.json")), false);
  writeFileSync(
    join(value.directory, "bootstrap.json"),
    value.contents.get("bootstrap.json")!,
  );
  await commitExtensionRecoveryCapsule({
    selection: value.selection,
    manifest: value.manifest,
  });
  writeFileSync(join(value.directory, "bootstrap.json"), '{"tampered":true}');
  await assert.rejects(
    resolveExtensionRecoveryCapsule(value.selection),
    /extension_recovery_file_mismatch/,
  );
});

test("unexpected files and leftover pending slots never become completed inputs", async (context) => {
  const value = await prepared(context);
  const unexpected = join(value.directory, ".bootstrap.json.pending");
  writeFileSync(unexpected, "{}");
  await assert.rejects(
    commitExtensionRecoveryCapsule({
      selection: value.selection,
      manifest: value.manifest,
    }),
    /extension_recovery_inventory_invalid/,
  );
  assert.equal(readFileSync(unexpected, "utf8"), "{}");
  assert.equal(existsSync(join(value.directory, "manifest.json")), false);
  rmSync(unexpected);
  await commitExtensionRecoveryCapsule({
    selection: value.selection,
    manifest: value.manifest,
  });
  writeFileSync(join(value.directory, "unexpected.json"), "{}");
  await assert.rejects(
    resolveExtensionRecoveryCapsule(value.selection),
    /extension_recovery_inventory_invalid/,
  );
});

test("all input JSON files are byte-pinned and a read result cannot mutate persisted data", async (context) => {
  const value = await completed(context);
  for (const file of inputNames) {
    const pin = value.manifest.files.find((pin) => pin.file === file)!;
    const bytes = await readExtensionRecoveryFile({
      selection: value.selection,
      file,
      expectedDigest: pin.digest,
    });
    bytes.fill(0);
    assert.deepEqual(
      await readExtensionRecoveryFile({
        selection: value.selection,
        file,
        expectedDigest: pin.digest,
      }),
      value.contents.get(file),
    );
    await assert.rejects(
      readExtensionRecoveryFile({
        selection: value.selection,
        file,
        expectedDigest: digest("wrong-pin"),
      }),
      /extension_recovery_file_mismatch/,
    );
  }
});

test("put snapshots caller bytes and selection before asynchronous allocation", async (context) => {
  const value = fixture(context);
  const original = Buffer.from('{"captured":true}');
  const bytes = Uint8Array.from(original);
  const selection = { ...value.selection };
  const put = putExtensionRecoveryFile({
    selection,
    file: "bootstrap.json",
    bytes,
  });
  selection.capsuleId = digest("mutated-capsule");
  selection.dataRoot = join(value.dataRoot, "missing-root");
  bytes.fill(0);
  const pin = await put;
  assert.equal(pin.digest, digest(original));
  assert.deepEqual(
    await readExtensionRecoveryFile({
      selection: value.selection,
      file: "bootstrap.json",
    }),
    original,
  );
  assert.equal(
    existsSync(
      join(
        value.dataRoot,
        "extension-recoveries",
        digest("mutated-capsule").slice(7),
      ),
    ),
    false,
  );
});

test("commit snapshots mutable manifest, target and owner before awaiting filesystem verification", async (context) => {
  const value = await prepared(context);
  const input = structuredClone(value.manifest);
  const selection = { ...value.selection };
  const commit = commitExtensionRecoveryCapsule({ selection, manifest: input });
  (input.owner as { actorId: string }).actorId = "mutated-actor";
  (input.targets[0] as { agentVersionId: string }).agentVersionId =
    "mutated-agent";
  (input.files[0] as { digest: string }).digest = digest("mutated-bytes");
  (input as { releaseId: string }).releaseId = "mutated-release";
  selection.capsuleId = digest("wrong-selection");
  const resolved = await commit;
  assert.deepEqual(resolved.manifest, value.manifest);
  const resolveInput = { ...value.selection };
  const read = resolveExtensionRecoveryCapsule(resolveInput);
  resolveInput.capsuleId = digest("changed-during-read");
  assert.deepEqual((await read).manifest, value.manifest);
});

test("input paths cannot supply markers, traversal, unknown snapshot slots or non-JSON bytes", async (context) => {
  const value = fixture(context);
  for (const file of [
    "manifest.json",
    "../bootstrap.json",
    "snapshot-32.json",
    "snapshot-0.json",
    "unexpected.json",
  ])
    await assert.rejects(
      putExtensionRecoveryFile({
        selection: value.selection,
        file: file as ExtensionRecoveryInputFile,
        bytes: Buffer.from("{}"),
      }),
      /extension_recovery_file_invalid/,
    );
  for (const bytes of [
    Buffer.from("{"),
    Buffer.from([0xff, 0xff]),
    Buffer.from(" "),
  ])
    await assert.rejects(
      putExtensionRecoveryFile({
        selection: value.selection,
        file: "bootstrap.json",
        bytes,
      }),
    );
  await assert.rejects(
    putExtensionRecoveryFile({
      selection: value.selection,
      file: "snapshot-00.json",
      bytes: Buffer.alloc(32 * 1024 + 1),
    }),
    /extension_recovery_file_size_invalid/,
  );
  assert.equal(existsSync(value.directory), false);
});

test("root, capsule and input symlinks are rejected without reading their target", async (context) => {
  const value = fixture(context);
  const elsewhere = join(value.dataRoot, "elsewhere");
  mkdirSync(elsewhere);
  const root = join(value.dataRoot, "extension-recoveries");
  symlinkSync(elsewhere, root);
  await assert.rejects(
    extensionRecoveryDirectory({ selection: value.selection, create: true }),
    /extension_recovery_directory_invalid/,
  );
  rmSync(root);
  mkdirSync(root);
  symlinkSync(elsewhere, value.directory);
  await assert.rejects(
    extensionRecoveryDirectory({ selection: value.selection, create: false }),
    /extension_recovery_directory_invalid/,
  );
  rmSync(value.directory);
  mkdirSync(value.directory);
  const other = join(elsewhere, "bootstrap.json");
  writeFileSync(other, '{"outside":true}');
  symlinkSync(other, join(value.directory, "bootstrap.json"));
  await assert.rejects(
    readExtensionRecoveryFile({
      selection: value.selection,
      file: "bootstrap.json",
    }),
  );
  await assert.rejects(
    putExtensionRecoveryFile({
      selection: value.selection,
      file: "bootstrap.json",
      bytes: Buffer.from("{}"),
    }),
  );
  assert.equal(readFileSync(other, "utf8"), '{"outside":true}');
});

test("symlinked data root and parent ancestry are rejected", async (context) => {
  const value = fixture(context);
  const alias = join(value.dataRoot, "alias");
  const real = join(value.dataRoot, "real");
  mkdirSync(real);
  symlinkSync(real, alias);
  for (const dataRoot of [alias, join(alias, "nested")]) {
    if (dataRoot.endsWith("nested")) mkdirSync(join(real, "nested"));
    await assert.rejects(
      extensionRecoveryDirectory({
        selection: { ...value.selection, dataRoot },
        create: true,
      }),
      /extension_recovery_directory_invalid/,
    );
  }
});

test("pending symlinks and allocation-lock symlinks are never overwritten or promoted", async (context) => {
  const value = fixture(context);
  await extensionRecoveryDirectory({
    selection: value.selection,
    create: true,
  });
  const elsewhere = join(value.dataRoot, "outside.json");
  writeFileSync(elsewhere, '{"outside":true}');
  const pending = join(value.directory, ".bootstrap.json.pending");
  symlinkSync(elsewhere, pending);
  await assert.rejects(
    putExtensionRecoveryFile({
      selection: value.selection,
      file: "bootstrap.json",
      bytes: Buffer.from("{}"),
    }),
    { code: "EEXIST" },
  );
  assert.equal(existsSync(join(value.directory, "bootstrap.json")), false);
  assert.equal(readFileSync(elsewhere, "utf8"), '{"outside":true}');
  symlinkSync(elsewhere, join(value.directory, ".mutation-lock"));
  await assert.rejects(
    putExtensionRecoveryFile({
      selection: value.selection,
      file: "snapshot-01.json",
      bytes: Buffer.from("{}"),
    }),
    /extension_recovery_busy/,
  );
  assert.equal(existsSync(join(value.directory, "snapshot-01.json")), false);
  assert.equal(readFileSync(elsewhere, "utf8"), '{"outside":true}');
  symlinkSync(
    elsewhere,
    join(value.dataRoot, "extension-recoveries", ".allocation-lock"),
  );
  await assert.rejects(
    extensionRecoveryDirectory({
      selection: { ...value.selection, capsuleId: digest("new") },
      create: true,
    }),
    /extension_recovery_busy/,
  );
});

test("a symlink complete marker and marker pending slot cannot complete a partial capsule", async (context) => {
  const value = await prepared(context);
  const other = join(value.dataRoot, "other-manifest.json");
  writeFileSync(other, JSON.stringify(value.manifest));
  const marker = join(value.directory, "manifest.json");
  symlinkSync(other, marker);
  await assert.rejects(resolveExtensionRecoveryCapsule(value.selection));
  await assert.rejects(
    commitExtensionRecoveryCapsule({
      selection: value.selection,
      manifest: value.manifest,
    }),
  );
  rmSync(marker);
  const pending = join(value.directory, ".manifest.json.pending");
  symlinkSync(other, pending);
  await assert.rejects(
    commitExtensionRecoveryCapsule({
      selection: value.selection,
      manifest: value.manifest,
    }),
  );
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(other, "utf8"), JSON.stringify(value.manifest));
});

test("the 64-capsule capacity counts incomplete capsules and exact existing reuse remains possible", async (context) => {
  const value = fixture(context);
  const root = join(value.dataRoot, "extension-recoveries");
  mkdirSync(root);
  const selections = Array.from({ length: 64 }, (_, index) => ({
    dataRoot: value.dataRoot,
    capsuleId: digest(`capacity-${index}`),
  }));
  for (const selection of selections)
    mkdirSync(join(root, selection.capsuleId.slice(7)));
  assert.equal(
    await extensionRecoveryDirectory({
      selection: selections[0]!,
      create: true,
    }),
    join(root, selections[0]!.capsuleId.slice(7)),
  );
  await assert.rejects(
    extensionRecoveryDirectory({ selection: value.selection, create: true }),
    /extension_recovery_capacity_exceeded/,
  );
  assert.equal(readdirSync(root).length, 64);
});

test("concurrent allocation never exceeds capacity and releases its allocation lock", async (context) => {
  const value = fixture(context);
  const root = join(value.dataRoot, "extension-recoveries");
  mkdirSync(root);
  for (let index = 0; index < 61; index++)
    mkdirSync(join(root, digest(`existing-${index}`).slice(7)));
  const selections = Array.from({ length: 6 }, (_, index) => ({
    dataRoot: value.dataRoot,
    capsuleId: digest(`concurrent-${index}`),
  }));
  const results = await Promise.allSettled(
    selections.map((selection) =>
      extensionRecoveryDirectory({ selection, create: true }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    3,
  );
  for (const result of results)
    if (result.status === "rejected")
      assert.match(
        String(result.reason),
        /extension_recovery_capacity_exceeded/,
      );
  assert.equal(readdirSync(root).length, 64);
  assert.equal(existsSync(join(root, ".allocation-lock")), false);
});

test("concurrent exact allocation reuses one directory without additional inventory entries", async (context) => {
  const value = fixture(context);
  const directories = await Promise.all(
    Array.from({ length: 8 }, () =>
      extensionRecoveryDirectory({ selection: value.selection, create: true }),
    ),
  );
  assert.ok(directories.every((directory) => directory === value.directory));
  assert.deepEqual(readdirSync(join(value.dataRoot, "extension-recoveries")), [
    value.selection.capsuleId.slice(7),
  ]);
});

test("unknown inventory entries fail closed and are never deleted", async (context) => {
  const value = fixture(context);
  const root = join(value.dataRoot, "extension-recoveries");
  mkdirSync(root);
  writeFileSync(join(root, "unrecognized"), "{}");
  await assert.rejects(
    extensionRecoveryDirectory({ selection: value.selection, create: true }),
    /extension_recovery_inventory_invalid/,
  );
  assert.deepEqual(readdirSync(root), ["unrecognized"]);
});

test("manifest snapshots preserve complete identity and all eight execution target fields", async (context) => {
  const value = await prepared(context);
  const input = structuredClone(value.manifest);
  const snapshot = parseExtensionRecoveryManifest(input);
  assert.deepEqual(snapshot.owner, owner);
  assert.deepEqual(snapshot.registrations, [registration]);
  assert.deepEqual(snapshot.targets, [target]);
  assert.notEqual(
    snapshot.implementationDigest,
    snapshot.registrations[0]!.implementationDigest,
  );
  for (const nested of [
    snapshot.owner,
    snapshot.providerBinding,
    snapshot.registrations,
    snapshot.registrations[0],
    snapshot.targets,
    snapshot.targets[0],
    snapshot.files,
    snapshot.files[0],
  ])
    assert.ok(Object.isFrozen(nested));
  (input.targets[0] as { runtimeGeneration: string }).runtimeGeneration =
    "changed";
  (input.registrations[0] as { pluginVersion: string }).pluginVersion = "9.0.0";
  assert.deepEqual(snapshot.targets, [target]);
  assert.deepEqual(snapshot.registrations, [registration]);
  const withWorkspace = parseExtensionExecutionTarget({
    ...target,
    workspaceBindingId: "workspace-old",
  });
  assert.equal(
    parseExtensionRecoveryManifest({
      ...value.manifest,
      targets: [withWorkspace],
    }).targets[0]!.workspaceBindingId,
    "workspace-old",
  );
});

test("the manifest accepts all 32 distinct registrations and targets plus all 32 bounded snapshot slots", async (context) => {
  const value = await prepared(context);
  const files = value.manifest.files.filter(
    ({ file }) => !file.startsWith("snapshot-"),
  );
  for (let index = 0; index < 32; index++) {
    const file =
      `snapshot-${String(index).padStart(2, "0")}.json` as ExtensionRecoveryInputFile;
    files.push(
      await putExtensionRecoveryFile({
        selection: value.selection,
        file,
        bytes:
          index === 0
            ? value.contents.get("snapshot-00.json")!
            : Buffer.from(JSON.stringify({ snapshot: index })),
      }),
    );
  }
  const input = {
    ...value.manifest,
    files,
    registrations: Array.from({ length: 32 }, (_, index) =>
      parseExtensionHostRegistrationIdentity({
        ...registration,
        pluginVersion: `1.0.${index}`,
      }),
    ),
    targets: Array.from({ length: 32 }, (_, index) =>
      parseExtensionExecutionTarget({
        ...target,
        // Same Agent can have different immutable materializations; dedup is full-target equality.
        materializationDigest: digest(`materialization-${index}`),
      }),
    ),
  };
  const resolved = await commitExtensionRecoveryCapsule({
    selection: value.selection,
    manifest: input,
  });
  assert.equal(resolved.manifest.registrations.length, 32);
  assert.equal(resolved.manifest.targets.length, 32);
  assert.equal(resolved.files.length, 37);
  assert.equal(readdirSync(value.directory).length, 38);
  assert.deepEqual(
    (await resolveExtensionRecoveryCapsule(value.selection)).manifest,
    input,
  );
  assert.deepEqual(
    (
      await commitExtensionRecoveryCapsule({
        selection: value.selection,
        manifest: input,
      })
    ).manifest,
    input,
  );
});

test("manifest parser rejects sparse, accessor, symbol and extra-key arrays without invoking getters", async (context) => {
  const value = await prepared(context);
  for (const field of ["registrations", "targets", "files"] as const) {
    const source = [...value.manifest[field]];
    const getter = () => {
      throw new Error("must-not-invoke");
    };
    const variants = [
      Object.assign([...source], { extra: true }),
      Object.assign([...source], { [Symbol("extra")]: true }),
      Object.defineProperty([...source], "0", {
        get: getter,
        enumerable: true,
      }),
      Object.defineProperty([...source], "0", {
        value: source[0],
        enumerable: false,
      }),
      Object.assign(new Array(source.length), source.slice(1)),
    ];
    for (const array of variants)
      assert.throws(
        () =>
          parseExtensionRecoveryManifest({ ...value.manifest, [field]: array }),
        /extension_recovery_manifest_invalid/,
      );
  }
});

test("manifest parser rejects unknown fields, missing pins and malformed complete identity", async (context) => {
  const value = await prepared(context);
  for (const invalid of [
    { ...value.manifest, apiKey: "must-never-be-saved" },
    { ...value.manifest, schemaVersion: "unknown" },
    { ...value.manifest, capsuleId: "not-a-digest" },
    { ...value.manifest, implementationDigest: "sha256:short" },
    { ...value.manifest, buildIdentityDigest: "sha256:short" },
    { ...value.manifest, owner: { ...owner, principalId: undefined } },
    { ...value.manifest, owner: { ...owner, sessionToken: "private" } },
    { ...value.manifest, registrations: [] },
    { ...value.manifest, registrations: Array(33).fill(registration) },
    { ...value.manifest, registrations: [registration, registration] },
    { ...value.manifest, targets: [] },
    { ...value.manifest, targets: Array(33).fill(target) },
    { ...value.manifest, targets: [target, target] },
    {
      ...value.manifest,
      targets: [{ ...target, executionAuthority: "other" }],
    },
    {
      ...value.manifest,
      targets: [{ ...target, workspaceBindingId: undefined }],
    },
    {
      ...value.manifest,
      targets: [{ ...target, materializationDigest: "bad" }],
    },
    { ...value.manifest, files: value.manifest.files.slice(1) },
    { ...value.manifest, files: value.manifest.files.slice(0, 5) },
    {
      ...value.manifest,
      files: [...value.manifest.files, value.manifest.files[0]],
    },
    {
      ...value.manifest,
      files: [
        ...value.manifest.files,
        { file: "manifest.json", digest: digest("marker") },
      ],
    },
    {
      ...value.manifest,
      files: value.manifest.files.map((pin) => ({ ...pin, extra: true })),
    },
  ])
    assert.throws(() => parseExtensionRecoveryManifest(invalid));
});

test("plain data descriptor checks reject impure manifest and provider objects", async (context) => {
  const value = await prepared(context);
  let calls = 0;
  const getter = () => {
    calls++;
    return value.manifest.owner;
  };
  for (const input of [
    Object.create(value.manifest),
    Object.assign({ ...value.manifest }, { [Symbol("secret")]: "private" }),
    Object.defineProperty({ ...value.manifest }, "owner", {
      get: getter,
      enumerable: true,
    }),
    Object.defineProperty({ ...value.manifest }, "owner", {
      value: owner,
      enumerable: false,
    }),
  ])
    assert.throws(() => parseExtensionRecoveryManifest(input));
  assert.equal(calls, 0);
  assert.deepEqual(
    parseExtensionRecoveryManifest(
      Object.assign(Object.create(null), value.manifest),
    ),
    value.manifest,
  );
  assert.throws(() =>
    parseExtensionRecoveryProviderBinding({
      ...value.manifest.providerBinding,
      apiKey: "secret",
    }),
  );
});

test("provider binding rejects secret-bearing URLs and requires an exact derived Responses address", () => {
  const input = {
    providerId: "first",
    endpoint: "https://provider.example/v1",
    responsesEndpoint: "https://provider.example/v1/responses",
    credentialRequired: true,
  };
  for (const endpoint of [
    "https://user:secret@provider.example/v1",
    "https://provider.example/v1?api_key=secret",
    "https://provider.example/v1#secret",
    "http://provider.example/v1",
    "file:///private/secret",
    " https://provider.example/v1",
    "https://provider.example/v1\u200b",
    "https://provider.example/v1?",
    "https://provider.example/v1#",
    "https://provider.example\\v1",
  ])
    assert.throws(
      () => parseExtensionRecoveryProviderBinding({ ...input, endpoint }),
      { message: "extension_recovery_provider_invalid" },
      `must reject endpoint ${endpoint}`,
    );
  for (const responsesEndpoint of [
    "https://other.example/v1/responses",
    "https://provider.example/responses",
    "https://provider.example/v1/responses/",
  ])
    assert.throws(() =>
      parseExtensionRecoveryProviderBinding({ ...input, responsesEndpoint }),
    );
  const expanded = "https://provider.example/" + "é".repeat(900);
  assert.ok(Buffer.byteLength(expanded) < 2048);
  assert.ok(Buffer.byteLength(new URL(expanded).toString()) > 2048);
  assert.throws(
    () =>
      parseExtensionRecoveryProviderBinding({
        ...input,
        endpoint: expanded,
        responsesEndpoint: `${expanded}/responses`,
      }),
    /extension_recovery_provider_invalid/,
  );
  assert.deepEqual(
    parseExtensionRecoveryProviderBinding({
      ...input,
      endpoint: "HTTPS://PROVIDER.EXAMPLE:443/v1",
      responsesEndpoint: "HTTPS://PROVIDER.EXAMPLE:443/v1/responses",
    }),
    input,
  );
});

test("selection mismatches and impure selection cannot read or complete another capsule", async (context) => {
  const value = await prepared(context);
  await assert.rejects(
    commitExtensionRecoveryCapsule({
      selection: value.selection,
      manifest: { ...value.manifest, capsuleId: digest("other") },
    }),
    /extension_recovery_selection_mismatch/,
  );
  for (const selection of [
    { ...value.selection, extra: true },
    { ...value.selection, dataRoot: "relative" },
    { ...value.selection, dataRoot: value.dataRoot + "\u200b" },
    { ...value.selection, capsuleId: "../other" },
    Object.create(value.selection),
  ])
    await assert.rejects(
      extensionRecoveryDirectory({ selection, create: true }),
    );
  assert.equal(existsSync(join(value.directory, "manifest.json")), false);
  writeFileSync(
    join(value.directory, "manifest.json"),
    JSON.stringify({ ...value.manifest, capsuleId: digest("other") }),
  );
  await assert.rejects(
    resolveExtensionRecoveryCapsule(value.selection),
    /extension_recovery_selection_mismatch/,
  );
});
