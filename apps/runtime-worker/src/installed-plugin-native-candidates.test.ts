import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseNativeInstalledPluginPreparationResult } from "@crewon/contracts/plugins";
import {
  createExtensionConfiguration,
  type ExtensionConfiguration,
} from "@crewon/domain";
import {
  prepareNativeInstalledPluginCandidates as prepare,
  type NativeInstalledPluginCandidatesInput,
} from "./plugins/installed-plugin-native-candidates.ts";
import { prepareNativeInstalledPluginRelease } from "./plugins/installed-plugin-native-preparation.ts";
import {
  INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA,
  parseNativeInstalledPluginPreparationConfiguration,
} from "./plugins/installed-plugin-native-preparation-config.ts";
import {
  nativePreparationFixture,
  digester,
  scope,
} from "./installed-plugin-native-preparation.test-support.ts";

function candidates(input: NativeInstalledPluginCandidatesInput) {
  const {
    inputPath,
    environment,
    actor,
    bootstrapVersion,
    defaultAgentVersionId,
    signal,
  } = input;
  return prepare({
    inputPath,
    environment,
    actor,
    bootstrapVersion,
    defaultAgentVersionId,
    ...(signal === undefined ? {} : { signal }),
  });
}
async function twoPlugins(t: Parameters<typeof nativePreparationFixture>[0]) {
  const fixture = await nativePreparationFixture(t);
  const second = await fixture.addPlugin("example.second-native");
  async function input(overrides: Readonly<Record<string, unknown>> = {}) {
    return fixture.input({
      schemaVersion: INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA,
      approvedPackages: [fixture.identity, second.identity],
      plugins: [
        { pluginId: fixture.identity.pluginId, approvalRequirement: "none" },
        {
          pluginId: second.identity.pluginId,
          approvalRequirement: "perAction",
        },
      ],
      ...overrides,
    });
  }
  return { ...fixture, second, input };
}
function removeConfiguration(dataDirectory: string, pluginId: string) {
  const database = new DatabaseSync(join(dataDirectory, "control.sqlite"));
  try {
    database
      .prepare(
        "DELETE FROM extension_configurations WHERE tenant_id=? AND space_id=? AND plugin_id=?",
      )
      .run(scope.tenantId, scope.spaceId, pluginId);
  } finally {
    database.close();
  }
}
async function saveIncompatible(
  fixture: Awaited<ReturnType<typeof twoPlugins>>,
) {
  const saved = createExtensionConfiguration(
    {
      ...fixture.second.configuration,
      pluginVersion: "99.0.0",
      revision: 2,
    },
    digester,
  );
  await fixture.store.extensionStore().saveExtensionConfiguration({
    configuration: saved,
    expectedRevision: 1,
    receipt: {
      actorId: saved.createdByActorId,
      idempotencyKey: "incompatible-second-config",
      requestDigest: digester.sha256("incompatible-second-config"),
    },
  });
  return saved;
}
async function assertMetadataOnly(
  fixture: Awaited<ReturnType<typeof nativePreparationFixture>>,
) {
  assert.ok(
    Object.values(await fixture.recordCounts()).every((count) => count === 0),
  );
  await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
  assert.ok(
    fixture.state.requests.every((path) =>
      ["/actor", "/profile", "/package", "/policy"].includes(path),
    ),
  );
}

test("V2 prepares two real installed plugins without a prior release, source directory, Node, model, IO or money work", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input();
  await fixture.removeSource();
  const output = await candidates(input);
  assert.deepEqual(
    output.result.plugins.map((row) => [row.pluginId, row.state]),
    [
      [fixture.identity.pluginId, "prepared"],
      [fixture.second.identity.pluginId, "prepared"],
    ],
  );
  assert.equal(output.document!.entries.length, 2);
  assert.equal(
    new Set(
      output.document!.entries.map(
        (entry) => entry.modelSource.version.agentVersionId,
      ),
    ).size,
    1,
  );
  assert.equal(
    output.resultPath,
    join(input.directory, "preparation-result.json"),
  );
  assert.deepEqual(
    parseNativeInstalledPluginPreparationResult(
      JSON.parse(await readFile(output.resultPath, "utf8")),
    ),
    output.result,
  );
  assert.deepEqual(
    JSON.parse(await readFile(output.documentPath!, "utf8")),
    output.document,
  );
  for (const path of [output.resultPath, output.documentPath!]) {
    const stat = await lstat(path);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
  }
  await assertMetadataOnly(fixture);
});

