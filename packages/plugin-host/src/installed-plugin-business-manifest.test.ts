import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  installLocalPluginPackage,
  readInstalledPluginBusinessManifest,
  type ReadInstalledPluginBusinessManifestInput,
} from "./index.ts";
import {
  allowInstallation,
  deferred,
  packageFixture,
} from "./local-plugin-package.test-support.ts";

async function fixture(
  t: TestContext,
  options: { bytes?: Buffer; missingManifest?: boolean } = {},
) {
  const f = await packageFixture(t);
  const path = "business/manifest.json";
  const manifest = {
    arbitraryBusinessVersion: "fixture-v9",
    capabilities: [{ name: "example.image", parameters: { count: 1 } }],
  };
  const bytes = options.bytes ?? Buffer.from(JSON.stringify(manifest));
  if (!options.missingManifest) {
    await mkdir(dirname(join(f.source, path)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(f.source, path), bytes);
  }
  const descriptor = {
    ...f.descriptor,
    entrypoints: {
      ...f.descriptor.entrypoints,
      ui: { path: "dist/entry.mjs", mode: "trustedModule" },
    },
    contributions: [
      {
        id: "fixture-workbench",
        title: "Fixture workbench",
        kind: "module",
        slot: "main.content",
      },
    ],
    businessManifestPath: options.missingManifest ? null : path,
    files: [
      ...f.descriptor.files,
      ...(options.missingManifest
        ? []
        : [
            {
              path,
              byteLength: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ]),
    ],
  };
  await f.rewriteDescriptor(descriptor);
  const installed = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  const directory = await f.target(installed.packageDigest);
  const controller = new AbortController();
  const input: ReadInstalledPluginBusinessManifestInput = {
    installRoot: f.installRoot,
    expectedPluginId: installed.descriptor.pluginId,
    expectedPublisherId: installed.descriptor.publisherId,
    expectedVersion: installed.descriptor.version,
    expectedPackageDigest: installed.packageDigest,
    signal: controller.signal,
    authorizeRead: async () => "allow",
  };
  return {
    ...f,
    directory,
    installed,
    input,
    controller,
    manifest,
    manifestPath: join(directory, path),
  };
}

test("reads detached installed business JSON and never executes Node or UI modules", async (t) => {
  const f = await fixture(t);
  let authorizations = 0;
  const result = await readInstalledPluginBusinessManifest({
    ...f.input,
    async authorizeRead(candidate, signal) {
      authorizations++;
      assert.equal(signal, f.controller.signal);
      assert.equal(candidate.packageDigest, f.installed.packageDigest);
      assert.deepEqual(candidate.descriptor, f.installed.descriptor);
      assert.equal(Object.isFrozen(candidate), true);
      assert.equal(Object.isFrozen(candidate.descriptor), true);
      return "allow";
    },
  });
  assert.equal(authorizations, 1);
  assert.equal(result.packageDigest, f.installed.packageDigest);
  assert.deepEqual(result.descriptor, f.installed.descriptor);
  assert.deepEqual(result.manifest, f.manifest);
  (result.manifest as typeof f.manifest).capabilities[0]!.parameters.count = 99;
  const again = await readInstalledPluginBusinessManifest(f.input);
  assert.deepEqual(again.manifest, f.manifest);
  assert.notEqual(again.manifest, result.manifest);
  assert.equal(existsSync(f.marker), false);
});

test("denied or malformed read decisions never return business data or execute modules", async (t) => {
  for (const decision of ["deny", undefined, { outcome: "allow" }])
    await t.test(String(decision), async (child) => {
      const f = await fixture(child);
      await assert.rejects(
        readInstalledPluginBusinessManifest({
          ...f.input,
          authorizeRead: async () => decision as "allow" | "deny",
        }),
        { code: "plugin_business_manifest_read_denied" },
      );
      assert.equal(existsSync(f.marker), false);
    });
});

test("captures deployment values, the original method and native signal before authorization waits", async (t) => {
  const f = await fixture(t);
  const waiting = deferred();
  const entered = deferred();
  let receiver: unknown;
  const input = {
    ...f.input,
    async authorizeRead(this: unknown) {
      receiver = this;
      entered.resolve();
      await waiting.promise;
      return "allow" as const;
    },
  };
  const reading = readInstalledPluginBusinessManifest(input);
  try {
    await entered.promise;
    const replacement = new AbortController();
    replacement.abort(new Error("replacement signal"));
    Object.assign(input, {
      installRoot: "relative replacement",
      expectedPluginId: "other.plugin",
      expectedPublisherId: "other.publisher",
      expectedVersion: "2.0.0",
      expectedPackageDigest: `sha256:${"f".repeat(64)}`,
      signal: replacement.signal,
      authorizeRead: async () => assert.fail("replacement method called"),
    });
    waiting.resolve();
    const result = await reading;
    assert.equal(receiver, input);
    assert.deepEqual(result.manifest, f.manifest);
    assert.equal(result.packageDigest, f.installed.packageDigest);
  } finally {
    waiting.resolve();
    await reading.catch(() => {});
  }
});

test("malformed inputs and accessors reject without invoking a getter or read authority", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const input = {
    ...f.input,
    authorizeRead: async () => {
      calls++;
      return "allow" as const;
    },
  };
  for (const [field, value] of [
    ["installRoot", "relative/plugins"],
    ["expectedPluginId", "INVALID"],
    ["expectedPublisherId", "../other"],
    ["expectedVersion", ""],
    ["expectedPackageDigest", "../other"],
    ["signal", {}],
    ["authorizeRead", undefined],
  ] as const)
    await assert.rejects(
      readInstalledPluginBusinessManifest({
        ...input,
        [field]: value,
      } as ReadInstalledPluginBusinessManifestInput),
    );
  let getters = 0;
  const accessor = Object.defineProperty({ ...input }, "expectedPluginId", {
    enumerable: true,
    get() {
      getters++;
      return f.input.expectedPluginId;
    },
  });
  await assert.rejects(readInstalledPluginBusinessManifest(accessor), {
    code: "plugin_business_manifest_input_invalid",
  });
  assert.equal(getters, 0);
  assert.equal(calls, 0);
});

test("every expected identity field selects the exact installed package before read authority", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  for (const fields of [
    { expectedPluginId: "other.plugin" },
    { expectedPublisherId: "other.publisher" },
    { expectedVersion: "2.0.0" },
    { expectedPackageDigest: `sha256:${"f".repeat(64)}` },
  ])
    await assert.rejects(
      readInstalledPluginBusinessManifest({
        ...f.input,
        ...fields,
        authorizeRead: async () => {
          calls++;
          return "allow";
        },
      }),
    );
  assert.equal(calls, 0);
  assert.equal(existsSync(f.marker), false);
});

