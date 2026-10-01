import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  retainExtensionBuild,
  resolveRetainedExtensionBuild,
} from "./extension-build-archive.ts";

const IDENTITY = "extension-build-identity.json";
const SCHEMA = "crewon.extension-build-identity.v0";
const hash = (bytes: string | Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digestHex = (digest: string) => digest.slice("sha256:".length);
type Identity = {
  schemaVersion: string;
  implementationDigest: string;
  bundles: { file: string; digest: string }[];
};

function fixture(context: TestContext) {
  // The OS-selected temporary base is trusted before resolving macOS /var alias.
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-build-archive-"),
  );
  const source = join(root, "runtime");
  const dataRoot = join(root, "native-data");
  mkdirSync(source);
  mkdirSync(dataRoot);
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const implementationDigest = hash("current trusted implementation");
  const writeBuild = (
    directory = source,
    digest = implementationDigest,
    files: Record<string, string | Buffer> = {
      "control-api.mjs": "export const control = 1;\n",
      "runtime-worker.mjs": "export const worker = 1;\n",
    },
  ) => {
    mkdirSync(directory, { recursive: true });
    const identity: Identity = {
      schemaVersion: SCHEMA,
      implementationDigest: digest,
      bundles: Object.entries(files)
        .map(([file, bytes]) => {
          writeFileSync(join(directory, file), bytes);
          return { file, digest: hash(bytes) };
        })
        .sort((a, b) => a.file.localeCompare(b.file)),
    };
    writeFileSync(join(directory, IDENTITY), JSON.stringify(identity));
    return identity;
  };
  const identity = writeBuild();
  const retain = () =>
    retainExtensionBuild({
      dataRoot,
      currentBuildDirectory: source,
      expectedImplementationDigest: implementationDigest,
    });
  const resolve = (expectedBuildIdentityDigest?: string) =>
    resolveRetainedExtensionBuild({
      dataRoot,
      implementationDigest,
      ...(expectedBuildIdentityDigest === undefined
        ? {}
        : { expectedBuildIdentityDigest }),
    });
  return {
    root,
    source,
    dataRoot,
    archive: join(dataRoot, "extension-builds"),
    implementationDigest,
    identity,
    writeBuild,
    retain,
    resolve,
  };
}

test("retention copies only verified static artifacts and resolves without the current installation", async (context) => {
  const f = fixture(context);
  writeFileSync(
    join(f.source, "credentials.json"),
    "local-secret-not-an-artifact",
  );
  writeFileSync(
    join(f.source, "bindings.json"),
    "configuration-not-an-artifact",
  );
  const retained = await f.retain();
  assert.equal(retained.implementationDigest, f.implementationDigest);
  assert.equal(retained.historicalWorkItemScope, null);
  assert.equal(retained.buildIdentityDigest, hash(JSON.stringify(f.identity)));
  assert.equal(
    basename(retained.directory),
    `${digestHex(f.implementationDigest)}-${digestHex(retained.buildIdentityDigest)}`,
  );
  assert.deepEqual(readdirSync(retained.directory).sort(), [
    "control-api.mjs",
    IDENTITY,
    "runtime-worker.mjs",
  ]);
  assert.equal(retained.identityPath, join(retained.directory, IDENTITY));
  assert.ok(Object.isFrozen(retained));
  assert.ok(Object.isFrozen(retained.bundles));
  for (const bundle of retained.bundles) {
    assert.ok(Object.isFrozen(bundle));
    assert.equal(bundle.path, join(retained.directory, bundle.file));
    assert.equal(hash(readFileSync(bundle.path)), bundle.digest);
    assert.equal(statSync(bundle.path).mode & 0o777, 0o400);
    // The installed file is not hardlinked to the retained file.
    assert.notEqual(
      statSync(bundle.path).ino,
      statSync(join(f.source, bundle.file)).ino,
    );
  }
  rmSync(f.source, { recursive: true });
  assert.deepEqual(await f.resolve(retained.buildIdentityDigest), retained);
  assert.deepEqual(readdirSync(f.archive), [basename(retained.directory)]);
});