test("A missing latest configuration blocks only that actual plugin and keeps the other real candidate", async (t) => {
  const fixture = await twoPlugins(t);
  removeConfiguration(fixture.dataDirectory, fixture.second.identity.pluginId);
  const output = await candidates(await fixture.input());
  assert.deepEqual(output.result.plugins[1], {
    pluginId: fixture.second.identity.pluginId,
    state: "blocked",
    reasonCode: "configurationMissing",
  });
  assert.equal(output.result.plugins[0]!.state, "prepared");
  assert.deepEqual(
    output.document!.entries.map((entry) => entry.packageIdentity.pluginId),
    [fixture.identity.pluginId],
  );
  await assertMetadataOnly(fixture);
});

test("All missing configurations produce only a strict result and leave release.json absent", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input();
  for (const identity of [fixture.identity, fixture.second.identity])
    removeConfiguration(fixture.dataDirectory, identity.pluginId);
  const output = await candidates(input);
  assert.deepEqual(
    output.result.plugins.map(
      (row) => row.state === "blocked" && row.reasonCode,
    ),
    ["configurationMissing", "configurationMissing"],
  );
  assert.equal(output.document, null);
  assert.equal(output.documentPath, null);
  await assert.rejects(readFile(join(input.directory, "release.json")), {
    code: "ENOENT",
  });
  await assertMetadataOnly(fixture);
});

test("V2 empty approvals isolate notApproved while V1 still rejects an unapproved namespace", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input({ approvedPackages: [] });
  const parsed = parseNativeInstalledPluginPreparationConfiguration(
    input.preparation,
  );
  assert.equal(parsed.approvedPackages.length, 0);
  assert.throws(() =>
    parseNativeInstalledPluginPreparationConfiguration({
      ...input.preparation,
      schemaVersion: "crewon.installed-plugin-native-preparation.v1",
    }),
  );
  const output = await candidates(input);
  assert.deepEqual(
    output.result.plugins.map(
      (row) => row.state === "blocked" && row.reasonCode,
    ),
    ["notApproved", "notApproved"],
  );
  assert.equal(output.document, null);
  await assertMetadataOnly(fixture);
});

test("Invalid shared model/default inputs remain fatal even when every plugin is unapproved", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input({ approvedPackages: [] });
  await assert.rejects(
    candidates({ ...input, defaultAgentVersionId: "different-native-default" }),
    /model_mismatch/u,
  );
  assert.equal(fixture.state.requests.length, 0);
  for (const path of ["release.json", "preparation-result.json"])
    await assert.rejects(readFile(join(input.directory, path)), {
      code: "ENOENT",
    });
  await assertMetadataOnly(fixture);
});

test("A real uninstall and a never-installed approved request are candidate failures", async (t) => {
  const fixture = await twoPlugins(t);
  await fixture.select("uninstalled");
  const input = await fixture.input({
    plugins: [
      { pluginId: fixture.identity.pluginId, approvalRequirement: "none" },
      { pluginId: "example.never-installed", approvalRequirement: "none" },
      {
        pluginId: fixture.second.identity.pluginId,
        approvalRequirement: "none",
      },
    ],
  });
  const output = await candidates(input);
  assert.deepEqual(
    output.result.plugins.map((row) =>
      row.state === "blocked" ? row.reasonCode : row.state,
    ),
    ["notInstalled", "notInstalled", "prepared"],
  );
  assert.equal(output.document!.entries.length, 1);
  await assertMetadataOnly(fixture);
});

test("A semantically incompatible genuine saved configuration blocks only its package", async (t) => {
  const fixture = await twoPlugins(t);
  await saveIncompatible(fixture);
  const output = await candidates(await fixture.input());
  assert.deepEqual(output.result.plugins[1], {
    pluginId: fixture.second.identity.pluginId,
    state: "blocked",
    reasonCode: "configurationIncompatible",
  });
  assert.equal(
    output.document!.entries[0]!.packageIdentity.pluginId,
    fixture.identity.pluginId,
  );
  await assertMetadataOnly(fixture);
});