test("missing, malformed UTF-8/JSON and oversized manifests reject before authority", async (t) => {
  for (const [name, options, code] of [
    ["missing", { missingManifest: true }, "plugin_business_manifest_missing"],
    [
      "invalid JSON",
      { bytes: Buffer.from("{") },
      "plugin_business_manifest_invalid",
    ],
    [
      "invalid UTF-8",
      { bytes: Buffer.from([0xff]) },
      "plugin_business_manifest_invalid",
    ],
    [
      "oversized",
      { bytes: Buffer.alloc(128 * 1024 + 1, 0x20) },
      "plugin_business_manifest_limit",
    ],
  ] as const)
    await t.test(name, async (child) => {
      const f = await fixture(child, options);
      let calls = 0;
      await assert.rejects(
        readInstalledPluginBusinessManifest({
          ...f.input,
          authorizeRead: async () => {
            calls++;
            return "allow";
          },
        }),
        { code },
      );
      assert.equal(calls, 0);
      assert.equal(existsSync(f.marker), false);
    });
});

test("full package verification rejects unrelated installed file tampering before authority", async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, "assets/input.json");
  await chmod(path, 0o600);
  await writeFile(path, '{"tampered":true}');
  let calls = 0;
  await assert.rejects(
    readInstalledPluginBusinessManifest({
      ...f.input,
      authorizeRead: async () => {
        calls++;
        return "allow";
      },
    }),
  );
  assert.equal(calls, 0);
});

