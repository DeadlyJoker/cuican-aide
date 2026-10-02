import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PLUGIN_PACKAGE_DESCRIPTOR_PATH } from "@crewon/contracts/plugins";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import type { InstallLocalPluginPackageInput } from "./local-plugin-package-types.ts";
import { verifyLocalPluginPackage } from "./local-plugin-package-verifier.ts";
import {
  allowInstallation,
  assertCandidateBytes,
  deferred,
  directoryNames,
  packageFixture,
} from "./local-plugin-package.test-support.ts";

test("actual prebuilt bytes are verified, preserved and installed without evaluating code", async (t) => {
  const f = await packageFixture(t);
  await mkdir(join(f.source, "empty"));
  const verified = await verifyLocalPluginPackage({ directory: f.source });
  assert.match(verified.packageDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verified.fileCount, 3);
  assert.equal(
    verified.totalBytes,
    f.descriptorBytes.length +
      [...f.files.values()].reduce((n, b) => n + b.length, 0),
  );
  assert.ok(Object.isFrozen(verified.descriptor));
  let authorizations = 0;
  const installed = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: async (candidate) => {
      authorizations++;
      assert.equal(candidate.packageDigest, verified.packageDigest);
      assert.equal(candidate.descriptor.publisherId, "example.publisher");
      assert.ok(Object.isFrozen(candidate));
      return { outcome: "allow" };
    },
  });
  assert.equal(installed.outcome, "installed");
  assert.equal(installed.directory, await f.target(verified.packageDigest));
  assert.equal(installed.packageDigest, verified.packageDigest);
  await assertCandidateBytes(f, installed.directory);
  assert.deepEqual(await readdir(join(installed.directory, "empty")), []);
  assert.equal((await lstat(installed.directory)).mode & 0o222, 0);
  assert.equal(
    (await lstat(join(installed.directory, "dist/entry.mjs"))).mode & 0o222,
    0,
  );
  const before = await lstat(installed.directory, { bigint: true });
  const fileBefore = await lstat(join(installed.directory, "dist/entry.mjs"), {
    bigint: true,
  });
  const repeated = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  assert.equal(repeated.outcome, "alreadyInstalled");
  const after = await lstat(repeated.directory, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.ctimeNs, before.ctimeNs);
  assert.equal(
    (await lstat(join(repeated.directory, "dist/entry.mjs"), { bigint: true }))
      .ctimeNs,
    fileBefore.ctimeNs,
  );
  assert.equal(authorizations, 1);
  assert.deepEqual(await directoryNames(join(f.installRoot, ".staging")), []);
  assert.deepEqual(await directoryNames(join(f.installRoot, ".locks")), []);
  await assert.rejects(lstat(f.marker), { code: "ENOENT" });
});

test("mismatched actual digest, size, missing artifacts and undeclared files fail before authority", async (t) => {
  for (const failure of ["digest", "size", "missing", "undeclared"] as const) {
    const f = await packageFixture(t);
    const file = join(f.source, "assets/input.json");
    if (failure === "digest") await writeFile(file, '{"fixture":null}');
    if (failure === "size") await writeFile(file, "too short");
    if (failure === "missing") await rm(file);
    if (failure === "undeclared")
      await writeFile(join(f.source, "secret.txt"), "extra");
    let called = false;
    await assert.rejects(
      installLocalPluginPackage({
        directory: f.source,
        installRoot: f.installRoot,
        authorization: async () => {
          called = true;
          return { outcome: "allow" };
        },
      }),
      {
        code: {
          digest: "plugin_package_file_digest_mismatch",
          size: "plugin_package_file_size_mismatch",
          missing: "plugin_package_artifact_missing",
          undeclared: "plugin_package_file_undeclared",
        }[failure],
      },
    );
    assert.equal(called, false);
    assert.deepEqual(await readdir(f.installRoot), []);
  }
});

test("descriptor decoding and host protocol errors reject without creating install state", async (t) => {
  for (const invalid of ["utf8", "json", "host"] as const) {
    const f = await packageFixture(t);
    if (invalid === "host")
      await f.rewriteDescriptor({
        ...f.descriptor,
        hostApi: "crewon.plugin-host.v99",
      });
    else
      await writeFile(
        join(f.source, PLUGIN_PACKAGE_DESCRIPTOR_PATH),
        invalid === "utf8" ? Buffer.from([0xff]) : "{",
      );
    await assert.rejects(
      installLocalPluginPackage({
        directory: f.source,
        installRoot: f.installRoot,
        authorization: allowInstallation,
      }),
      {
        code:
          invalid === "host"
            ? "plugin_package_host_api_unsupported"
            : "plugin_package_descriptor_invalid",
      },
    );
    assert.deepEqual(await readdir(f.installRoot), []);
  }
});

