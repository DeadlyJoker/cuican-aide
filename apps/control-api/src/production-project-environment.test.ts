import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CreativeProjectAuthorizationPort } from "@crewon/application";
import {
  composeProductionProjectStartup,
  loadProductionProjectEnvironment,
  parseProductionProjectStartupConfiguration,
  PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV,
  PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
} from "./production-project-environment.ts";
import {
  generationImage,
  generationProjectionFixture,
} from "./project-generation-read-projection.test-support.ts";

const source = {
  pluginId: "crewon.short-drama",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const identity = {
  pluginVersion: "1.0.0",
  manifestDigest: `sha256:${"b".repeat(64)}`,
  implementationDigest: `sha256:${"c".repeat(64)}`,
};
const actions = [
  "crewon.project-generations.v1.generateConcept",
  "crewon.project-generation-queries.v1.queryConceptGeneration",
  "crewon.project-generation-selections.v1.selectConceptImage",
];
const authorization: CreativeProjectAuthorizationPort = {
  async authorize() {
    return { outcome: "deny", reasonCode: "fixture_no_authority" };
  },
};
function document() {
  const target = {
    pluginId: "crewon.comfyui-krea2",
    packageDigest: `sha256:${"d".repeat(64)}`,
    contributionId: "image",
  };
  return {
    schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
    pluginUi: { publications: [{ ...source }] },
    pluginGenerations: {
      publications: [
        { source: { ...source }, target: { ...target, action: "execute" } },
      ],
    },
    pluginQueries: {
      publications: [
        { source: { ...source }, target: { ...target, action: "query" } },
      ],
    },
    generationReads: { version: "crewon.project-generation-read.v1" },
    generationReadUi: { publications: [{ ...source }] },
    resultSelections: {
      version: "crewon.project-concept-selection.v1",
      adapter: "comfyui-krea2",
      identities: [{ ...identity }],
    },
    selectionUi: { publications: [{ ...source }] },
    uiRecovery: {
      version: "crewon.plugin-ui-recovery.v1",
      publications: [{ ...source, actions: [...actions] }],
    },
  };
}

test("missing project opt-in does not inspect inherited environment, files or authorization", async () => {
  let hooks = 0;
  const inherited = Object.create({
    get [PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV]() {
      hooks++;
      return "/must-not-read";
    },
  });
  for (const mode of ["production", "standalone"] as const) {
    assert.equal(await loadProductionProjectEnvironment({}, mode), undefined);
    assert.equal(
      await loadProductionProjectEnvironment(inherited, mode),
      undefined,
    );
  }
  assert.deepEqual(
    composeProductionProjectStartup(
      undefined,
      Object.defineProperty({}, "authorize", {
        get() {
          hooks++;
          throw new Error("must-not-capture");
        },
      }) as CreativeProjectAuthorizationPort,
    ),
    {},
  );
  assert.equal(hooks, 0);
  await assert.rejects(
    loadProductionProjectEnvironment(
      { [PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV]: "/must-not-read" },
      "standalone",
    ),
    /production_project_configuration_invalid/,
  );
  const getter = Object.defineProperty(
    {},
    PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV,
    {
      get() {
        hooks++;
        return "/must-not-read";
      },
    },
  );
  await assert.rejects(loadProductionProjectEnvironment(getter, "production"));
  assert.equal(hooks, 0);
});

test("project startup captures every original publication and binds only the injected policy port", async () => {
  const mutable = document();
  const snapshot = parseProductionProjectStartupConfiguration(mutable);
  mutable.pluginGenerations.publications[0]!.target.action = "forged";
  mutable.uiRecovery.publications[0]!.actions.length = 0;
  mutable.resultSelections.identities[0]!.pluginVersion = "9.0.0";
  assert.equal(
    snapshot.pluginGenerations!.publications[0]!.target.action,
    "execute",
  );
  assert.equal(snapshot.uiRecovery!.publications[0]!.actions.length, 3);
  assert.equal(
    snapshot.resultSelections!.identities[0]!.pluginVersion,
    "1.0.0",
  );
  for (const value of [
    snapshot,
    snapshot.resultSelections,
    snapshot.resultSelections!.identities,
    snapshot.resultSelections!.identities[0],
    snapshot.uiRecovery!.publications[0]!.actions,
  ])
    assert.equal(Object.isFrozen(value), true);
  const policy = {
    calls: 0,
    async authorize(): ReturnType<
      CreativeProjectAuthorizationPort["authorize"]
    > {
      this.calls++;
      return { outcome: "deny", reasonCode: "actual_policy_denied" };
    },
  };
  const composed = composeProductionProjectStartup(snapshot, policy);
  assert.equal(policy.calls, 0);
  policy.authorize = async () => {
    throw new Error("changed-port");
  };
  assert.deepEqual(
    await composed.creativeProjects!.authorization.authorize({
      actor: {
        principalId: "principal",
        actorId: "actor",
        tenantId: "tenant",
        spaceId: "space",
      },
      action: "creativeProject:read",
      resource: {
        kind: "creativeProject",
        tenantId: "tenant",
        spaceId: "space",
        projectId: null,
      },
    }),
    { outcome: "deny", reasonCode: "actual_policy_denied" },
  );
  assert.equal(policy.calls, 1);
  assert.deepEqual(composed.uiRecovery, snapshot.uiRecovery);
  assert.equal(
    typeof composed.creativeProjects!.resultSelections!.verifier.verifyImage,
    "function",
  );
  assert.throws(() =>
    composeProductionProjectStartup({ ...snapshot }, authorization),
  );
  assert.throws(() =>
    composeProductionProjectStartup(
      JSON.parse(JSON.stringify(snapshot)),
      authorization,
    ),
  );
});

test("the configured provider adapter validates original configuration identity without network or execution", () => {
  const composed = composeProductionProjectStartup(
    parseProductionProjectStartupConfiguration(document()),
    authorization,
  );
  const f = generationProjectionFixture();
  const binding = {
    ...f.task.binding,
    tenantId: "tenant-1",
    spaceId: "space-1",
    runId: "original-run",
    configurationDigest: `sha256:${"e".repeat(64)}`,
    bindingDigest: `sha256:${"f".repeat(64)}`,
  };
  const input = {
    generationLink: {
      ...f.link,
      tenantId: binding.tenantId,
      spaceId: binding.spaceId,
      binding,
    },
    configuration: {
      ...f.task.configuration,
      tenantId: binding.tenantId,
      spaceId: binding.spaceId,
      pluginId: binding.pluginId,
      revision: 1,
      ...identity,
      contentDigest: binding.configurationDigest,
    },
    operation: {
      ...f.task.operations[0]!,
      tenantId: binding.tenantId,
      bindingDigest: binding.bindingDigest,
      resultJson: JSON.stringify({ images: [generationImage("exact.png")] }),
    },
    resultIndex: 0,
  };
  const verifier = composed.creativeProjects!.resultSelections!.verifier;
  assert.equal(verifier.verifyImage(input).filename, "exact.png");
  assert.throws(() =>
    verifier.verifyImage({
      ...input,
      configuration: {
        ...input.configuration,
        implementationDigest: `sha256:${"1".repeat(64)}`,
      },
    }),
  );
});

test("deployment JSON rejects identity, pricing, code, unknown fields and accessors without executing hooks", () => {
  let hooks = 0;
  const valid = document();
  for (const key of [
    "authorization",
    "payer",
    "realm",
    "profile",
    "url",
    "wallet",
    "pricing",
    "adapterModule",
    "__proto__",
  ]) {
    assert.throws(() =>
      parseProductionProjectStartupConfiguration({ ...valid, [key]: {} }),
    );
  }
  for (const input of [
    { ...valid, schemaVersion: "v2" },
    {
      ...valid,
      resultSelections: {
        ...valid.resultSelections,
        adapter: "dynamic-module",
      },
    },
    { ...valid, resultSelections: { ...valid.resultSelections, verifier: {} } },
    {
      ...valid,
      resultSelections: {
        ...valid.resultSelections,
        identities: [{ ...identity, url: "https://injected.example/" }],
      },
    },
    {
      ...valid,
      resultSelections: {
        ...valid.resultSelections,
        identities: [identity, identity],
      },
    },
    { ...valid, pluginUi: { ...valid.pluginUi, actions: actions } },
    Object.defineProperty({ ...valid }, "selectionUi", {
      enumerable: true,
      get() {
        hooks++;
        return valid.selectionUi;
      },
    }),
    {
      ...valid,
      resultSelections: Object.defineProperty(
        { ...valid.resultSelections },
        "identities",
        {
          enumerable: true,
          get() {
            hooks++;
            return [identity];
          },
        },
      ),
    },
    {
      ...valid,
      toJSON() {
        hooks++;
        return valid;
      },
    },
    {
      ...valid,
      resultSelections: {
        ...valid.resultSelections,
        identities: [
          Object.defineProperty({ ...identity }, "pluginVersion", {
            enumerable: true,
            get() {
              hooks++;
              return "1.0.0";
            },
          }),
        ],
      },
    },
    { ...valid, [Symbol("unknown")]: true },
  ])
    assert.throws(() => parseProductionProjectStartupConfiguration(input));
  assert.equal(hooks, 0);
});

test("cross-field dependencies and each exact recovery source publication fail before composition", () => {
  const full = document();
  for (const input of [
    { schemaVersion: full.schemaVersion, pluginQueries: full.pluginQueries },
    {
      schemaVersion: full.schemaVersion,
      generationReadUi: full.generationReadUi,
    },
    {
      schemaVersion: full.schemaVersion,
      resultSelections: full.resultSelections,
    },
    { schemaVersion: full.schemaVersion, selectionUi: full.selectionUi },
    { ...full, pluginGenerations: undefined },
    { ...full, pluginQueries: undefined },
    { ...full, selectionUi: undefined },
    ...["pluginId", "packageDigest", "contributionId"].map((key) => ({
      ...full,
      uiRecovery: {
        ...full.uiRecovery,
        publications: [
          {
            ...full.uiRecovery.publications[0],
            [key]:
              key === "packageDigest"
                ? `sha256:${"0".repeat(64)}`
                : "different",
          },
        ],
      },
    })),
  ])
    assert.throws(() => parseProductionProjectStartupConfiguration(input));
  for (let index = 0; index < actions.length; index++) {
    const input = document();
    input.uiRecovery.publications[0]!.actions = [actions[index]!];
    const missing =
      index === 0
        ? "pluginGenerations"
        : index === 1
          ? "pluginQueries"
          : "selectionUi";
    delete (input as Record<string, unknown>)[missing];
    assert.throws(() => parseProductionProjectStartupConfiguration(input));
  }
  const minimal = composeProductionProjectStartup(
    parseProductionProjectStartupConfiguration({
      schemaVersion: full.schemaVersion,
    }),
    authorization,
  );
  assert.equal(
    typeof minimal.creativeProjects!.authorization.authorize,
    "function",
  );
  assert.equal(minimal.uiRecovery, undefined);
});

test("private configuration uses a real current-owner file and accepts the exact 64KiB boundary", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-project-config-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "project.json");
  const alias = join(root, "alias.json");
  const text = JSON.stringify(document());
  const load = (file = path) =>
    loadProductionProjectEnvironment(
      { [PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV]: file },
      "production",
    );
  await writeFile(path, text, { mode: 0o600 });
  assert.equal((await load())?.uiRecovery?.publications[0]?.actions.length, 3);
  await symlink(path, alias);
  await assert.rejects(load(alias));
  await rm(alias);
  await link(path, alias);
  await assert.rejects(load());
  await rm(alias);
  for (const mode of [0o640, 0o604, 0o644]) {
    await chmod(path, mode);
    await assert.rejects(load());
  }
  await chmod(path, 0o600);
  for (const invalid of [
    Buffer.from([0xff]),
    Buffer.from(""),
    Buffer.from("null"),
    Buffer.from('{"schemaVersion":"\\ud800"}'),
  ]) {
    await writeFile(path, invalid);
    await assert.rejects(load());
  }
  const minimal = JSON.stringify({
    schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
  });
  await writeFile(
    path,
    minimal + " ".repeat(65536 - Buffer.byteLength(minimal)),
  );
  assert.equal(
    (await load())?.schemaVersion,
    PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
  );
  await writeFile(
    path,
    minimal + " ".repeat(65537 - Buffer.byteLength(minimal)),
  );
  await assert.rejects(load());
  for (const unsafe of [
    "relative.json",
    `${root}/../${root.split("/").at(-1)}/project.json`,
    `${path}\n`,
    `${path}\ud800`,
  ])
    await assert.rejects(load(unsafe));
  const parentAlias = `${root}-alias`;
  await symlink(root, parentAlias);
  t.after(() => rm(parentAlias));
  await assert.rejects(load(join(parentAlias, "project.json")));
});

test("a replacement during the open-handle read cannot become a captured startup snapshot", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-project-config-race-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "project.json");
  const text = JSON.stringify(document());
  await writeFile(path, text, { mode: 0o600 });
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalRead = prototype.read;
  await probe.close();
  let replaced = false;
  t.mock.method(
    prototype,
    "read",
    async function (this: FileHandle, ...args: Parameters<FileHandle["read"]>) {
      const read = await Reflect.apply(originalRead, this, args);
      if (!replaced) {
        replaced = true;
        await rename(path, `${path}.original`);
        await writeFile(path, text, { mode: 0o600 });
      }
      return read;
    },
  );
  await assert.rejects(
    loadProductionProjectEnvironment(
      { [PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV]: path },
      "production",
    ),
  );
  assert.equal(replaced, true);
});
