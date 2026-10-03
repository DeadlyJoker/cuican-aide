import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createStandaloneControlApiWithCreativeProjects } from "./standalone-composition.ts";
import {
  captureCreativeProjectCompositionConfig,
  captureStandaloneCreativeProjectCompositionConfig,
  prepareCreativeProjects,
} from "./creative-project-composition.ts";
import {
  captureProjectGenerationReadConfiguration,
  composeProjectGenerationReadService,
} from "./project-generation-read-composition.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { generationReadHttpFixture } from "./project-generation-read-route.test-support.ts";

const readConfiguration = Object.freeze({
  version: "crewon.project-generation-read.v1" as const,
});
const authorization = {
  authorize: async () => ({ outcome: "allow" as const }),
};

test("read capability captures only its exact version and rejects accessors without evaluating them", () => {
  assert.equal(captureProjectGenerationReadConfiguration(undefined), undefined);
  assert.deepEqual(
    captureProjectGenerationReadConfiguration(readConfiguration),
    readConfiguration,
  );
  let invoked = 0;
  for (const value of [
    null,
    [],
    {},
    { version: "future" },
    { ...readConfiguration, paid: true },
    Object.defineProperty({}, "version", {
      enumerable: true,
      get: () => {
        invoked++;
        return readConfiguration.version;
      },
    }),
  ])
    assert.throws(
      () => captureProjectGenerationReadConfiguration(value),
      /project_generation_read_configuration_invalid/u,
    );
  assert.equal(invoked, 0);
  const mutable = { ...readConfiguration };
  const captured = captureStandaloneCreativeProjectCompositionConfig({
    authorization,
    generationReads: mutable,
  })!;
  mutable.version = "changed" as typeof mutable.version;
  assert.equal(captured.generationReads!.version, readConfiguration.version);
  assert.ok(Object.isFrozen(captured.generationReads));
  assert.throws(() =>
    captureCreativeProjectCompositionConfig({
      authorization,
      generationReads: Object.defineProperty({}, "version", {
        get: () => {
          invoked++;
          return readConfiguration.version;
        },
        enumerable: true,
      }),
    }),
  );
  assert.equal(invoked, 0);
});

test("default project composition and absent read assembly do not inspect the generation adapter", async () => {
  let touches = 0;
  const owner = {
    creativeProjectStore: () => {
      touches++;
      throw new Error("unexpected_metadata_store");
    },
    extensionStore: () => {
      touches++;
      throw new Error("unexpected_generation_store");
    },
  };
  assert.equal(await prepareCreativeProjects(owner, undefined), undefined);
  assert.equal(
    composeProjectGenerationReadService({
      projects: undefined,
      extensions: undefined,
      tasks: undefined,
      digester: extensionStoreDigester,
    }),
    undefined,
  );
  assert.equal(touches, 0);
});

test("explicit standalone cold reads require existing history and create no plugin, credit, or generation tables", async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-generation-read-cold-"),
  );
  const databasePath = join(directory, "control.sqlite");
  const store = new SqliteRunStore(databasePath);
  context.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const tables = () => {
    const inspector = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return inspector
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
    } finally {
      inspector.close();
    }
  };
  const before = tables();
  await assert.rejects(
    prepareCreativeProjects(store, {
      authorization,
      generationReads: readConfiguration,
    }),
  );
  assert.deepEqual(tables(), before);
  assert.equal(store.extensionStore().projectGenerationReadVersion, undefined);
  assert.equal(store.extensionStore().projectGenerationVersion, undefined);
});

test("the original standalone metadata assembly keeps generation HTTP absent and its schema untouched by default", async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-generation-read-off-"),
  );
  const databasePath = join(directory, "control.sqlite");
  const origin = "https://generation-read-default.example.test";
  const sessionToken = "generation-read-default-session-at-least-32";
  const runtime = await createStandaloneControlApiWithCreativeProjects({
    databasePath,
    actor: {
      tenantId: "tenant",
      spaceId: "space",
      principalId: "owner",
      actorId: "actor",
    },
    defaultAgentVersionId: "no-model",
    sessionToken,
    csrfToken: "generation-read-default-csrf-at-least-32",
    allowedOrigins: [origin],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    creativeProjects: { authorization },
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    outboxRetention: null,
    artifactRetention: null,
    automationScanIntervalMs: null,
  });
  context.after(async () => {
    await runtime.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${sessionToken}`, origin };
  assert.equal(
    (await runtime.app.inject({ url: "/api/v1/creative-projects", headers }))
      .statusCode,
    200,
  );
  const response = await runtime.app.inject({
    url: "/api/v1/creative-projects/p/concepts/a/revisions/1/generation",
    headers,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "route_not_found");
  const inspector = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      inspector
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'project_generation_%' OR name LIKE 'plugin_credit_%')",
        )
        .all(),
      [],
    );
  } finally {
    inspector.close();
  }
});

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend} historical read composition uses real project and task services without granting writer capabilities`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (context) => {
      const f = await generationReadHttpFixture(context, backend);
      await f.commitGeneration();
      const before = await f.counts();
      const prepared = await prepareCreativeProjects(f.first.parent, {
        authorization,
        generationReads: readConfiguration,
      });
      assert.ok(prepared?.generationReadStore);
      assert.equal(
        prepared.generationReadStore.projectGenerationReadVersion,
        readConfiguration.version,
      );
      assert.equal(
        prepared.generationReadStore.projectGenerationVersion,
        undefined,
      );
      assert.equal(
        prepared.generationReadStore.projectGenerationPublicationVersion,
        undefined,
      );
      const service = composeProjectGenerationReadService({
        projects: prepared,
        extensions: prepared.generationReadStore,
        tasks: f.reads,
        digester: extensionStoreDigester,
      });
      assert.ok(service);
      assert.ok(
        await service.getConceptGeneration(f.actor, {
          projectId: f.reference.projectId,
          assetId: f.reference.assetId,
          assetRevision: 1,
        }),
      );
      assert.deepEqual(await f.counts(), before);
      assert.throws(
        () =>
          composeProjectGenerationReadService({
            projects: prepared,
            extensions: prepared.generationReadStore,
            tasks: undefined,
            digester: extensionStoreDigester,
          }),
        /project_generation_read_composition_required/u,
      );
    },
  );