test("Tampered actual installed bytes block only their package without ever importing it", async (t) => {
  const fixture = await twoPlugins(t);
  const path = join(
    fixture.dataDirectory,
    "plugins",
    "packages",
    fixture.second.identity.packageDigest.slice(7),
    "node.mjs",
  );
  await chmod(path, 0o600);
  await writeFile(path, "throw new Error('tampered')");
  const output = await candidates(await fixture.input());
  assert.deepEqual(output.result.plugins[1], {
    pluginId: fixture.second.identity.pluginId,
    state: "blocked",
    reasonCode: "packageUnavailable",
  });
  assert.equal(output.document!.entries.length, 1);
  await assertMetadataOnly(fixture);
});

for (const kind of ["package", "policy"] as const) {
  test(`An explicit ${kind} read denial blocks only that plugin`, async (t) => {
    const fixture = await twoPlugins(t);
    (kind === "package"
      ? fixture.state.deniedPackageIds
      : fixture.state.deniedPolicyPluginIds
    ).add(fixture.second.identity.pluginId);
    const output = await candidates(await fixture.input());
    assert.deepEqual(output.result.plugins[1], {
      pluginId: fixture.second.identity.pluginId,
      state: "blocked",
      reasonCode: "readDenied",
    });
    assert.equal(output.document!.entries.length, 1);
    await assertMetadataOnly(fixture);
  });
}

test("A saved-configuration race after both outputs exist removes the stale candidate and atomically recomposes both files", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input();
  let revised: ExtensionConfiguration | null = null;
  fixture.state.beforeReply = async () => {
    if (
      revised === null &&
      existsSync(join(input.directory, "preparation-result.json"))
    )
      revised = await fixture.revise();
  };
  const output = await candidates(input);
  assert.ok(revised);
  assert.deepEqual(output.result.plugins[0], {
    pluginId: fixture.identity.pluginId,
    state: "blocked",
    reasonCode: "stateChanged",
  });
  assert.equal(output.result.plugins[1]!.state, "prepared");
  assert.deepEqual(
    output.document!.entries.map((entry) => entry.packageIdentity.pluginId),
    [fixture.second.identity.pluginId],
  );
  assert.deepEqual(
    JSON.parse(await readFile(output.resultPath, "utf8")),
    output.result,
  );
  assert.deepEqual(
    JSON.parse(await readFile(output.documentPath!, "utf8")),
    output.document,
  );
  await assertMetadataOnly(fixture);
});

test("A selection race after output removes the sole candidate and leaves only the all-blocked result", async (t) => {
  const fixture = await nativePreparationFixture(t),
    input = await fixture.input({
      schemaVersion: INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA,
    });
  let changed = false;
  fixture.state.beforeReply = async () => {
    if (
      !changed &&
      existsSync(join(input.directory, "preparation-result.json"))
    ) {
      changed = true;
      await fixture.select("uninstalled");
    }
  };
  const output = await candidates(input);
  assert.equal(changed, true);
  assert.deepEqual(output.result.plugins, [
    {
      pluginId: fixture.identity.pluginId,
      state: "blocked",
      reasonCode: "stateChanged",
    },
  ]);
  assert.equal(output.document, null);
  await assert.rejects(readFile(join(input.directory, "release.json")), {
    code: "ENOENT",
  });
  await assertMetadataOnly(fixture);
});

test("A package-read withdrawal after output removes only that prepared candidate", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input();
  fixture.state.beforeReply = async () => {
    if (existsSync(join(input.directory, "preparation-result.json")))
      fixture.state.deniedPackageIds.add(fixture.second.identity.pluginId);
  };
  const output = await candidates(input);
  assert.equal(output.result.plugins[0]!.state, "prepared");
  assert.deepEqual(output.result.plugins[1], {
    pluginId: fixture.second.identity.pluginId,
    state: "blocked",
    reasonCode: "readDenied",
  });
  assert.equal(output.document!.entries.length, 1);
  await assertMetadataOnly(fixture);
});

