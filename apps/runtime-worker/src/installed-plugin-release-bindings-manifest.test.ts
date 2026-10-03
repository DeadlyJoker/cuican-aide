import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { prepareInstalledPluginBindingsManifest } from "./plugins/installed-plugin-release-bindings-manifest.ts";

const config = {
  schemaVersion: "crewon.agent-version-runtime-bindings.v0" as const,
  bindings: [],
};
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-release-manifest-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, "bindings.json");
  const original =
    "original user content, unchanged until a committed publication";
  await writeFile(path, original, { mode: 0o600 });
  const stages = async () =>
    (await readdir(directory)).filter((entry) =>
      entry.startsWith(".crewon-installed-bindings-"),
    );
  return { directory, path, original, stages };
}

test("parsed bindings are privately staged and only explicit publication changes the original", async (t) => {
  const f = await fixture(t);
  const artifact = await prepareInstalledPluginBindingsManifest({
    path: f.path,
    config,
  });
  assert.equal(await readFile(f.path, "utf8"), f.original);
  assert.equal((await f.stages()).length, 1);
  const stage = join(f.directory, (await f.stages())[0]!);
  assert.equal((await stat(stage)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(stage, "utf8")), config);
  const first = artifact.publish(),
    second = artifact.publish();
  assert.equal(first, second);
  await first;
  await artifact.close();
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), config);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(await f.stages(), []);
  await assert.rejects(artifact.publish(), /manifest_unavailable/u);
});

test("a user change after staging is preserved and only the original owned staging file is removed", async (t) => {
  const f = await fixture(t);
  const other = join(f.directory, ".crewon-installed-bindings-not-owned");
  await writeFile(other, "another process", { mode: 0o600 });
  const artifact = await prepareInstalledPluginBindingsManifest({
    path: f.path,
    config,
  });
  await writeFile(f.path, "concurrent user edits", { mode: 0o600 });
  await assert.rejects(artifact.publish(), /manifest_unavailable/u);
  await artifact.close();
  assert.equal(await readFile(f.path, "utf8"), "concurrent user edits");
  assert.equal(await readFile(other, "utf8"), "another process");
  assert.deepEqual(await f.stages(), [".crewon-installed-bindings-not-owned"]);
});

for (const change of ["replace", "modify", "symlink"] as const) {
  test(`cleanup never deletes a ${change} staging pathname owned or changed by another writer`, async (t) => {
    const f = await fixture(t);
    const artifact = await prepareInstalledPluginBindingsManifest({
      path: f.path,
      config,
    });
    const stage = join(f.directory, (await f.stages())[0]!);
    if (change === "replace") {
      await rename(stage, join(f.directory, "original-stage-moved"));
      await writeFile(stage, "replacement owned by another process", {
        mode: 0o600,
      });
    } else if (change === "modify") {
      await writeFile(stage, "content edited by another process", {
        mode: 0o600,
      });
    } else {
      await rm(stage);
      await symlink(f.path, stage);
    }
    await assert.rejects(artifact.publish(), /manifest_unavailable/u);
    await assert.rejects(artifact.close(), /manifest_unavailable/u);
    assert.equal(await readFile(f.path, "utf8"), f.original);
    assert.equal((await f.stages()).length, 1);
    assert.equal(
      await readFile(stage, "utf8"),
      change === "symlink"
        ? f.original
        : change === "modify"
          ? "content edited by another process"
          : "replacement owned by another process",
    );
  });
}

test("close cancels a pending publication, joins its work and preserves the source", async (t) => {
  const f = await fixture(t);
  const artifact = await prepareInstalledPluginBindingsManifest({
    path: f.path,
    config,
  });
  const publication = artifact.publish();
  const rejected = assert.rejects(publication, /manifest_unavailable/u);
  const first = artifact.close();
  assert.equal(first, artifact.close());
  await Promise.all([rejected, first]);
  assert.equal(await readFile(f.path, "utf8"), f.original);
  assert.deepEqual(await f.stages(), []);
});

test("linked or oversized source files are rejected before creating any staging file", async (t) => {
  const f = await fixture(t);
  for (const kind of ["symlink", "hardlink", "oversized"] as const) {
    const path = join(f.directory, kind);
    if (kind === "symlink") await symlink(f.path, path);
    else if (kind === "hardlink") await link(f.path, path);
    else
      await writeFile(path, new Uint8Array(1024 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(
      prepareInstalledPluginBindingsManifest({ path, config }),
      /manifest_unavailable/u,
    );
    assert.deepEqual(await f.stages(), []);
  }
  assert.equal(await readFile(f.path, "utf8"), f.original);
});