test("authorization-time changes to business bytes or other package bytes reject after authority", async (t) => {
  for (const relative of ["business/manifest.json", "assets/input.json"])
    await t.test(relative, async (child) => {
      const f = await fixture(child);
      await assert.rejects(
        readInstalledPluginBusinessManifest({
          ...f.input,
          authorizeRead: async () => {
            const path = join(f.directory, relative);
            await chmod(path, 0o600);
            await writeFile(path, "{}");
            return "allow";
          },
        }),
      );
      assert.equal(existsSync(f.marker), false);
    });
});

test("read cancellation before or during authority preserves the native abort reason", async (t) => {
  const f = await fixture(t);
  const reason = new Error("fixture_business_read_aborted");
  f.controller.abort(reason);
  await assert.rejects(
    readInstalledPluginBusinessManifest(f.input),
    (error) => error === reason,
  );
  const next = new AbortController();
  await assert.rejects(
    readInstalledPluginBusinessManifest({
      ...f.input,
      signal: next.signal,
      authorizeRead: async () => {
        next.abort(reason);
        return "allow";
      },
    }),
    (error) => error === reason,
  );
});

test("private root and packages permissions are checked before and after authorization", async (t) => {
  for (const which of ["root", "packages"] as const)
    await t.test(which, async (child) => {
      const f = await fixture(child);
      const path =
        which === "root" ? f.installRoot : join(f.installRoot, "packages");
      await chmod(path, 0o777);
      await assert.rejects(readInstalledPluginBusinessManifest(f.input), {
        code: "plugin_package_install_root_invalid",
      });
      await chmod(path, 0o700);
      await assert.rejects(
        readInstalledPluginBusinessManifest({
          ...f.input,
          authorizeRead: async () => {
            await chmod(path, 0o777);
            return "allow";
          },
        }),
        { code: "plugin_package_install_root_invalid" },
      );
    });
});

test("symlink and hardlink boundaries cannot substitute installed business files", async (t) => {
  for (const which of [
    "root",
    "packages",
    "package",
    "parent",
    "file",
    "hardlink",
  ] as const)
    await t.test(which, async (child) => {
      const f = await fixture(child);
      if (which === "hardlink") {
        await chmod(dirname(f.manifestPath), 0o700);
        await link(f.manifestPath, join(f.root, "manifest-link.json"));
      } else {
        const path =
          which === "root"
            ? f.installRoot
            : which === "packages"
              ? join(f.installRoot, "packages")
              : which === "package"
                ? f.directory
                : which === "parent"
                  ? dirname(f.manifestPath)
                  : f.manifestPath;
        await chmod(dirname(path), 0o700);
        if (which !== "file") await chmod(path, 0o700);
        const moved = join(f.root, `moved-${which}`);
        await rename(path, moved);
        await symlink(moved, path);
      }
      await assert.rejects(readInstalledPluginBusinessManifest(f.input));
      assert.equal(existsSync(f.marker), false);
    });
});

test("replacing a pinned manifest parent with identical bytes during authorization is rejected", async (t) => {
  const f = await fixture(t);
  await chmod(f.directory, 0o700);
  await chmod(dirname(f.manifestPath), 0o700);
  await assert.rejects(
    readInstalledPluginBusinessManifest({
      ...f.input,
      authorizeRead: async () => {
        const path = dirname(f.manifestPath);
        const bytes = await readFile(f.manifestPath);
        await rename(path, join(f.root, "original-business"));
        await mkdir(path, { mode: 0o700 });
        await writeFile(f.manifestPath, bytes);
        return "allow";
      },
    }),
    { code: "plugin_package_source_changed" },
  );
});

test("business JSON need not use a Host business schema", async (t) => {
  const f = await fixture(t, {
    bytes: Buffer.from('[null, 1, true, "opaque"]'),
  });
  const result = await readInstalledPluginBusinessManifest(f.input);
  assert.deepEqual(result.manifest, [null, 1, true, "opaque"]);
  assert.equal(existsSync(f.marker), false);
});
