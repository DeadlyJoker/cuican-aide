import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseDesktopPluginConfiguration,
  loadDesktopPluginConfiguration,
  assertDesktopPluginConfigurationFileCurrent,
} from "./desktop-plugin-configuration.ts";

const actor = {
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
  principalId: "standalone-principal",
  actorId: "standalone-actor",
};
const base = {
  actor,
  scope: {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "composition-schema-test",
  },
  authorityEpoch: "native-composition-schema-epoch-00001",
  installRoot: "/tmp/composition-schema-test",
  sources: [],
  publications: [],
};
const v1 = { ...base, schemaVersion: "crewon.desktop-plugin-bootstrap.v1" };
const v2 = {
  ...base,
  schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
  projects: {
    version: "crewon.desktop-project-history.v1",
    generationReads: { version: "crewon.project-generation-read.v1" },
  },
};
const v3 = {
  ...base,
  schemaVersion: "crewon.desktop-plugin-bootstrap.v3",
  projects: {
    version: "crewon.desktop-project-execution.v1",
    generationReads: { version: "crewon.project-generation-read.v1" },
  },
};
const pluginComposition = { version: "crewon.desktop-plugin-composition.v1" };

test("Native v1/v2/v3 absence preserves the exact legacy shape; only explicit v3 opts in", () => {
  for (const document of [v1, v2, v3]) {
    assert.deepEqual(parseDesktopPluginConfiguration(document), document);
    assert.equal(
      Object.hasOwn(
        parseDesktopPluginConfiguration(document),
        "pluginComposition",
      ),
      false,
    );
  }
  assert.deepEqual(
    parseDesktopPluginConfiguration({ ...v3, pluginComposition }),
    { ...v3, pluginComposition },
  );
  for (const document of [v1, v2])
    assert.throws(
      () => parseDesktopPluginConfiguration({ ...document, pluginComposition }),
      /desktop_plugin_configuration_invalid/,
    );
});

test("composition declaration cannot carry service identities, implicit permissions or getters", () => {
  for (const value of [
    null,
    undefined,
    {},
    { version: "crewon.desktop-plugin-composition.v2" },
    { ...pluginComposition, hostServices: [] },
    { ...pluginComposition, authorityEpoch: base.authorityEpoch },
  ])
    assert.throws(
      () =>
        parseDesktopPluginConfiguration({ ...v3, pluginComposition: value }),
      /desktop_plugin_configuration_invalid/,
    );
  let reads = 0;
  const document = { ...v3 };
  Object.defineProperty(document, "pluginComposition", {
    enumerable: true,
    get() {
      reads++;
      return pluginComposition;
    },
  });
  assert.throws(
    () => parseDesktopPluginConfiguration(document),
    /desktop_plugin_configuration_invalid/,
  );
  assert.equal(reads, 0);
});

test(
  "composition opt-in is covered by the same actual Native byte and inode pin",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "crewon-composition-config-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "bootstrap.json");
    await writeFile(file, JSON.stringify({ ...v3, pluginComposition }), {
      mode: 0o600,
    });
    const loaded = await loadDesktopPluginConfiguration(file, { actor });
    assertDesktopPluginConfigurationFileCurrent(loaded);
    await writeFile(file, JSON.stringify(v3), { mode: 0o600 });
    assert.throws(
      () => assertDesktopPluginConfigurationFileCurrent(loaded),
      /desktop_plugin_configuration_invalid/,
    );
  },
);
