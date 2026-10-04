import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fileSystemPromises from "node:fs/promises";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES } from "@crewon/contracts/plugins";
import {
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV as ENV,
  assertDesktopInstalledPluginTaskConfig,
  assertDesktopInstalledPluginTaskConfigCurrent,
  assertDesktopInstalledPluginTaskConfigFileIssued,
  isDesktopInstalledPluginTaskConfigFileIssued,
  loadDesktopInstalledPluginTaskEnvironment,
  parseDesktopInstalledPluginTaskConfig,
} from "./desktop-installed-plugin-task-environment.ts";
import {
  candidateActor,
  candidateScope,
} from "./installed-plugin-peer-candidate.test-support.ts";

const invalid = /desktop_installed_plugin_task_configuration_invalid/u;
const tokenFields = [
  ["TEST_NATIVE_TASK_POLICY_TOKEN", "taskPolicyToken"],
  ["TEST_NATIVE_UI_POLICY_TOKEN", "uiPolicyToken"],
  ["TEST_NATIVE_PACKAGE_TOKEN", "packageToken"],
  ["TEST_NATIVE_QUOTE_TOKEN", "quoteToken"],
] as const;

/** Real private files, with named wire-only authority/identity fixtures. No tasks or funds. */
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-task-private-file-")),
  );
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const authority = (
    name: string,
    serviceTokenEnvironmentVariable: string,
  ) => ({
    url: `https://native-tasks.fixture.example/${name}`,
    serviceTokenEnvironmentVariable,
  });
  const value = {
    schemaVersion: "crewon.desktop-installed-plugin-tasks.v1",
    actor: candidateActor,
    scope: candidateScope,
    authorityEpoch: "named_native_task_bootstrap_epoch_" + "e".repeat(32),
    installRoot: join(root, "installed"),
    activationDigest: `sha256:${createHash("sha256").update("named-activation-publication-wire-fixture").digest("hex")}`,
    uiPublications: [
      {
        pluginId: "fixture.native-tasks",
        packageDigest: `sha256:${"a".repeat(64)}`,
        contributionId: "workbench",
      },
    ],
    taskPolicyAuthority: authority("task-policy", tokenFields[0][0]),
    uiPolicyAuthority: authority("ui-policy", tokenFields[1][0]),
    packageAuthority: authority("package", tokenFields[2][0]),
    quoteAuthority: authority("quote", tokenFields[3][0]),
    timeoutMs: 1000,
    maximumPackages: 8,
  };
  const path = join(root, "tasks.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const environment = {
    [ENV]: path,
    TEST_NATIVE_TASK_POLICY_TOKEN: "named-task-policy-" + "t".repeat(32),
    TEST_NATIVE_UI_POLICY_TOKEN: "named-ui-policy-" + "u".repeat(32),
    TEST_NATIVE_PACKAGE_TOKEN: "named-package-" + "p".repeat(32),
    TEST_NATIVE_QUOTE_TOKEN: "named-quote-" + "q".repeat(32),
  };
  const input = {
    securityMode: "standalone" as const,
    desktopBootstrapPath: join(root, "bootstrap.json"),
    activationConfigPath: join(root, "activation.json"),
  };
  return { root, path, value, environment, input };
}

test("absent Native task opt-in reads only its own environment descriptor, without credentials, companion paths or file allocation", async () => {
  const descriptors: PropertyKey[] = [];
  const environment = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(_target, key) {
        descriptors.push(key);
        assert.equal(key, ENV);
        return undefined;
      },
      get() {
        throw new Error("absent-task-opt-in-must-not-read-values");
      },
    },
  );
  const input = new Proxy(
    { securityMode: "production" as const },
    {
      get() {
        throw new Error("absent-task-opt-in-must-not-read-companions");
      },
      getOwnPropertyDescriptor() {
        throw new Error("absent-task-opt-in-must-not-inspect-companions");
      },
    },
  );
  assert.equal(
    await loadDesktopInstalledPluginTaskEnvironment(environment, input),
    undefined,
  );
  assert.deepEqual(descriptors, [ENV]);
  assert.equal(
    await loadDesktopInstalledPluginTaskEnvironment(
      { [ENV]: undefined },
      input,
    ),
    undefined,
  );
});