test("scoped retention preserves both old and current capabilities without upgrading their claims", async (context) => {
  for (const scope of [
    "crewon.extension-work-item-scope.v0",
    "crewon.extension-work-item-scope.v1",
  ])
    await context.test(scope, async (subcontext) => {
      const f = fixture(subcontext);
      const scoped = {
        ...f.identity,
        schemaVersion: "crewon.extension-build-identity.v1",
        historicalWorkItemScope: scope,
      };
      writeFileSync(join(f.source, IDENTITY), JSON.stringify(scoped));
      const retained = await f.retain();
      assert.equal(retained.historicalWorkItemScope, scope);
      assert.equal(retained.buildIdentityDigest, hash(JSON.stringify(scoped)));
      assert.notEqual(
        retained.buildIdentityDigest,
        hash(JSON.stringify(f.identity)),
      );
      assert.deepEqual(await f.resolve(retained.buildIdentityDigest), retained);
      writeFileSync(
        join(f.source, IDENTITY),
        JSON.stringify(
          {
            historicalWorkItemScope: scoped.historicalWorkItemScope,
            bundles: [...scoped.bundles].reverse(),
            implementationDigest: scoped.implementationDigest,
            schemaVersion: scoped.schemaVersion,
          },
          null,
          2,
        ),
      );
      assert.deepEqual(await f.retain(), retained);
      chmodSync(retained.identityPath, 0o600);
      writeFileSync(retained.identityPath, JSON.stringify(f.identity));
      await assert.rejects(f.resolve(), /extension_retained_build_mismatch/u);
    });
});

