import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE } from "@crewon/plugin-host";
import {
  nativeAuthorityFixture,
  nativeDigest,
} from "./installed-plugin-native-authority.test-support.ts";
import { createInstalledPluginWorkerAuthority } from "./plugins/installed-plugin-worker-authority.ts";

test("Native Worker obtains only the actual execution Registry identity from an explicitly pinned v3 declaration", async (t) => {
  const f = await nativeAuthorityFixture(t);
  assert.equal(
    f.authority.installedPluginExecution.compositionExecution,
    undefined,
  );
  await f.authority.close();
  const bootstrap = JSON.parse(readFileSync(f.bootstrap.bootstrapPath, "utf8"));
  bootstrap.schemaVersion = "crewon.desktop-plugin-bootstrap.v3";
  bootstrap.projects = {
    version: "crewon.desktop-project-execution.v1",
    generationReads: { version: "crewon.project-generation-read.v1" },
  };
  bootstrap.pluginComposition = {
    version: "crewon.desktop-plugin-composition.v1",
  };
  const bootstrapPath = join(
    f.directory,
    `plugin-bootstrap-${nativeDigest(JSON.stringify(bootstrap)).slice(7)}.json`,
  );
  writeFileSync(bootstrapPath, JSON.stringify(bootstrap), { mode: 0o600 });
  writeFileSync(
    f.authorityPath,
    JSON.stringify({
      ...f.document,
      bootstrapPath,
      bootstrapDigest: nativeDigest(readFileSync(bootstrapPath)),
    }),
    { mode: 0o600 },
  );
  const worker = createInstalledPluginWorkerAuthority(f.config);
  try {
    assert.deepEqual(
      worker.installedPluginExecution.compositionExecution?.hostServiceMetadata,
      [PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE],
    );
    assert.ok(
      Object.isFrozen(worker.installedPluginExecution.compositionExecution),
    );
  } finally {
    await worker.close();
  }
});

test("pinning a v1/v2 or malformed opt-in cannot make Native Worker grant composition execution", async (t) => {
  const f = await nativeAuthorityFixture(t);
  await f.authority.close();
  const original = JSON.parse(readFileSync(f.bootstrap.bootstrapPath, "utf8"));
  for (const [version, declaration] of [
    ["v1", { version: "crewon.desktop-plugin-composition.v1" }],
    ["v2", { version: "crewon.desktop-plugin-composition.v1" }],
    ["v3", { version: "crewon.desktop-plugin-composition.v2" }],
    [
      "v3",
      {
        version: "crewon.desktop-plugin-composition.v1",
        hostServices: [PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE],
      },
    ],
  ] as const) {
    const bootstrap = {
      ...original,
      schemaVersion: `crewon.desktop-plugin-bootstrap.${version}`,
      pluginComposition: declaration,
      ...(version === "v1"
        ? {}
        : {
            projects: {
              version:
                version === "v2"
                  ? "crewon.desktop-project-history.v1"
                  : "crewon.desktop-project-execution.v1",
              generationReads: { version: "crewon.project-generation-read.v1" },
            },
          }),
    };
    const bootstrapPath = join(
      f.directory,
      `plugin-bootstrap-${nativeDigest(JSON.stringify(bootstrap)).slice(7)}.json`,
    );
    writeFileSync(bootstrapPath, JSON.stringify(bootstrap), { mode: 0o600 });
    writeFileSync(
      f.authorityPath,
      JSON.stringify({
        ...f.document,
        bootstrapPath,
        bootstrapDigest: nativeDigest(readFileSync(bootstrapPath)),
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () => createInstalledPluginWorkerAuthority(f.config),
      /composition_(configuration_binding_invalid|invalid)/,
    );
  }
});