test("programmatic Native task configuration is frozen and redacted but cannot acquire private-file provenance or be copied", async (t) => {
  const f = await fixture(t);
  const parsed = parseDesktopInstalledPluginTaskConfig(f.value, f.environment);
  assertDesktopInstalledPluginTaskConfig(parsed);
  assertDesktopInstalledPluginTaskConfigCurrent(parsed);
  assert.equal(isDesktopInstalledPluginTaskConfigFileIssued(parsed), false);
  assert.throws(
    () => assertDesktopInstalledPluginTaskConfigFileIssued(parsed),
    invalid,
  );
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.publication));
  assert.ok(Object.isFrozen(parsed.publication.uiPublications[0]));
  for (const value of [
    { ...parsed },
    Object.create(Object.getPrototypeOf(parsed)),
    null,
  ]) {
    assert.equal(isDesktopInstalledPluginTaskConfigFileIssued(value), false);
    assert.throws(() => assertDesktopInstalledPluginTaskConfig(value), invalid);
  }
  for (const output of [JSON.stringify(parsed), inspect(parsed)]) {
    assert.ok(output.includes("REDACTED"));
    for (const [, token] of tokenFields)
      assert.ok(!output.includes(parsed[token]));
  }
});

test("all four Native execution secrets require own enumerable bounded data and never invoke credential getters", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  for (const [name] of tokenFields) {
    for (const value of [
      undefined,
      "short",
      "a".repeat(8193),
      "a".repeat(32) + "\n",
    ]) {
      assert.throws(
        () =>
          parseDesktopInstalledPluginTaskConfig(f.value, {
            ...f.environment,
            [name]: value,
          }),
        invalid,
      );
    }
    const getter = Object.defineProperty({ ...f.environment }, name, {
      enumerable: true,
      get() {
        calls++;
        return "never-read-" + "s".repeat(32);
      },
    });
    assert.throws(
      () => parseDesktopInstalledPluginTaskConfig(f.value, getter),
      invalid,
    );
    const hidden = Object.defineProperty({ ...f.environment }, name, {
      enumerable: false,
      value: f.environment[name],
    });
    assert.throws(
      () => parseDesktopInstalledPluginTaskConfig(f.value, hidden),
      invalid,
    );
  }
  assert.throws(
    () =>
      parseDesktopInstalledPluginTaskConfig(
        f.value,
        Object.create(f.environment),
      ),
    invalid,
  );
  assert.equal(calls, 0);
});

test("real Native task private-file loading preserves captured secrets and distinguishes current file provenance", async (t) => {
  const f = await fixture(t);
  const loaded = await loadDesktopInstalledPluginTaskEnvironment(
    f.environment,
    f.input,
  );
  assert.ok(loaded);
  assert.deepEqual(loaded.publication, f.value);
  assert.ok(isDesktopInstalledPluginTaskConfigFileIssued(loaded));
  assertDesktopInstalledPluginTaskConfigFileIssued(loaded);
  assertDesktopInstalledPluginTaskConfigCurrent(loaded);
  for (const [name, token] of tokenFields)
    assert.equal(loaded[token], f.environment[name]);
  const originalQuote = loaded.quoteToken;
  f.environment.TEST_NATIVE_QUOTE_TOKEN = "rotated-quote-" + "r".repeat(32);
  assert.equal(loaded.quoteToken, originalQuote);
  for (const output of [JSON.stringify(loaded), inspect(loaded)]) {
    assert.ok(output.includes("REDACTED"));
    for (const [, token] of tokenFields)
      assert.ok(!output.includes(loaded[token]));
  }
  assert.equal(
    isDesktopInstalledPluginTaskConfigFileIssued({ ...loaded }),
    false,
  );
});

test("Native execution requires standalone and explicit canonical bootstrap and activation companion paths", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { ...f.input, securityMode: "production" as const },
    { securityMode: "standalone" as const },
    {
      securityMode: "standalone" as const,
      desktopBootstrapPath: f.input.desktopBootstrapPath,
    },
    {
      securityMode: "standalone" as const,
      activationConfigPath: f.input.activationConfigPath,
    },
    { ...f.input, desktopBootstrapPath: "relative/bootstrap.json" },
    { ...f.input, activationConfigPath: f.root + "/nested/../activation.json" },
  ])
    await assert.rejects(
      loadDesktopInstalledPluginTaskEnvironment(f.environment, input),
      invalid,
    );
  let calls = 0;
  const options = Object.defineProperty(
    { ...f.input },
    "activationConfigPath",
    {
      enumerable: true,
      get() {
        calls++;
        return f.input.activationConfigPath;
      },
    },
  );
  await assert.rejects(
    loadDesktopInstalledPluginTaskEnvironment(f.environment, options),
    invalid,
  );
  const environment = Object.defineProperty({ ...f.environment }, ENV, {
    enumerable: true,
    get() {
      calls++;
      return f.path;
    },
  });
  await assert.rejects(
    loadDesktopInstalledPluginTaskEnvironment(environment, f.input),
    invalid,
  );
  assert.equal(calls, 0);
});