test("equivalent metadata is idempotent and never overwrites retained bytes", async (context) => {
  const f = fixture(context);
  const retained = await f.retain();
  const previous = readFileSync(retained.identityPath);
  const inode = statSync(retained.identityPath).ino;
  writeFileSync(
    join(f.source, IDENTITY),
    JSON.stringify(
      {
        bundles: [...f.identity.bundles].reverse(),
        implementationDigest: f.implementationDigest,
        schemaVersion: SCHEMA,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(await f.retain(), retained);
  assert.equal(statSync(retained.identityPath).ino, inode);
  assert.deepEqual(readFileSync(retained.identityPath), previous);
});

test("native caller input changes cannot redirect a pending retain or resolve", async (context) => {
  const f = fixture(context);
  const other = fixture(context);
  const request = {
    dataRoot: f.dataRoot,
    currentBuildDirectory: f.source,
    expectedImplementationDigest: f.implementationDigest,
  };
  const pending = retainExtensionBuild(request);
  request.dataRoot = other.dataRoot;
  request.currentBuildDirectory = other.source;
  request.expectedImplementationDigest = hash("changed claim");
  const retained = await pending;
  assert.equal(retained.directory.startsWith(f.archive), true);
  assert.equal(existsSync(other.archive), false);
  const resolveRequest = {
    dataRoot: f.dataRoot,
    implementationDigest: f.implementationDigest,
    expectedBuildIdentityDigest: retained.buildIdentityDigest,
  };
  const resolving = resolveRetainedExtensionBuild(resolveRequest);
  resolveRequest.dataRoot = other.dataRoot;
  resolveRequest.implementationDigest = "invalid";
  resolveRequest.expectedBuildIdentityDigest = hash("wrong collection");
  assert.deepEqual(await resolving, retained);
});

test("resolve requires a complete marker and a precisely pinned build identity", async (context) => {
  const f = fixture(context);
  await assert.rejects(f.resolve(), /extension_retained_build_not_found/u);
  mkdirSync(f.archive);
  const directory = join(
    f.archive,
    `${digestHex(f.implementationDigest)}-${digestHex(hash(JSON.stringify(f.identity)))}`,
  );
  mkdirSync(directory);
  writeFileSync(
    join(directory, "runtime-worker.mjs"),
    "incomplete-crashed-copy",
  );
  await assert.rejects(f.resolve(), /extension_retained_build_incomplete/u);
  await assert.rejects(f.retain(), /extension_retained_build_incomplete/u);
  assert.equal(
    readFileSync(join(directory, "runtime-worker.mjs"), "utf8"),
    "incomplete-crashed-copy",
  );
  assert.deepEqual(readdirSync(f.archive), [basename(directory)]);
  rmSync(directory, { recursive: true });
  const retained = await f.retain();
  await assert.rejects(
    f.resolve(hash("another artifact collection")),
    /extension_retained_build_mismatch/u,
  );
  await assert.rejects(
    f.resolve("untrusted"),
    /extension_retained_build_mismatch/u,
  );
  assert.deepEqual(await f.resolve(retained.buildIdentityDigest), retained);
});

test("malformed, unknown, unsafe and incomplete sidecars fail before publication", async (context) => {
  const cases: [string, (identity: Identity) => unknown][] = [
    [
      "unknown root field",
      (identity) => ({ ...identity, secret: "unrecognized" }),
    ],
    [
      "unknown bundle field",
      (identity) => ({
        ...identity,
        bundles: [{ ...identity.bundles[0], absolutePath: "/etc/passwd" }],
      }),
    ],
    ["unknown schema", (identity) => ({ ...identity, schemaVersion: "next" })],
    [
      "legacy scope claim",
      (identity) => ({
        ...identity,
        historicalWorkItemScope: "crewon.extension-work-item-scope.v0",
      }),
    ],
    [
      "missing v1 scope",
      (identity) => ({
        ...identity,
        schemaVersion: "crewon.extension-build-identity.v1",
      }),
    ],
    [
      "unsupported v1 scope",
      (identity) => ({
        ...identity,
        schemaVersion: "crewon.extension-build-identity.v1",
        historicalWorkItemScope: "crewon.extension-work-item-scope.v2",
      }),
    ],
    [
      "unknown scoped field",
      (identity) => ({
        ...identity,
        schemaVersion: "crewon.extension-build-identity.v1",
        historicalWorkItemScope: "crewon.extension-work-item-scope.v0",
        trust: true,
      }),
    ],
    ["empty collection", (identity) => ({ ...identity, bundles: [] })],
    [
      "duplicate file",
      (identity) => ({
        ...identity,
        bundles: [identity.bundles[0], identity.bundles[0]],
      }),
    ],
    [
      "path traversal",
      (identity) => ({
        ...identity,
        bundles: [
          {
            file: "../runtime-worker.mjs",
            digest: identity.bundles[0]!.digest,
          },
        ],
      }),
    ],
    [
      "config reference",
      (identity) => ({
        ...identity,
        bundles: [
          { file: "credentials.json", digest: identity.bundles[0]!.digest },
        ],
      }),
    ],
    [
      "invalid hash",
      (identity) => ({
        ...identity,
        bundles: [{ file: "runtime-worker.mjs", digest: "sha256:claimed" }],
      }),
    ],
    [
      "too many bundles",
      (identity) => ({
        ...identity,
        bundles: Array.from({ length: 65 }, (_, index) => ({
          file: `entry-${index}.mjs`,
          digest: hash(String(index)),
        })),
      }),
    ],
  ];
  for (const [name, modify] of cases) {
    await context.test(name, async (subcontext) => {
      const f = fixture(subcontext);
      writeFileSync(
        join(f.source, IDENTITY),
        JSON.stringify(modify(f.identity)),
      );
      await assert.rejects(
        f.retain(),
        /extension_build_archive_identity_invalid/u,
      );
      assert.equal(existsSync(f.archive), false);
    });
  }
  await context.test("UTF8 and size", async (subcontext) => {
    const f = fixture(subcontext);
    writeFileSync(join(f.source, IDENTITY), Buffer.from([0xff, 0xfe]));
    await assert.rejects(
      f.retain(),
      /extension_build_archive_identity_invalid/u,
    );
    writeFileSync(join(f.source, IDENTITY), " ".repeat(64 * 1024 + 1));
    await assert.rejects(f.retain(), /extension_build_archive_limit_exceeded/u);
    assert.equal(existsSync(f.archive), false);
  });
});

test("expected implementation, complete bundle collection and bytes are checked", async (context) => {
  const f = fixture(context);
  await assert.rejects(
    retainExtensionBuild({
      dataRoot: f.dataRoot,
      currentBuildDirectory: f.source,
      expectedImplementationDigest: hash("different code"),
    }),
    /extension_build_archive_implementation_mismatch/u,
  );
  rmSync(join(f.source, "runtime-worker.mjs"));
  await assert.rejects(f.retain(), /extension_retained_build_incomplete/u);
  f.writeBuild();
  writeFileSync(join(f.source, "unexpected.mjs"), "export const extra = true");
  await assert.rejects(f.retain(), /extension_retained_build_incomplete/u);
  rmSync(join(f.source, "unexpected.mjs"));
  writeFileSync(
    join(f.source, "runtime-worker.mjs"),
    "changed while preserving claimed digest",
  );
  await assert.rejects(f.retain(), /extension_retained_build_mismatch/u);
  assert.equal(existsSync(f.archive), false);
});

test("bundle and total build sizes are bounded before publishing", async (context) => {
  const f = fixture(context);
  truncateSync(join(f.source, "runtime-worker.mjs"), 32 * 1024 * 1024 + 1);
  await assert.rejects(f.retain(), /extension_build_archive_limit_exceeded/u);
  assert.equal(existsSync(f.archive), false);
  rmSync(f.source, { recursive: true });
  const bytes = Buffer.alloc(27 * 1024 * 1024);
  f.writeBuild(
    f.source,
    f.implementationDigest,
    Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`entry-${index}.mjs`, bytes]),
    ),
  );
  await assert.rejects(f.retain(), /extension_build_archive_limit_exceeded/u);
  assert.equal(existsSync(f.archive), false);
});

