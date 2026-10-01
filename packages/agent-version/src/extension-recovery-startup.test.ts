import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fileSystemPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  parseExtensionHostActor,
  parseExtensionHostRegistrationIdentity,
} from "@crewon/contracts";
import { parseExtensionExecutionTarget } from "@crewon/domain";
import { parseExtensionRecoveryManifest } from "./extension-recovery.ts";
import {
  EXTENSION_RECOVERY_STARTUP_FILE,
  EXTENSION_RECOVERY_STARTUP_LIMIT,
  parseExtensionRecoveryStartupReport,
  readExtensionRecoveryStartupReport,
  writeExtensionRecoveryStartupReport,
  type ExtensionRecoveryStartupReport,
} from "./extension-recovery-startup.ts";

const firstAttempt = "a".repeat(64);
const nextAttempt = "b".repeat(64);
const unsupported = {
  schemaVersion: "crewon.extension-recovery-startup.v0",
  attemptId: firstAttempt,
  outcome: "unsupported",
  reasonCode: "extension_recovery_workspace_unsupported",
  preparedInputCapsuleId: null,
} as const satisfies ExtensionRecoveryStartupReport;
function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function prepared(): ExtensionRecoveryStartupReport {
  // Metadata fixtures grant no execution or publication authority.
  const owner = parseExtensionHostActor({
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  });
  const registration = parseExtensionHostRegistrationIdentity({
    pluginId: "crewon.comfyui-krea2",
    pluginVersion: "1.0.0",
    manifestDigest: digest("manifest"),
    implementationDigest: digest("adapter"),
  });
  const target = parseExtensionExecutionTarget({
    executionAuthority: "crewonKernel",
    agentVersionId: "prepared-agent-1",
    agentVersionContentDigest: digest("agent"),
    materializationDigest: digest("materialization"),
    authorityId: "standalone-authority",
    runtimeGeneration: "retained-generation-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  });
  const manifest = parseExtensionRecoveryManifest({
    schemaVersion: "crewon.extension-recovery-capsule.v0",
    capsuleId: digest("capsule"),
    owner,
    implementationDigest: digest("source"),
    buildIdentityDigest: digest("build"),
    providerBinding: {
      providerId: "provider-1",
      endpoint: "https://provider.example/v1",
      responsesEndpoint: "https://provider.example/v1/responses",
      credentialRequired: true,
    },
    releaseId: "release-fixture",
    registrations: [registration],
    targets: [target],
    files: [
      "plugin-bindings.json",
      "plugin-assets.json",
      "base-bindings.json",
      "bootstrap.json",
      "release.json",
      "snapshot-00.json",
    ].map((file) => ({ file, digest: digest(file) })),
  });
  return {
    schemaVersion: "crewon.extension-recovery-startup.v0",
    attemptId: firstAttempt,
    outcome: "prepared",
    manifest,
  };
}

function fixture(context: TestContext) {
  const dataRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-recovery-handoff-"),
  );
  context.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  return {
    dataRoot,
    path: join(dataRoot, EXTENSION_RECOVERY_STARTUP_FILE),
    pending: join(dataRoot, `${EXTENSION_RECOVERY_STARTUP_FILE}.pending-v1`),
  };
}

function restoreBuiltins(context: TestContext) {
  context.mock.restoreAll();
  syncBuiltinESMExports();
}

test("the fixed startup handoff supports atomic replacement and exact attempt reads after reopen", async (context) => {
  const value = fixture(context);
  await writeExtensionRecoveryStartupReport({
    dataRoot: value.dataRoot,
    report: prepared(),
  });
  const previous = statSync(value.path);
  assert.deepEqual(
    await readExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      expectedAttemptId: firstAttempt,
    }),
    prepared(),
  );
  const replacement = {
    ...unsupported,
    attemptId: nextAttempt,
    preparedInputCapsuleId: digest("already-prepared-input"),
  };
  await writeExtensionRecoveryStartupReport({
    dataRoot: value.dataRoot,
    report: replacement,
  });
  assert.notEqual(statSync(value.path).ino, previous.ino);
  assert.equal(statSync(value.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(value.dataRoot), [
    EXTENSION_RECOVERY_STARTUP_FILE,
  ]);
  assert.deepEqual(
    await readExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      expectedAttemptId: nextAttempt,
    }),
    replacement,
  );
  await assert.rejects(
    readExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      expectedAttemptId: firstAttempt,
    }),
    /extension_recovery_startup_attempt_mismatch/,
  );
});