test("Native task loading refuses public leaves or parents, hard links and symlinks before issuing a grant", async (t) => {
  for (const change of [
    "public-leaf",
    "public-parent",
    "hard-link",
    "leaf-link",
    "ancestor-link",
  ] as const) {
    await t.test(change, async (child) => {
      const f = await fixture(child);
      let path = f.path;
      if (change === "public-leaf") await chmod(path, 0o644);
      else if (change === "public-parent") await chmod(f.root, 0o755);
      else if (change === "hard-link")
        await link(path, join(f.root, "second-link.json"));
      else if (change === "leaf-link") {
        path = join(f.root, "task-symlink.json");
        await symlink(f.path, path);
      } else {
        const alias = f.root + "-alias";
        child.after(() => rm(alias, { force: true }));
        await symlink(f.root, alias);
        path = join(alias, "tasks.json");
      }
      await assert.rejects(
        loadDesktopInstalledPluginTaskEnvironment(
          { ...f.environment, [ENV]: path },
          f.input,
        ),
        invalid,
      );
    });
  }
});

test("Native task loading refuses directories, empty or oversized files and malformed UTF-8 or JSON", async (t) => {
  for (const change of [
    "directory",
    "empty",
    "oversized",
    "invalid-utf8",
    "invalid-json",
  ] as const) {
    await t.test(change, async (child) => {
      const f = await fixture(child);
      let path = f.path;
      if (change === "directory") {
        path = join(f.root, "task-directory");
        await mkdir(path, { mode: 0o700 });
      } else {
        const bytes =
          change === "empty"
            ? Buffer.alloc(0)
            : change === "oversized"
              ? Buffer.alloc(
                  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES + 1,
                  " ",
                )
              : change === "invalid-utf8"
                ? Buffer.from([0xff, 0xfe])
                : Buffer.from("{incomplete-json");
        await writeFile(path, bytes, { mode: 0o600 });
      }
      await assert.rejects(
        loadDesktopInstalledPluginTaskEnvironment(
          { ...f.environment, [ENV]: path },
          f.input,
        ),
        invalid,
      );
    });
  }
});

test(
  "a real Native task FIFO is refused without waiting for a writer",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const path = join(f.root, "tasks-fifo");
    await promisify(execFile)("mkfifo", ["-m", "600", path]);
    await assert.rejects(
      loadDesktopInstalledPluginTaskEnvironment(
        { ...f.environment, [ENV]: path },
        f.input,
      ),
      invalid,
    );
  },
);

test("same bytes at a replaced leaf or an in-place rewrite cannot satisfy the original Native file pins", async (t) => {
  for (const change of ["replace", "rewrite", "parent-mode"] as const) {
    await t.test(change, async (child) => {
      const f = await fixture(child);
      const loaded = await loadDesktopInstalledPluginTaskEnvironment(
        f.environment,
        f.input,
      );
      assert.ok(loaded);
      if (change === "replace") {
        await rename(f.path, join(f.root, "original-tasks.json"));
        await writeFile(f.path, JSON.stringify(f.value), { mode: 0o600 });
      } else if (change === "rewrite") {
        await writeFile(f.path, JSON.stringify(f.value), { mode: 0o600 });
        // Pin drift is deterministic even on filesystems that coalesce nearby timestamps.
        await utimes(f.path, 1_700_000_000, 1_700_000_000);
      } else await chmod(f.root, 0o755);
      assert.equal(isDesktopInstalledPluginTaskConfigFileIssued(loaded), true);
      assert.throws(
        () => assertDesktopInstalledPluginTaskConfigCurrent(loaded),
        invalid,
      );
      assert.throws(
        () => assertDesktopInstalledPluginTaskConfigFileIssued(loaded),
        invalid,
      );
    });
  }
});

