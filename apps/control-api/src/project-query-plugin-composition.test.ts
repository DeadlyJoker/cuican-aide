import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { PostgresDomainStore } from "@crewon/store";
import {
  captureCreativeProjectCompositionConfig,
  captureStandaloneCreativeProjectCompositionConfig,
  prepareCreativeProjects,
} from "./creative-project-composition.ts";
import {
  assertProjectQueryExecutionComposition,
  captureProjectQueryPluginConfiguration,
} from "./project-query-plugin-configuration.ts";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { pluginUiProductionIdentity } from "./production-plugin-ui.test-support.ts";
import { captureProductionPluginUiOwnerConfiguration } from "./project-query-plugin-composition.ts";

const publication = {
  source: {
    pluginId: "fixture.query-business",
    packageDigest: `sha256:${"a".repeat(64)}`,
    contributionId: "workbench",
  },
  target: {
    pluginId: "fixture.query-execution",
    packageDigest: `sha256:${"b".repeat(64)}`,
    contributionId: "workbench",
    action: "image.query",
  },
};
const allowed = { authorize: async () => ({ outcome: "allow" as const }) };
const reader = { version: "crewon.project-generation-read.v1" as const };

test("query configuration defaults off and does not inspect a project adapter or a generation reader", async () => {
  assert.equal(captureProjectQueryPluginConfiguration(undefined), undefined);
  let touched = 0;
  assert.equal(
    await prepareCreativeProjects(
      {
        creativeProjectStore() {
          touched++;
          throw new Error("no-project-store");
        },
        extensionStore() {
          touched++;
          throw new Error("no-extension-store");
        },
      },
      undefined,
    ),
    undefined,
  );
  assert.equal(touched, 0);
  const generationOnly = captureCreativeProjectCompositionConfig({
    authorization: allowed,
    pluginGenerations: {
      publications: [
        {
          ...publication,
          target: { ...publication.target, action: "image.generate" },
        },
      ],
    },
  });
  assert.equal(generationOnly?.pluginQueries, undefined);
  assert.doesNotThrow(() =>
    assertProjectQueryExecutionComposition({
      queries: undefined,
      publications: undefined,
      taskConfiguration: undefined,
      uiConfiguration: undefined,
      ownedActions: undefined,
    }),
  );
});

test("explicit query captures immutable source/target mapping and requires an actual read opt-in", () => {
  assert.throws(
    () =>
      captureCreativeProjectCompositionConfig({
        authorization: allowed,
        pluginQueries: { publications: [publication] },
      }),
    /project_query_generation_reader_required/u,
  );
  const mutable = structuredClone(publication);
  const captured = captureCreativeProjectCompositionConfig({
    authorization: allowed,
    generationReads: reader,
    pluginQueries: { publications: [mutable] },
  });
  mutable.source.pluginId = "replaced";
  mutable.target.action = "image.generate";
  assert.deepEqual(captured?.pluginQueries?.publications, [publication]);
  assert.ok(Object.isFrozen(captured?.pluginQueries?.publications[0]?.target));
  let getters = 0;
  assert.throws(
    () =>
      captureCreativeProjectCompositionConfig({
        authorization: allowed,
        generationReads: reader,
        get pluginQueries() {
          getters++;
          return { publications: [publication] };
        },
      }),
    /creative_project_configuration_invalid/u,
  );
  assert.throws(
    () =>
      captureProjectQueryPluginConfiguration({
        get publications() {
          getters++;
          return [publication];
        },
      }),
    /plugin_security_fields_invalid/u,
  );
  assert.equal(getters, 0);
});

test("standalone cannot acquire a production query owner from a read configuration", () => {
  assert.throws(
    () =>
      captureStandaloneCreativeProjectCompositionConfig({
        authorization: allowed,
        generationReads: reader,
        pluginQueries: { publications: [publication] },
      }),
    /standalone_project_query_execution_authority_required/u,
  );
});

test("query requires approved source publication and actual original task composition before PostgreSQL opens", async (t) => {
  const authentication = pluginUiProductionIdentity();
  let opened = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    opened++;
    throw new Error("must-not-open");
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
    identity: authentication.identity,
    authorization: allowed,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    creativeProjects: {
      authorization: allowed,
      generationReads: reader,
      pluginQueries: { publications: [publication] },
    },
  };
  await assert.rejects(
    createProductionPostgresControlApi(base),
    /project_query_source_publication_unapproved/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      pluginUi: { configuration },
    }),
    /project_query_execution_composition_required/u,
  );
  assert.equal(opened, 0);
  assert.equal(authentication.reads(), 0);
});

test("owner capture retains original fallback and receipt receivers without manufacturing a query dispatcher", async () => {
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
    publications: [],
    timeoutMs: 1000,
  });
  const actions = {
    calls: 0,
    async invoke() {
      assert.equal(this, actions);
      this.calls++;
      return null;
    },
  };
  const captured = captureProductionPluginUiOwnerConfiguration({
    configuration,
    actions,
  });
  actions.invoke = async () => {
    throw new Error("replacement");
  };
  assert.equal(captured.ownedProjectQueryActions, undefined);
  await captured.actions!.invoke({} as never);
  assert.equal(actions.calls, 1);
});