test("source paths, artifacts, archive ancestors and retained files reject symlinks", async (context) => {
  for (const target of [
    "source-directory",
    "data-directory",
    "data-ancestor",
    "sidecar",
    "bundle",
    "archive-directory",
    "retained-directory",
    "retained-bundle",
  ] as const) {
    await context.test(target, async (subcontext) => {
      const f = fixture(subcontext);
      const external = join(f.root, "outside");
      mkdirSync(external);
      writeFileSync(join(external, "do-not-touch"), "external-file");
      let retain = f.retain;
      let check = f.resolve;
      if (target === "source-directory") {
        const alias = join(f.root, "runtime-alias");
        symlinkSync(f.source, alias, "dir");
        retain = () =>
          retainExtensionBuild({
            dataRoot: f.dataRoot,
            currentBuildDirectory: alias,
            expectedImplementationDigest: f.implementationDigest,
          });
      } else if (target === "data-directory") {
        rmSync(f.dataRoot, { recursive: true });
        symlinkSync(external, f.dataRoot, "dir");
      } else if (target === "data-ancestor") {
        mkdirSync(join(external, "child"));
        const alias = join(f.root, "alias");
        symlinkSync(external, alias, "dir");
        retain = () =>
          retainExtensionBuild({
            dataRoot: join(alias, "child"),
            currentBuildDirectory: f.source,
            expectedImplementationDigest: f.implementationDigest,
          });
      } else if (target === "sidecar" || target === "bundle") {
        const file = target === "sidecar" ? IDENTITY : "runtime-worker.mjs";
        const copied = join(external, file);
        writeFileSync(copied, readFileSync(join(f.source, file)));
        rmSync(join(f.source, file));
        symlinkSync(copied, join(f.source, file));
      } else if (target === "archive-directory") {
        symlinkSync(external, f.archive, "dir");
      } else {
        const retained = await f.retain();
        const path =
          target === "retained-directory"
            ? retained.directory
            : join(retained.directory, "runtime-worker.mjs");
        rmSync(path, { recursive: true });
        symlinkSync(
          external,
          path,
          target === "retained-directory" ? "dir" : "file",
        );
        check = f.resolve;
      }
      if (target.startsWith("retained-"))
        await assert.rejects(check(), /extension_build_archive_path_invalid/u);
      else
        await assert.rejects(retain(), /extension_build_archive_path_invalid/u);
      assert.equal(
        readFileSync(join(external, "do-not-touch"), "utf8"),
        "external-file",
      );
    });
  }
});

test("resolve detects bundle, marker and simultaneous collection tampering", async (context) => {
  const f = fixture(context);
  const retained = await f.retain();
  const bundle = retained.bundles[0]!;
  chmodSync(bundle.path, 0o600);
  writeFileSync(bundle.path, "malicious replacement code");
  await assert.rejects(f.resolve(), /extension_retained_build_mismatch/u);
  chmodSync(retained.identityPath, 0o600);
  const rewritten = {
    ...f.identity,
    bundles: f.identity.bundles.map((entry) =>
      entry.file === bundle.file
        ? { ...entry, digest: hash("malicious replacement code") }
        : entry,
    ),
  };
  writeFileSync(retained.identityPath, JSON.stringify(rewritten));
  // Updating both file and sidecar cannot change the already fixed directory address.
  await assert.rejects(f.resolve(), /extension_retained_build_mismatch/u);
  await assert.rejects(f.retain(), /extension_retained_build_mismatch/u);
  assert.equal(readFileSync(bundle.path, "utf8"), "malicious replacement code");
});

test("one implementation cannot be rebound to another artifact collection", async (context) => {
  const f = fixture(context);
  const retained = await f.retain();
  const previous = readFileSync(retained.identityPath);
  f.writeBuild(f.source, f.implementationDigest, {
    "control-api.mjs": "changed control",
    "runtime-worker.mjs": "changed worker",
  });
  await assert.rejects(f.retain(), /extension_retained_build_mismatch/u);
  assert.deepEqual(readFileSync(retained.identityPath), previous);
  const duplicate = join(
    f.archive,
    `${digestHex(f.implementationDigest)}-${digestHex(hash("another collection"))}`,
  );
  mkdirSync(duplicate);
  await assert.rejects(f.resolve(), /extension_retained_build_mismatch/u);
  assert.ok(existsSync(duplicate));
});