test("source roots, nested directories and artifacts cannot redirect verification through links", async (t) => {
  for (const kind of ["root", "directory", "file", "hardlink"] as const) {
    const f = await packageFixture(t);
    let directory = f.source;
    if (kind === "root") {
      directory = join(f.root, "source-link");
      await symlink(f.source, directory);
    } else if (kind === "directory") {
      await rm(join(f.source, "dist"), { recursive: true });
      await mkdir(join(f.root, "outside"));
      await writeFile(
        join(f.root, "outside/entry.mjs"),
        f.files.get("dist/entry.mjs")!,
      );
      await symlink(join(f.root, "outside"), join(f.source, "dist"));
    } else {
      const artifact = join(f.source, "assets/input.json");
      const outside = join(f.root, "outside.json");
      await writeFile(outside, f.files.get("assets/input.json")!);
      await rm(artifact);
      if (kind === "file") await symlink(outside, artifact);
      else await link(outside, artifact);
    }
    await assert.rejects(verifyLocalPluginPackage({ directory }), {
      code:
        kind === "root"
          ? "plugin_package_directory_invalid"
          : "plugin_package_file_type_invalid",
    });
  }
});

test("nonregular artifacts are rejected without waiting on a FIFO reader", async (t) => {
  const f = await packageFixture(t);
  const artifact = join(f.source, "assets/input.json");
  await rm(artifact);
  await promisify(execFile)("mkfifo", [artifact]);
  await assert.rejects(verifyLocalPluginPackage({ directory: f.source }), {
    code: "plugin_package_file_type_invalid",
  });
});

test("source traversal and actual bytes obey deployment limits including the descriptor", async (t) => {
  const f = await packageFixture(t);
  const bytes =
    f.descriptorBytes.length +
    [...f.files.values()].reduce((n, b) => n + b.length, 0);
  await assert.rejects(
    verifyLocalPluginPackage({
      directory: f.source,
      limits: { fileBytes: f.descriptorBytes.length - 1 },
    }),
    { code: "plugin_package_file_limit" },
  );
  await assert.rejects(
    verifyLocalPluginPackage({
      directory: f.source,
      limits: { totalBytes: bytes - 1 },
    }),
    { code: "plugin_package_total_limit" },
  );
  await assert.rejects(
    verifyLocalPluginPackage({
      directory: f.source,
      limits: { directoryEntries: 2 },
    }),
    { code: "plugin_package_directory_entry_limit" },
  );
  await assert.rejects(
    verifyLocalPluginPackage({
      directory: f.source,
      limits: { directories: 1 },
    }),
    { code: "plugin_package_directory_limit" },
  );
  await assert.rejects(
    verifyLocalPluginPackage({
      directory: f.source,
      limits: { totalBytes: Number.MAX_SAFE_INTEGER },
    }),
    { code: "plugin_package_limits_invalid" },
  );
  await mkdir(join(f.source, "bad\u0085directory"));
  await assert.rejects(verifyLocalPluginPackage({ directory: f.source }), {
    code: "plugin_package_directory_invalid",
  });
});

test("install authorization is required and denied, broken or malformed decisions do not create state", async (t) => {
  for (const kind of ["missing", "deny", "throw", "malformed"] as const) {
    const f = await packageFixture(t);
    const input: InstallLocalPluginPackageInput = {
      directory: f.source,
      installRoot: f.installRoot,
      authorization:
        kind === "missing"
          ? (undefined as never)
          : async () => {
              if (kind === "throw")
                throw new Error("fixture policy unavailable");
              if (kind === "malformed") return { outcome: "unknown" } as never;
              return { outcome: "deny" };
            },
    };
    await assert.rejects(installLocalPluginPackage(input), {
      code:
        kind === "missing"
          ? "plugin_package_installation_authorization_required"
          : kind === "deny"
            ? "plugin_package_installation_denied"
            : "plugin_package_installation_authorization_unavailable",
    });
    assert.deepEqual(await readdir(f.installRoot), []);
  }
});