test(
  "readers observe the prior complete attempt until the pending report is atomically renamed",
  { timeout: 10_000 },
  async (context) => {
    const value = fixture(context);
    await writeExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      report: unsupported,
    });
    const originalRename = fileSystemPromises.rename;
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
      "rename",
      async (...args: Parameters<typeof originalRename>) => {
        entered();
        await blocked;
        return originalRename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      const replacement = { ...unsupported, attemptId: nextAttempt };
      const writing = writeExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        report: replacement,
      });
      await reached;
      assert.equal(existsSync(value.pending), true);
      assert.deepEqual(
        await readExtensionRecoveryStartupReport({
          dataRoot: value.dataRoot,
          expectedAttemptId: firstAttempt,
        }),
        unsupported,
      );
      await assert.rejects(
        readExtensionRecoveryStartupReport({
          dataRoot: value.dataRoot,
          expectedAttemptId: nextAttempt,
        }),
        /extension_recovery_startup_attempt_mismatch/,
      );
      resume();
      await writing;
      assert.equal(existsSync(value.pending), false);
      assert.deepEqual(
        await readExtensionRecoveryStartupReport({
          dataRoot: value.dataRoot,
          expectedAttemptId: nextAttempt,
        }),
        replacement,
      );
    } finally {
      resume();
      restoreBuiltins(context);
    }
  },
);

test("prepared and unsupported report schemas snapshot caller values and contain metadata only", async (context) => {
  const value = fixture(context);
  const report = structuredClone(prepared());
  const writing = writeExtensionRecoveryStartupReport({
    dataRoot: value.dataRoot,
    report,
  });
  if (report.outcome === "prepared") {
    (report.manifest.owner as { actorId: string }).actorId =
      "changed-after-call";
    (report.manifest.targets[0] as { agentVersionId: string }).agentVersionId =
      "changed-agent";
  }
  await writing;
  const result = await readExtensionRecoveryStartupReport({
    dataRoot: value.dataRoot,
    expectedAttemptId: firstAttempt,
  });
  assert.deepEqual(result, prepared());
  assert.ok(Object.isFrozen(result));
  if (result.outcome === "prepared") {
    assert.ok(Object.isFrozen(result.manifest));
    assert.ok(Object.isFrozen(result.manifest.targets[0]));
    assert.equal(result.manifest.targets[0]!.workspaceBindingId, null);
  }
  const bytes = readFileSync(value.path, "utf8");
  for (const key of [
    "apiKey",
    "sessionToken",
    "csrfToken",
    "encryptedSecret",
    "environmentVariable",
  ])
    assert.equal(bytes.includes(`\"${key}\"`), false);
  for (const preparedInputCapsuleId of [null, digest("prepared-input")]) {
    const parsed = parseExtensionRecoveryStartupReport({
      ...unsupported,
      preparedInputCapsuleId,
    });
    assert.deepEqual(parsed, { ...unsupported, preparedInputCapsuleId });
    assert.ok(Object.isFrozen(parsed));
  }
});

test("pluginUnavailable is an exact nonsecret variant that keeps the default launch independent", async (context) => {
  const value = fixture(context);
  const report = {
    schemaVersion: "crewon.extension-recovery-startup.v0",
    attemptId: firstAttempt,
    outcome: "pluginUnavailable",
    reasonCode: "extension_recovery_current_provider_mismatch",
  } as const;
  const parsed = parseExtensionRecoveryStartupReport(report);
  assert.deepEqual(parsed, report);
  assert.ok(Object.isFrozen(parsed));
  await writeExtensionRecoveryStartupReport({
    dataRoot: value.dataRoot,
    report,
  });
  assert.deepEqual(
    await readExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      expectedAttemptId: firstAttempt,
    }),
    report,
  );
  const credentialUnavailable = {
    ...report,
    reasonCode: "extension_recovery_current_credential_unavailable",
  } as const;
  assert.deepEqual(
    parseExtensionRecoveryStartupReport(credentialUnavailable),
    credentialUnavailable,
  );
  await writeExtensionRecoveryStartupReport({
    dataRoot: value.dataRoot,
    report: credentialUnavailable,
  });
  assert.deepEqual(
    await readExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      expectedAttemptId: firstAttempt,
    }),
    credentialUnavailable,
  );
  for (const invalid of [
    { ...report, reasonCode: "unknown" },
    { ...report, manifest: prepared() },
    { ...report, preparedInputCapsuleId: null },
    { ...report, apiKey: "private" },
    { ...report, schemaVersion: "unknown" },
  ])
    assert.throws(
      () => parseExtensionRecoveryStartupReport(invalid),
      /extension_recovery_startup_invalid/,
    );
});

test("attempt validation rejects stale or malformed identity and never reads pending files", async (context) => {
  const value = fixture(context);
  writeFileSync(value.pending, JSON.stringify(unsupported));
  await assert.rejects(
    readExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      expectedAttemptId: firstAttempt,
    }),
    { code: "ENOENT" },
  );
  for (const expectedAttemptId of [
    "",
    "a".repeat(63),
    "A".repeat(64),
    "sha256:" + firstAttempt,
    firstAttempt + "\n",
  ])
    await assert.rejects(
      readExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        expectedAttemptId,
      }),
      /extension_recovery_startup_invalid/,
    );
  assert.equal(
    readFileSync(value.pending, "utf8"),
    JSON.stringify(unsupported),
  );
});