test("concurrent same-build publication is idempotent and removes owned staging artifacts", async (context) => {
  const f = fixture(context);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.retain()),
  );
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(readdirSync(f.archive), [basename(results[0]!.directory)]);
  assert.deepEqual(
    await f.resolve(results[0]!.buildIdentityDigest),
    results[0],
  );
});

test("global allocation is bounded across concurrent different implementations without GC", async (context) => {
  const f = fixture(context);
  mkdirSync(f.archive);
  const previous = Array.from(
    { length: 63 },
    (_, index) =>
      `${digestHex(hash(`historical-code-${index}`))}-${digestHex(hash(`historical-artifacts-${index}`))}`,
  );
  for (const name of previous) mkdirSync(join(f.archive, name));
  const second = join(f.root, "second-runtime");
  const secondDigest = hash("second trusted code");
  f.writeBuild(second, secondDigest);
  const attempts = await Promise.allSettled([
    f.retain(),
    retainExtensionBuild({
      dataRoot: f.dataRoot,
      currentBuildDirectory: second,
      expectedImplementationDigest: secondDigest,
    }),
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  const failure = attempts.find((attempt) => attempt.status === "rejected");
  assert.equal(failure?.status, "rejected");
  if (failure?.status === "rejected")
    assert.match(
      String(failure.reason),
      /extension_build_archive_capacity_exceeded/u,
    );
  const after = readdirSync(f.archive);
  assert.equal(after.length, 64);
  for (const name of previous) assert.ok(after.includes(name));
  assert.ok(after.every((name) => !name.startsWith(".")));
});

test("a source changing during staging leaves no executable or owned temporary directory", async (context) => {
  const f = fixture(context);
  rmSync(f.source, { recursive: true });
  f.writeBuild(f.source, f.implementationDigest, {
    "runtime-worker.mjs": Buffer.alloc(16 * 1024 * 1024, 0x61),
  });
  mkdirSync(f.archive);
  let changed = false;
  const observer = setInterval(() => {
    if (
      !changed &&
      readdirSync(f.archive).some((name) => name.startsWith(".tmp-"))
    ) {
      changed = true;
      // Valid canonical metadata, but changed bytes prove the source drifted.
      writeFileSync(
        join(f.source, IDENTITY),
        `${readFileSync(join(f.source, IDENTITY), "utf8")}\n`,
      );
    }
  }, 1);
  context.after(() => clearInterval(observer));
  await assert.rejects(f.retain(), /extension_build_archive_source_changed/u);
  assert.equal(changed, true);
  assert.deepEqual(readdirSync(f.archive), []);
});

test("crash artifacts stay incomplete or busy and are never automatically removed", async (context) => {
  const f = fixture(context);
  mkdirSync(f.archive);
  const partial = join(
    f.archive,
    `${digestHex(f.implementationDigest)}-${digestHex(hash(JSON.stringify(f.identity)))}`,
  );
  const lock = join(
    f.archive,
    `.${digestHex(f.implementationDigest)}.publish-lock`,
  );
  const abandonedTemporary = join(
    f.archive,
    `.tmp-${digestHex(f.implementationDigest)}-abc123`,
  );
  mkdirSync(partial);
  mkdirSync(abandonedTemporary);
  writeFileSync(
    join(abandonedTemporary, "runtime-worker.mjs"),
    "crash-staging",
  );
  writeFileSync(lock, "");
  await assert.rejects(f.resolve(), /extension_retained_build_incomplete/u);
  await assert.rejects(f.retain(), /extension_build_archive_publish_busy/u);
  assert.ok(existsSync(partial));
  assert.ok(existsSync(lock));
  assert.equal(
    readFileSync(join(abandonedTemporary, "runtime-worker.mjs"), "utf8"),
    "crash-staging",
  );
  assert.equal(readdirSync(f.archive).length, 3);
});

test("unrecognized archive entries and oversized stale staging collections fail closed", async (context) => {
  const f = fixture(context);
  mkdirSync(f.archive);
  writeFileSync(join(f.archive, "credentials.json"), "do not read or delete");
  await assert.rejects(f.retain(), /extension_build_archive_path_invalid/u);
  assert.equal(
    readFileSync(join(f.archive, "credentials.json"), "utf8"),
    "do not read or delete",
  );
  rmSync(join(f.archive, "credentials.json"));
  for (let index = 0; index < 65; index++)
    mkdirSync(
      join(f.archive, `.tmp-${digestHex(hash(`stale-${index}`))}-abc123`),
    );
  await assert.rejects(f.retain(), /extension_build_archive_limit_exceeded/u);
  assert.equal(readdirSync(f.archive).length, 65);
});