test("authorization approves a frozen snapshot even if the source later changes", async (t) => {
  const f = await packageFixture(t);
  const expected = await verifyLocalPluginPackage({ directory: f.source });
  const entered = deferred();
  const release = deferred();
  const install = installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: async () => {
      entered.resolve();
      await release.promise;
      return { outcome: "allow" };
    },
  });
  await entered.promise;
  await writeFile(
    join(f.source, "assets/input.json"),
    "new unchecked source bytes",
  );
  await f.rewriteDescriptor({ ...f.descriptor, version: "2.0.0" });
  await writeFile(join(f.source, "extra.txt"), "new unapproved source file");
  release.resolve();
  const result = await install;
  assert.equal(result.packageDigest, expected.packageDigest);
  assert.equal(result.descriptor.version, "1.0.0");
  await assertCandidateBytes(f, result.directory);
  await assert.rejects(lstat(join(result.directory, "extra.txt")), {
    code: "ENOENT",
  });
});

test("cancellation during asynchronous authorization creates no partial installed package", async (t) => {
  const f = await packageFixture(t);
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  const reason = new Error("fixture cancelled");
  const operation = installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    signal: controller.signal,
    authorization: async () => {
      entered.resolve();
      await release.promise;
      return { outcome: "allow" };
    },
  });
  const rejected = assert.rejects(operation, (error) => error === reason);
  await entered.promise;
  controller.abort(reason);
  await rejected;
  release.resolve();
  assert.deepEqual(await readdir(f.installRoot), []);
});

test("concurrent installers publish one immutable version and reverify the winner", async (t) => {
  const f = await packageFixture(t);
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      installLocalPluginPackage({
        directory: f.source,
        installRoot: f.installRoot,
        authorization: allowInstallation,
      }),
    ),
  );
  assert.equal(
    results.filter((result) => result.outcome === "installed").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.outcome === "alreadyInstalled").length,
    3,
  );
  assert.equal(new Set(results.map((result) => result.directory)).size, 1);
  assert.deepEqual(await directoryNames(join(f.installRoot, "packages")), [
    results[0]!.packageDigest.slice(7),
  ]);
  assert.deepEqual(await directoryNames(join(f.installRoot, ".staging")), []);
  assert.deepEqual(await directoryNames(join(f.installRoot, ".locks")), []);
  await assertCandidateBytes(f, results[0]!.directory);
});

test("different content versions coexist and descriptor bytes participate in package identity", async (t) => {
  const f = await packageFixture(t);
  const first = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  await f.rewriteDescriptor({ ...f.descriptor, version: "2.0.0" });
  const second = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  assert.notEqual(first.packageDigest, second.packageDigest);
  assert.equal(second.descriptor.version, "2.0.0");
  await assertCandidateBytes(f, first.directory);
  await f.rewriteDescriptor(f.descriptor);
  const reformatted = await verifyLocalPluginPackage({ directory: f.source });
  assert.notEqual(reformatted.packageDigest, first.packageDigest);
  assert.deepEqual(reformatted.descriptor, first.descriptor);
  assert.equal((await readdir(join(f.installRoot, "packages"))).length, 2);
});

test("corrupt existing package is preserved and only this attempt's staged copy is cleaned", async (t) => {
  const f = await packageFixture(t);
  const first = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  const artifact = join(first.directory, "assets/input.json");
  await chmod(artifact, 0o600);
  const corrupt = Buffer.from("owner changed stored bytes");
  await writeFile(artifact, corrupt);
  const foreign = join(f.installRoot, ".staging/foreign-operation");
  await mkdir(foreign, { mode: 0o700 });
  await writeFile(join(foreign, "sentinel"), "foreign");
  await assert.rejects(
    installLocalPluginPackage({
      directory: f.source,
      installRoot: f.installRoot,
      authorization: allowInstallation,
    }),
    { code: "plugin_package_existing_invalid" },
  );
  assert.deepEqual(await readFile(artifact), corrupt);
  assert.equal(await readFile(join(foreign, "sentinel"), "utf8"), "foreign");
  assert.deepEqual(await directoryNames(join(f.installRoot, ".staging")), [
    "foreign-operation",
  ]);
  assert.deepEqual(await directoryNames(join(f.installRoot, ".locks")), []);
});

test("a verified same-package retry restores protections without changing bytes or identity", async (t) => {
  const f = await packageFixture(t);
  const first = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  const before = await lstat(first.directory, { bigint: true });
  await chmod(first.directory, 0o700);
  await chmod(join(first.directory, "assets"), 0o700);
  await chmod(join(first.directory, "assets/input.json"), 0o600);
  const retry = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  assert.equal(retry.outcome, "alreadyInstalled");
  assert.equal(
    (await lstat(retry.directory, { bigint: true })).ino,
    before.ino,
  );
  assert.equal((await lstat(retry.directory)).mode & 0o222, 0);
  assert.equal((await lstat(join(retry.directory, "assets"))).mode & 0o222, 0);
  assert.equal(
    (await lstat(join(retry.directory, "assets/input.json"))).mode & 0o222,
    0,
  );
  await assertCandidateBytes(f, retry.directory);
  assert.deepEqual(await directoryNames(join(f.installRoot, ".staging")), []);
});