test("strict report parsing rejects unknown keys, descriptors, prototypes, malformed metadata and secrets", () => {
  const ready = prepared();
  const withoutCapsuleId = {
    schemaVersion: unsupported.schemaVersion,
    outcome: unsupported.outcome,
    attemptId: firstAttempt,
    reasonCode: unsupported.reasonCode,
  };
  const invalid = [
    null,
    [],
    Object.create(unsupported),
    { ...unsupported, schemaVersion: "unknown" },
    { ...unsupported, outcome: "unknown" },
    { ...unsupported, attemptId: "A".repeat(64) },
    { ...unsupported, attemptId: 1 },
    { ...unsupported, reasonCode: "invalid reason" },
    { ...unsupported, reasonCode: "x".repeat(129) },
    { ...unsupported, preparedInputCapsuleId: "bad" },
    { ...unsupported, preparedInputCapsuleId: undefined },
    withoutCapsuleId,
    {
      ...unsupported,
      manifest: ready.outcome === "prepared" ? ready.manifest : null,
    },
    { ...unsupported, apiKey: "must-not-be-written" },
    { ...unsupported, [Symbol("extra")]: "secret" },
    { ...ready, reasonCode: "not-in-prepared-schema" },
    { ...ready, preparedInputCapsuleId: digest("not-in-prepared-schema") },
    { ...ready, manifest: null },
    {
      ...ready,
      manifest:
        ready.outcome === "prepared"
          ? { ...ready.manifest, apiKey: "must-not-be-written" }
          : null,
    },
  ];
  for (const input of invalid)
    assert.throws(() => parseExtensionRecoveryStartupReport(input));
  let getters = 0;
  const getter = () => {
    getters++;
    return firstAttempt;
  };
  for (const input of [
    Object.defineProperty({ ...unsupported }, "attemptId", {
      enumerable: true,
      get: getter,
    }),
    Object.defineProperty({ ...unsupported }, "attemptId", {
      enumerable: false,
      value: firstAttempt,
    }),
  ])
    assert.throws(
      () => parseExtensionRecoveryStartupReport(input),
      /extension_recovery_startup_invalid/,
    );
  assert.equal(getters, 0);
  assert.deepEqual(
    parseExtensionRecoveryStartupReport(
      Object.assign(Object.create(null), unsupported),
    ),
    unsupported,
  );
});

test("bounds, malformed JSON and invalid UTF-8 reject current files before replacement", async (context) => {
  const value = fixture(context);
  for (const bytes of [
    Buffer.from("{"),
    Buffer.from([0xff, 0xff]),
    Buffer.alloc(EXTENSION_RECOVERY_STARTUP_LIMIT + 1, 32),
  ]) {
    writeFileSync(value.path, bytes);
    await assert.rejects(
      readExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        expectedAttemptId: firstAttempt,
      }),
    );
    await assert.rejects(
      writeExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        report: unsupported,
      }),
    );
    assert.deepEqual(readFileSync(value.path), bytes);
    assert.equal(existsSync(value.pending), false);
  }
});

test("a semantically plausible report with invalid UTF-8 cannot be read or overwritten", async (context) => {
  const value = fixture(context);
  const ready = prepared();
  assert.equal(ready.outcome, "prepared");
  if (ready.outcome !== "prepared") throw new Error("fixture_invalid");
  const bytes = Buffer.from(
    JSON.stringify({
      ...ready,
      manifest: { ...ready.manifest, releaseId: "release-é" },
    }),
  );
  const index = bytes.indexOf(Buffer.from("é"));
  assert.ok(index >= 0);
  bytes[index] = 0xff;
  writeFileSync(value.path, bytes);
  await assert.rejects(
    readExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      expectedAttemptId: firstAttempt,
    }),
    /extension_recovery_startup_invalid/,
  );
  await assert.rejects(
    writeExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      report: unsupported,
    }),
    /extension_recovery_startup_invalid/,
  );
  assert.deepEqual(readFileSync(value.path), bytes);
  assert.equal(existsSync(value.pending), false);
});