test("a path replaced during the actual still-open bounded read cannot issue a Native task file grant", async (t) => {
  const f = await fixture(t);
  const probe = await open(f.path, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    read: FileHandle["read"];
  };
  const original = prototype.read;
  await probe.close();
  let replaced = false;
  t.mock.method(
    prototype,
    "read",
    async function (this: FileHandle, ...args: Parameters<typeof original>) {
      const result = await Reflect.apply(original, this, args);
      if (!replaced) {
        replaced = true;
        await rename(f.path, join(f.root, "original-open-tasks.json"));
        await writeFile(f.path, JSON.stringify(f.value), { mode: 0o600 });
      }
      return result;
    },
  );
  await assert.rejects(
    loadDesktopInstalledPluginTaskEnvironment(f.environment, f.input),
    invalid,
  );
  assert.equal(replaced, true);
});

test("Native task file issuance accepts an unrelated same-parent sibling created after capture and before the actual bounded file read", async (t) => {
  const f = await fixture(t);
  const calls = await withOpenMutation(
    t,
    f.path,
    () => mkdir(join(f.root, "unrelated-sibling"), { mode: 0o700 }),
    async () => {
      const loaded = await loadDesktopInstalledPluginTaskEnvironment(
        f.environment,
        f.input,
      );
      assert.ok(loaded);
      assert.deepEqual(loaded.publication, f.value);
      assertDesktopInstalledPluginTaskConfigFileIssued(loaded);
      assertDesktopInstalledPluginTaskConfigCurrent(loaded);
    },
  );
  assert.equal(calls.opens, 1);
  assert.ok(calls.reads > 0);
});

test("Native task file issuance still refuses leaf or parent replacement and permission changes between capture and actual open", async (t) => {
  for (const change of [
    "replace-leaf",
    "replace-parent",
    "leaf-mode",
    "parent-mode",
  ] as const) {
    await t.test(change, async (child) => {
      const f = await fixture(child);
      const originalParent = f.root + "-original";
      child.after(() => rm(originalParent, { recursive: true, force: true }));
      const calls = await withOpenMutation(
        child,
        f.path,
        async () => {
          if (change === "replace-leaf") {
            await rename(f.path, join(f.root, "original-tasks.json"));
            await writeFile(f.path, JSON.stringify(f.value), { mode: 0o600 });
          } else if (change === "replace-parent") {
            // The real open still reaches the untouched original leaf; only its parent changed.
            await rename(f.root, originalParent);
            await symlink(originalParent, f.root);
          } else if (change === "leaf-mode") await chmod(f.path, 0o644);
          else await chmod(f.root, 0o755);
        },
        () =>
          assert.rejects(
            loadDesktopInstalledPluginTaskEnvironment(f.environment, f.input),
            invalid,
          ),
      );
      assert.equal(calls.opens, 1);
      if (change === "replace-parent" || change === "parent-mode")
        assert.ok(calls.reads > 0);
      else assert.equal(calls.reads, 0);
    });
  }
});

/** Observes the original built-in open/read; no replacement descriptor or read result is supplied. */
async function withOpenMutation(
  t: TestContext,
  path: string,
  mutate: () => Promise<unknown>,
  work: () => Promise<unknown>,
) {
  const originalOpen = fileSystemPromises.open;
  const handles: FileHandle[] = [];
  let reads = 0;
  const observer = t.mock.method(
    fileSystemPromises,
    "open",
    async (...args: Parameters<typeof originalOpen>) => {
      if (args[0] === path) await mutate();
      const handle = (await Reflect.apply(
        originalOpen,
        fileSystemPromises,
        args,
      )) as FileHandle;
      if (args[0] === path) {
        handles.push(handle);
        const originalRead = handle.read;
        t.mock.method(
          handle,
          "read",
          async function (
            this: FileHandle,
            ...args: Parameters<typeof originalRead>
          ) {
            assert.equal(this, handle);
            reads++;
            return Reflect.apply(originalRead, this, args);
          },
        );
      }
      return handle;
    },
  );
  syncBuiltinESMExports();
  try {
    await work();
  } finally {
    observer.mock.restore();
    syncBuiltinESMExports();
  }
  for (const handle of handles) assert.equal(handle.fd, -1);
  return { opens: handles.length, reads };
}