test("an existing target symlink is never accepted or removed by installation", async (t) => {
  const f = await packageFixture(t);
  const outside = join(f.root, "external-package");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserved");
  let target!: string;
  await assert.rejects(
    installLocalPluginPackage({
      directory: f.source,
      installRoot: f.installRoot,
      authorization: async (candidate) => {
        target = await f.target(candidate.packageDigest);
        await mkdir(join(f.installRoot, "packages"), { mode: 0o700 });
        await symlink(outside, target);
        return { outcome: "allow" };
      },
    }),
    { code: "plugin_package_existing_invalid" },
  );
  assert.ok((await lstat(target)).isSymbolicLink());
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserved");
  assert.deepEqual(await directoryNames(join(f.installRoot, ".staging")), []);
});

test("failed publication rolls back its fully written stage and preserves prior versions", async (t) => {
  const f = await packageFixture(t);
  const first = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  await f.rewriteDescriptor({ ...f.descriptor, version: "2.0.0" });
  const packages = join(f.installRoot, "packages");
  await chmod(packages, 0o500);
  try {
    await assert.rejects(
      installLocalPluginPackage({
        directory: f.source,
        installRoot: f.installRoot,
        authorization: allowInstallation,
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code: string }).code,
          "plugin_package_installation_unavailable",
        );
        assert.equal(
          ((error as Error).cause as NodeJS.ErrnoException).code,
          "EACCES",
        );
        assert.equal(
          ((error as Error).cause as NodeJS.ErrnoException).syscall,
          "rename",
        );
        return true;
      },
    );
  } finally {
    await chmod(packages, 0o700);
  }
  await assertCandidateBytes(f, first.directory);
  assert.deepEqual(await directoryNames(packages), [
    first.packageDigest.slice(7),
  ]);
  assert.deepEqual(await directoryNames(join(f.installRoot, ".staging")), []);
  assert.deepEqual(await directoryNames(join(f.installRoot, ".locks")), []);
});

test("unsafe roots and overlapping paths fail without executing installation policy", async (t) => {
  const f = await packageFixture(t);
  let called = false;
  const authorization = async () => {
    called = true;
    return { outcome: "allow" } as const;
  };
  await chmod(f.installRoot, 0o777);
  await assert.rejects(
    installLocalPluginPackage({
      directory: f.source,
      installRoot: f.installRoot,
      authorization,
    }),
    { code: "plugin_package_install_root_invalid" },
  );
  await chmod(f.installRoot, 0o700);
  await assert.rejects(
    installLocalPluginPackage({
      directory: f.source,
      installRoot: f.source,
      authorization,
    }),
    { code: "plugin_package_installation_paths_overlap" },
  );
  await assert.rejects(
    installLocalPluginPackage({
      directory: f.source,
      installRoot: f.root,
      authorization,
    }),
    { code: "plugin_package_installation_paths_overlap" },
  );
  const linkedRoot = join(f.root, "install-link");
  await symlink(f.installRoot, linkedRoot);
  await assert.rejects(
    installLocalPluginPackage({
      directory: f.source,
      installRoot: linkedRoot,
      authorization,
    }),
    { code: "plugin_package_directory_invalid" },
  );
  assert.equal(called, false);
  assert.deepEqual(await readdir(f.installRoot), []);
});

test("cancelling a busy package lock never deletes another installer's lock", async (t) => {
  const f = await packageFixture(t);
  const controller = new AbortController();
  const entered = deferred();
  const reason = new Error("fixture lock wait cancelled");
  let lock!: string;
  const operation = installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    signal: controller.signal,
    authorization: async (candidate) => {
      const locks = join(f.installRoot, ".locks");
      await mkdir(locks, { mode: 0o700 });
      lock = join(locks, candidate.packageDigest.slice(7));
      await mkdir(lock, { mode: 0o700 });
      entered.resolve();
      return { outcome: "allow" };
    },
  });
  const rejected = assert.rejects(operation, (error) => error === reason);
  await entered.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  controller.abort(reason);
  await rejected;
  assert.ok((await lstat(lock)).isDirectory());
  assert.deepEqual(await directoryNames(join(f.installRoot, "packages")), []);
  assert.deepEqual(await directoryNames(join(f.installRoot, ".staging")), []);
});