test("root and parent symlinks, leaf symlinks and hardlinked reports reject access", async (context) => {
  const value = fixture(context);
  const real = join(value.dataRoot, "real");
  mkdirSync(real);
  const alias = join(value.dataRoot, "alias");
  symlinkSync(real, alias);
  mkdirSync(join(real, "nested"));
  for (const dataRoot of [alias, join(alias, "nested")]) {
    await assert.rejects(
      writeExtensionRecoveryStartupReport({ dataRoot, report: unsupported }),
      /extension_recovery_startup_invalid/,
    );
    await assert.rejects(
      readExtensionRecoveryStartupReport({
        dataRoot,
        expectedAttemptId: firstAttempt,
      }),
    );
  }
  const outside = join(real, "outside.json");
  writeFileSync(outside, JSON.stringify(unsupported));
  symlinkSync(outside, value.path);
  await assert.rejects(
    readExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      expectedAttemptId: firstAttempt,
    }),
  );
  await assert.rejects(
    writeExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      report: unsupported,
    }),
  );
  rmSync(value.path);
  linkSync(outside, value.path);
  await assert.rejects(
    readExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      expectedAttemptId: firstAttempt,
    }),
    /extension_recovery_startup_invalid/,
  );
  await assert.rejects(
    writeExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      report: unsupported,
    }),
    /extension_recovery_startup_invalid/,
  );
  assert.equal(readFileSync(outside, "utf8"), JSON.stringify(unsupported));
});

test("occupied pending files, symlinks and hardlinks are preserved without changing the report", async (context) => {
  const value = fixture(context);
  await writeExtensionRecoveryStartupReport({
    dataRoot: value.dataRoot,
    report: unsupported,
  });
  const bytes = readFileSync(value.path);
  const outside = join(value.dataRoot, "outside.json");
  writeFileSync(outside, '{"preserve":true}');
  for (const kind of ["file", "symlink", "hardlink"] as const) {
    if (kind === "file") writeFileSync(value.pending, '{"interrupted":true}');
    if (kind === "symlink") symlinkSync(outside, value.pending);
    if (kind === "hardlink") linkSync(outside, value.pending);
    await assert.rejects(
      writeExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        report: { ...unsupported, attemptId: nextAttempt },
      }),
      { code: "EEXIST" },
    );
    assert.deepEqual(readFileSync(value.path), bytes);
    assert.equal(readFileSync(outside, "utf8"), '{"preserve":true}');
    rmSync(value.pending);
  }
});

test("atomic rename failure preserves the old attempt and cleans only its own pending file", async (context) => {
  const value = fixture(context);
  await writeExtensionRecoveryStartupReport({
    dataRoot: value.dataRoot,
    report: unsupported,
  });
  const bytes = readFileSync(value.path);
  context.mock.method(fileSystemPromises, "rename", async () => {
    throw Object.assign(new Error("disk_fault"), { code: "ENOSPC" });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      writeExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        report: { ...unsupported, attemptId: nextAttempt },
      }),
      /disk_fault/,
    );
    assert.deepEqual(readFileSync(value.path), bytes);
    assert.equal(existsSync(value.pending), false);
    assert.deepEqual(
      await readExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        expectedAttemptId: firstAttempt,
      }),
      unsupported,
    );
  } finally {
    restoreBuiltins(context);
  }
});

test("a report changed through its actual file descriptor during read cannot be accepted", async (context) => {
  const value = fixture(context);
  await writeExtensionRecoveryStartupReport({
    dataRoot: value.dataRoot,
    report: unsupported,
  });
  const originalOpen = fileSystemPromises.open;
  let changed = false;
  context.mock.method(
    fileSystemPromises,
    "open",
    async (...args: Parameters<typeof originalOpen>) => {
      const descriptor = await originalOpen(...args);
      if (String(args[0]) === value.path) {
        const originalStat = descriptor.stat;
        let statCalls = 0;
        context.mock.method(descriptor, "stat", async (...args: unknown[]) => {
          if (statCalls++ === 1) {
            appendFileSync(value.path, " ");
            changed = true;
          }
          return Reflect.apply(originalStat, descriptor, args);
        });
      }
      return descriptor;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      readExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        expectedAttemptId: firstAttempt,
      }),
      /extension_recovery_startup_invalid/,
    );
    assert.equal(changed, true);
  } finally {
    restoreBuiltins(context);
  }
});

test("root and read attempt inputs are captured before filesystem awaits", async (context) => {
  const value = fixture(context);
  const writeInput = { dataRoot: value.dataRoot, report: { ...unsupported } };
  const writing = writeExtensionRecoveryStartupReport(writeInput);
  writeInput.dataRoot = join(value.dataRoot, "does-not-exist");
  writeInput.report.attemptId = nextAttempt;
  await writing;
  const readInput = {
    dataRoot: value.dataRoot,
    expectedAttemptId: firstAttempt,
  };
  const reading = readExtensionRecoveryStartupReport(readInput);
  readInput.dataRoot = join(value.dataRoot, "missing");
  readInput.expectedAttemptId = nextAttempt;
  assert.deepEqual(await reading, unsupported);
});
