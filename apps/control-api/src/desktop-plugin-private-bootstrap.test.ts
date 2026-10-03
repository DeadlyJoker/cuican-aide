import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  mkdtemp,
  realpath,
  chmod,
  writeFile,
  link,
  symlink,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";

const actor = Object.freeze({
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
});
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-bootstrap-read-")),
  );
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "bootstrap.json");
  const value = {
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: "native-file-profile",
    },
    authorityEpoch: "a".repeat(64),
    installRoot: join(root, "plugins"),
    sources: [],
    publications: [],
  };
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { root, path, value };
}

test("native bootstrap loader accepts the actual private bounded file and rejects a real hard link", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await loadDesktopPluginConfiguration(f.path, { actor }),
    f.value,
  );
  await link(f.path, join(f.root, "linked.json"));
  await assert.rejects(
    loadDesktopPluginConfiguration(f.path, { actor }),
    /desktop_plugin_configuration_invalid/u,
  );
});

test("native bootstrap loader rejects a real ancestor symlink and a public parent", async (t) => {
  const f = await fixture(t),
    alias = f.root + "-alias";
  t.after(() => rm(alias, { force: true }));
  await symlink(f.root, alias);
  await assert.rejects(
    loadDesktopPluginConfiguration(join(alias, "bootstrap.json"), { actor }),
    /desktop_plugin_configuration_invalid/u,
  );
  await chmod(f.root, 0o755);
  await assert.rejects(
    loadDesktopPluginConfiguration(f.path, { actor }),
    /desktop_plugin_configuration_invalid/u,
  );
});

test("native bootstrap loader rejects a real FIFO before trying to open a reader", async (t) => {
  const f = await fixture(t),
    fifo = join(f.root, "fifo");
  execFileSync("mkfifo", [fifo]);
  await assert.rejects(
    loadDesktopPluginConfiguration(fifo, { actor }),
    /desktop_plugin_configuration_invalid/u,
  );
});

test("native bootstrap loader rejects path replacement while reading the actual still-open original descriptor", async (t) => {
  const f = await fixture(t);
  const handle = await open(f.path, "r");
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  const original = prototype.read;
  await handle.close();
  let replaced = false;
  t.mock.method(
    prototype,
    "read",
    async function (
      this: typeof handle,
      ...args: Parameters<typeof handle.read>
    ) {
      const result = await original.apply(this, args);
      if (!replaced) {
        replaced = true;
        await rename(f.path, join(f.root, "old-bootstrap.json"));
        await writeFile(f.path, JSON.stringify(f.value), { mode: 0o600 });
      }
      return result;
    },
  );
  await assert.rejects(
    loadDesktopPluginConfiguration(f.path, { actor }),
    /desktop_plugin_configuration_invalid/u,
  );
  assert.equal(replaced, true);
});
