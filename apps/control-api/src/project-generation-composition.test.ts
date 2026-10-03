import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { PostgresDomainStore } from "@crewon/store";
import { captureCreativeProjectCompositionConfig } from "./creative-project-composition.ts";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { pluginUiProductionIdentity } from "./production-plugin-ui.test-support.ts";
import {
  createPostgresControlApi,
  createStandaloneControlApiWithCreativeProjects,
} from "./standalone-composition.ts";
import {
  captureProjectGenerationPluginConfiguration,
  assertProjectGenerationExecutionComposition,
} from "./project-generation-plugin-configuration.ts";

const publication = {
  source: {
    pluginId: "fixture.drama",
    packageDigest: "sha256:" + "a".repeat(64),
    contributionId: "workbench",
  },
  target: {
    pluginId: "fixture.krea2",
    packageDigest: "sha256:" + "b".repeat(64),
    contributionId: "workbench",
    action: "image.generate",
  },
};
const allowed = { authorize: async () => ({ outcome: "allow" as const }) };

test("standalone project configuration rejects paid generation before either database opens", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-generation-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "control.sqlite");
  let opened = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    opened++;
    throw new Error("unexpected_database_open");
  });
  const base = {
    actor: {
      principalId: "fixture-principal",
      actorId: "fixture-actor",
      tenantId: "fixture-tenant",
      spaceId: "fixture-space",
    },
    defaultAgentVersionId: "no-model",
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    creativeProjects: {
      authorization: allowed,
      pluginGenerations: { publications: [publication] },
    },
  };
  for (const create of [
    () =>
      createStandaloneControlApiWithCreativeProjects({ ...base, databasePath }),
    () =>
      createPostgresControlApi({
        ...base,
        connectionString: "unusable-postgres-connection",
      }),
  ])
    await assert.rejects(
      create(),
      /standalone_project_generation_execution_authority_required/u,
    );
  await assert.rejects(access(databasePath), { code: "ENOENT" });
  assert.equal(opened, 0);
});

test("generation deployment captures the exact mapping before asynchronous composition and rejects configuration getters", () => {
  assert.equal(
    captureProjectGenerationPluginConfiguration(undefined),
    undefined,
  );
  const mutable = structuredClone(publication);
  const configuration = captureCreativeProjectCompositionConfig({
    authorization: allowed,
    pluginGenerations: { publications: [mutable] },
  })!;
  mutable.source.pluginId = "replaced.business";
  mutable.target.action = "replaced.action";
  assert.deepEqual(configuration.pluginGenerations!.publications, [
    publication,
  ]);
  assert.ok(Object.isFrozen(configuration.pluginGenerations));
  assert.ok(
    Object.isFrozen(configuration.pluginGenerations!.publications[0]!.target),
  );
  let getters = 0;
  assert.throws(
    () =>
      captureCreativeProjectCompositionConfig({
        authorization: allowed,
        get pluginGenerations() {
          getters++;
          return { publications: [publication] };
        },
      }),
    /creative_project_configuration_invalid/u,
  );
  assert.throws(
    () =>
      captureProjectGenerationPluginConfiguration({
        get publications() {
          getters++;
          return [publication];
        },
      }),
    /plugin_security_fields_invalid/u,
  );
  assert.equal(getters, 0);
});

test("explicit generation requires approved source UI and the paid task composition before PostgreSQL opens", async (t) => {
  const identity = pluginUiProductionIdentity();
  let opened = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    opened++;
    throw new Error("unexpected_database_open");
  });
  const configuration = parseProductionPluginUiConfiguration({
    installRoot: "/fixture-installed-root",
    profileAuthority: {
      url: "https://fixture.test/profile",
      serviceToken: "p".repeat(32),
    },
    policyAuthority: {
      url: "https://fixture.test/policy",
      serviceToken: "s".repeat(32),
    },
    publications: [
      {
        pluginId: publication.source.pluginId,
        publisherId: "fixture.publisher",
        packageDigest: publication.source.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    timeoutMs: 1000,
  });
  const base = {
    connectionString: "unusable-postgres-connection",
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    identity: identity.identity,
    authorization: allowed,
    creativeProjects: {
      authorization: allowed,
      pluginGenerations: { publications: [publication] },
    },
  };
  await assert.rejects(
    createProductionPostgresControlApi(base),
    /project_generation_source_publication_unapproved/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      pluginUi: { configuration },
    }),
    /project_generation_execution_composition_required/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      pluginUi: {
        configuration: parseProductionPluginUiConfiguration({
          ...configuration,
          publications: [
            {
              ...configuration.publications[0]!,
              packageDigest: publication.target.packageDigest,
            },
          ],
        }),
      },
    }),
    /project_generation_source_publication_unapproved/u,
  );
  assert.equal(opened, 0);
  assert.equal(identity.reads(), 0);
});

test("the generation composition guard preserves default-off and refuses a second externally owned dispatcher", () => {
  assert.doesNotThrow(() =>
    assertProjectGenerationExecutionComposition({
      generations: undefined,
      publications: undefined,
      taskConfiguration: undefined,
      uiConfiguration: undefined,
      ownedActions: undefined,
    }),
  );
  const generations = captureProjectGenerationPluginConfiguration({
    publications: [publication],
  })!;
  const input = {
    generations,
    publications: [publication.source],
    taskConfiguration: {},
    uiConfiguration: {},
    ownedActions: undefined,
  };
  assert.doesNotThrow(() => assertProjectGenerationExecutionComposition(input));
  assert.throws(
    () =>
      assertProjectGenerationExecutionComposition({
        ...input,
        ownedActions: {},
      }),
    /project_generation_execution_composition_required/u,
  );
  assert.throws(
    () =>
      assertProjectGenerationExecutionComposition({
        ...input,
        uiConfiguration: undefined,
      }),
    /project_generation_execution_composition_required/u,
  );
});