for (const kind of ["actor", "profile", "file"] as const) {
  test(`A global ${kind} withdrawal after both outputs exist fails and cleans both owned inodes`, async (t) => {
    const fixture = await twoPlugins(t),
      input = await fixture.input();
    let changed = false;
    fixture.state.beforeReply = async () => {
      if (
        !changed &&
        existsSync(join(input.directory, "preparation-result.json"))
      ) {
        changed = true;
        if (kind === "actor") fixture.state.resolvedActor = null;
        else if (kind === "profile")
          fixture.state.profile = {
            ...scope,
            profileId: "withdrawn-native-profile",
          };
        else
          await writeFile(
            input.inputPath,
            JSON.stringify({ ...input.preparation, unexpected: true }),
          );
      }
    };
    await assert.rejects(candidates(input));
    assert.equal(changed, true);
    for (const path of ["release.json", "preparation-result.json"])
      await assert.rejects(readFile(join(input.directory, path)), {
        code: "ENOENT",
      });
    await assertMetadataOnly(fixture);
  });
}

test("Malformed authority identity inside an installed-byte verification callback remains fatal", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input();
  let packages = 0;
  fixture.state.beforeReply = async (path) => {
    if (path === "/package" && ++packages === 2)
      fixture.state.resolvedActor = { ...input.actor, principalId: "" };
  };
  await assert.rejects(candidates(input));
  for (const path of ["release.json", "preparation-result.json"])
    await assert.rejects(readFile(join(input.directory, path)), {
      code: "ENOENT",
    });
  await assertMetadataOnly(fixture);
});

test("A foreign existing result file fails before authority and is never replaced", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input();
  const path = join(input.directory, "preparation-result.json");
  await writeFile(path, "foreign-private-result", { mode: 0o600 });
  await assert.rejects(candidates(input), /output_exists/u);
  assert.equal(await readFile(path, "utf8"), "foreign-private-result");
  assert.equal(fixture.state.requests.length, 0);
  await assert.rejects(readFile(join(input.directory, "release.json")), {
    code: "ENOENT",
  });
});

test("Replacement of a published result inode is fatal, preserves the foreign inode and removes only the owned release", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input();
  const path = join(input.directory, "preparation-result.json");
  let replaced = false;
  fixture.state.beforeReply = async () => {
    if (!replaced && existsSync(path)) {
      replaced = true;
      await rename(path, join(input.directory, "original-result.json"));
      await writeFile(path, "foreign-inode", { mode: 0o600 });
    }
  };
  await assert.rejects(candidates(input));
  assert.equal(replaced, true);
  assert.equal(await readFile(path, "utf8"), "foreign-inode");
  await assert.rejects(readFile(join(input.directory, "release.json")), {
    code: "ENOENT",
  });
});

test("Cancellation keeps actual authority work owned until the blocked HTTP body settles", async (t) => {
  const fixture = await twoPlugins(t),
    input = await fixture.input();
  const controller = new AbortController();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  fixture.state.beforeReply = async (path) => {
    if (!blocked && path === "/package") {
      blocked = true;
      enter();
      await gate;
    }
  };
  let settled = false;
  const pending = candidates({ ...input, signal: controller.signal });
  const observed = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered;
  controller.abort(new Error("named-native-candidate-cancellation"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await assert.rejects(
    pending,
    /named-native-candidate-cancellation|authority_unavailable/u,
  );
  await observed;
  for (const path of ["release.json", "preparation-result.json"])
    await assert.rejects(readFile(join(input.directory, path)), {
      code: "ENOENT",
    });
  await assertMetadataOnly(fixture);
});

test("V1 and V2 helpers reject the other mode before network work", async (t) => {
  const fixture = await nativePreparationFixture(t),
    v1 = await fixture.input(),
    v2 = await fixture.input({
      schemaVersion: INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA,
    });
  await assert.rejects(candidates(v1), /configuration_invalid/u);
  const {
    inputPath,
    environment,
    actor,
    bootstrapVersion,
    defaultAgentVersionId,
  } = v2;
  await assert.rejects(
    prepareNativeInstalledPluginRelease({
      inputPath,
      environment,
      actor,
      bootstrapVersion,
      defaultAgentVersionId,
    }),
    /configuration_invalid/u,
  );
  assert.equal(fixture.state.requests.length, 0);
  for (const input of [v1, v2])
    for (const path of ["release.json", "preparation-result.json"])
      await assert.rejects(readFile(join(input.directory, path)), {
        code: "ENOENT",
      });
});
