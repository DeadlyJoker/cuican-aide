import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { AuthorizationPort } from "@crewon/application";
import {
  activatePostgresRuntimeAgentVersionRelease,
  activateStandaloneRuntimeAgentVersionRelease,
} from "./agent-version-release-composition.ts";
import {
  activatePostgresInstalledPluginAgentVersionRelease,
  activateStandaloneInstalledPluginAgentVersionRelease,
} from "./installed-plugin-release-publication-composition.ts";
import { installedPublicationCompositionFixture } from "./installed-plugin-release-publication-composition.test-support.ts";
import { installedReleaseProcessPackagesMissing } from "./installed-plugin-release-process.test-support.ts";
import { installedProcessActor as actor } from "./installed-plugin-worker-process.test-support.ts";
import { compileRuntimeAgentVersion } from "./agent-version-release.ts";
import { developmentAgentRuntimeBindings } from "./development-agent-profiles.ts";
import { mergeInstalledPluginReleasePublicationInput } from "./plugins/installed-plugin-release-publication-input.ts";

type Fixture = Awaited<
  ReturnType<typeof installedPublicationCompositionFixture>
>;
type OwnedInput = Awaited<ReturnType<Fixture["captureInput"]>>;
const options = (backend: "sqlite" | "postgres") => ({
  timeout: 60_000,
  skip:
    installedReleaseProcessPackagesMissing ||
    (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
});
const manifest = (f: Fixture) => ({
  path: f.bindingsPath,
  config: {
    schemaVersion: "crewon.agent-version-runtime-bindings.v0" as const,
    bindings: [f.document.entries[0]!.modelSource.runtimeBinding],
  },
});
function activate(
  f: Fixture,
  input: OwnedInput,
  activationId: string,
  overrides: Readonly<{
    authorization?: AuthorizationPort;
    generatedBindingsManifest?: ReturnType<typeof manifest>;
  }> = {},
) {
  const config = {
    ...f.common,
    activationId,
    additionalAgentVersions: input.release.versions,
    agentVersionDeployments: [
      f.document.entries[0]!.modelSource.deployment,
      ...input.release.deployments,
    ],
    ownedInstalledPluginCliInput: input,
    ...overrides,
  };
  return f.backend === "postgres"
    ? activatePostgresInstalledPluginAgentVersionRelease({
        ...config,
        connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
        schema: f.schema,
        maxPoolSize: 2,
      })
    : activateStandaloneInstalledPluginAgentVersionRelease({
        ...config,
        databasePath: f.databasePath,
      });
}
async function assertRetired(input: OwnedInput) {
  await assert.rejects(
    async () =>
      input.release.factory.create({
        tenantId: actor.tenantId,
        version: input.release.versions[0]!,
      }),
    /release_closed/u,
  );
  const entry = input.release.document.entries[0]!;
  await assert.rejects(
    async () =>
      input.authority.authorizeRead(
        {
          identity: entry.packageIdentity,
          scope: entry.scope,
          purpose: "read",
        },
        new AbortController().signal,
      ),
    /authority_closed/u,
  );
}
async function stages(f: Fixture) {
  return (await readdir(f.directory)).filter((entry) =>
    entry.startsWith(".crewon-installed-bindings-"),
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: the owned CLI composition commits once and retires actual metadata/HTTP owners and its database`,
    options(backend),
    async (t) => {
      const f = await installedPublicationCompositionFixture(t, backend);
      const input = await f.captureInput();
      const result = await activate(f, input, "composition-complete", {
        generatedBindingsManifest: manifest(f),
      });
      assert.equal(result.activation.disposition, "activated");
      assert.equal(result.verification.outcome, "verified");
      assert.equal(result.plan.bundle.releaseId, f.plan.bundle.releaseId);
      await assertRetired(input);
      const store = await f.openStore();
      try {
        assert.equal(
          (await store.loadActiveAgentVersionRelease({
            tenantId: actor.tenantId,
          }))!.bundle.releaseId,
          result.plan.bundle.releaseId,
        );
        assert.equal(
          (await store.loadAgentVersionReleaseActivation({
            tenantId: actor.tenantId,
            activationId: "composition-complete",
          }))!.releaseId,
          result.plan.bundle.releaseId,
        );
        for (const entry of f.document.entries)
          assert.ok(
            await store.loadAgentVersion({
              tenantId: actor.tenantId,
              agentVersionId: entry.modelSource.version.agentVersionId,
            }),
          );
      } finally {
        await store.close();
      }
      assert.deepEqual(await stages(f), []);
      assert.equal(f.modelRequests.length, 0);
    },
  );

  test(
    `${backend}: a preflight refusal closes transferred owners without a staging file or publication`,
    options(backend),
    async (t) => {
      const f = await installedPublicationCompositionFixture(t, backend);
      const before = await readFile(f.bindingsPath);
      const input = await f.captureInput();
      f.denyPackages();
      await assert.rejects(
        activate(f, input, "composition-denied", {
          generatedBindingsManifest: manifest(f),
        }),
        /read_denied/u,
      );
      await assertRetired(input);
      assert.deepEqual(await readFile(f.bindingsPath), before);
      assert.deepEqual(await stages(f), []);
      const store = await f.openStore();
      try {
        assert.equal(
          await store.loadActiveAgentVersionRelease({
            tenantId: actor.tenantId,
          }),
          null,
        );
        assert.equal(
          await store.loadAgentVersion({
            tenantId: actor.tenantId,
            agentVersionId:
              f.document.entries[0]!.modelSource.version.agentVersionId,
          }),
          null,
        );
      } finally {
        await store.close();
      }
    },
  );

  test(
    `${backend}: concurrent user edits after preflight preserve committed activation and the user's file`,
    options(backend),
    async (t) => {
      const f = await installedPublicationCompositionFixture(t, backend);
      const input = await f.captureInput();
      let edited = false;
      const userBytes = JSON.stringify(
        {
          schemaVersion: "crewon.agent-version-runtime-bindings.v0",
          bindings: [],
        },
        null,
        2,
      );
      const authorization: AuthorizationPort = {
        async authorize(request) {
          const decision = await f.common.authorization.authorize(request);
          if (request.action === "agentVersion:deploy" && !edited) {
            edited = true;
            await writeFile(f.bindingsPath, userBytes);
          }
          return decision;
        },
      };
      const result = await activate(f, input, "composition-user-edited", {
        authorization,
        generatedBindingsManifest: manifest(f),
      });
      assert.equal(result.activation.disposition, "activated");
      assert.equal(result.verification.outcome, "unavailable");
      assert.equal(await readFile(f.bindingsPath, "utf8"), userBytes);
      assert.deepEqual(await stages(f), []);
      await assertRetired(input);
      const store = await f.openStore();
      try {
        assert.equal(
          (await store.loadActiveAgentVersionRelease({
            tenantId: actor.tenantId,
          }))!.bundle.releaseId,
          result.plan.bundle.releaseId,
        );
      } finally {
        await store.close();
      }
    },
  );

  test(
    `${backend}: historical A replay after a real B activation cannot replace B's bindings or claim current readiness`,
    options(backend),
    async (t) => {
      const f = await installedPublicationCompositionFixture(t, backend);
      const first = await activate(f, await f.captureInput(), "composition-A", {
        generatedBindingsManifest: manifest(f),
      });
      const ordinary = {
        ...f.common,
        activationId: "composition-B",
        agentVersionDeployments: [
          f.document.entries[0]!.modelSource.deployment,
        ],
      };
      const second =
        backend === "postgres"
          ? await activatePostgresRuntimeAgentVersionRelease({
              ...ordinary,
              connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
              schema: f.schema,
            })
          : await activateStandaloneRuntimeAgentVersionRelease({
              ...ordinary,
              databasePath: f.databasePath,
            });
      assert.notEqual(
        first.plan.bundle.releaseId,
        second.plan.bundle.releaseId,
      );
      const bBytes = JSON.stringify(manifest(f).config, null, 2);
      await writeFile(f.bindingsPath, bBytes);
      for (const generated of [false, true]) {
        const replay = await activate(
          f,
          await f.captureInput(),
          "composition-A",
          generated ? { generatedBindingsManifest: manifest(f) } : {},
        );
        assert.equal(replay.activation.disposition, "replayed");
        assert.equal(
          replay.activation.release.bundle.releaseId,
          first.plan.bundle.releaseId,
        );
        assert.equal(replay.verification.outcome, "unavailable");
        assert.equal(await readFile(f.bindingsPath, "utf8"), bBytes);
        assert.deepEqual(await stages(f), []);
        const store = await f.openStore();
        try {
          assert.equal(
            (await store.loadActiveAgentVersionRelease({
              tenantId: actor.tenantId,
            }))!.bundle.releaseId,
            second.plan.bundle.releaseId,
          );
          assert.equal(
            await store.loadAgentVersionReleaseActivation({
              tenantId: actor.tenantId,
              activationId: "composition-C",
            }),
            null,
          );
        } finally {
          await store.close();
        }
      }
    },
  );
}

test(
  "programmatic generated bindings must describe the exact ordinary final candidates before Store or asset writes",
  options("sqlite"),
  async (t) => {
    const f = await installedPublicationCompositionFixture(t, "sqlite");
    const before = await readFile(f.databasePath),
      bindingsBefore = await readFile(f.bindingsPath);
    const source = f.document.entries[0]!.modelSource.runtimeBinding;
    for (const bindings of [
      [],
      [{ ...source, authorityId: "wrong-source" }],
      [
        {
          ...source,
          agentVersionId: f.document.entries[0]!.version.agentVersionId,
          contentDigest: f.document.entries[0]!.version.contentDigest,
        },
      ],
    ]) {
      const input = await f.captureInput();
      await assert.rejects(
        activate(f, input, "composition-wrong-file", {
          generatedBindingsManifest: {
            path: f.bindingsPath,
            config: {
              schemaVersion: "crewon.agent-version-runtime-bindings.v0",
              bindings,
            },
          },
        }),
        /publication_input_conflict/u,
      );
      assert.deepEqual(await readFile(f.databasePath), before);
      assert.deepEqual(await readFile(f.bindingsPath), bindingsBefore);
      assert.deepEqual(await stages(f), []);
      await assertRetired(input);
    }
  },
);

test(
  "read authority withdrawn during activation preserves the real COMMIT and never publishes a now-unverified manifest",
  options("sqlite"),
  async (t) => {
    const f = await installedPublicationCompositionFixture(t, "sqlite");
    const input = await f.captureInput();
    const before = JSON.stringify(manifest(f).config, null, 2);
    await writeFile(f.bindingsPath, before);
    const authorization: AuthorizationPort = {
      async authorize(request) {
        const decision = await f.common.authorization.authorize(request);
        if (request.action === "agentVersion:deploy") f.denyPackages();
        return decision;
      },
    };
    const result = await activate(f, input, "composition-committed-revoked", {
      authorization,
      generatedBindingsManifest: manifest(f),
    });
    assert.equal(result.activation.disposition, "activated");
    assert.equal(result.verification.outcome, "unavailable");
    assert.equal(await readFile(f.bindingsPath, "utf8"), before);
    assert.deepEqual(await stages(f), []);
    const store = await f.openStore();
    try {
      assert.equal(
        (await store.loadActiveAgentVersionRelease({
          tenantId: actor.tenantId,
        }))!.bundle.releaseId,
        result.plan.bundle.releaseId,
      );
    } finally {
      await store.close();
    }
    await assertRetired(input);
  },
);

test(
  "generated inputs add the document's actual source binding while explicit input never invents a missing source",
  options("sqlite"),
  async (t) => {
    const f = await installedPublicationCompositionFixture(t, "sqlite");
    const input = await f.captureInput();
    const version = compileRuntimeAgentVersion(f.common);
    const generatedBindings = developmentAgentRuntimeBindings({
      versions: [version],
      profiles: [undefined],
      tenantId: actor.tenantId,
      authorityId: f.common.route.authorityId,
      workspaceBindingId: null,
      endpoint: f.endpoint,
      requestProfile: "standard",
      sequencePolicy: "required",
      idleTimeoutMs: 5000,
      directApiKeyEnvironment: null,
      toolRuntimeMode: "shared",
    });
    const generated = mergeInstalledPluginReleasePublicationInput({
      release: input.release,
      existingVersions: [],
      existingDeployments: [],
      generatedBindings,
    });
    assert.equal(generated.generatedBindings!.bindings.length, 2);
    assert.deepEqual(
      generated.generatedBindings!.bindings[1],
      f.document.entries[0]!.modelSource.runtimeBinding,
    );
    assert.deepEqual(generated.agentVersionDeployments, [
      f.document.entries[0]!.modelSource.deployment,
      ...input.release.deployments,
    ]);
    assert.throws(
      () =>
        mergeInstalledPluginReleasePublicationInput({
          release: input.release,
          existingVersions: [],
          existingDeployments: [],
        }),
      /publication_input_conflict/u,
    );
    const conflict = structuredClone(generatedBindings);
    Reflect.set(conflict, "bindings", [
      ...conflict.bindings,
      {
        ...f.document.entries[0]!.modelSource.runtimeBinding,
        authorityId: "another-source-authority",
      },
    ]);
    assert.throws(
      () =>
        mergeInstalledPluginReleasePublicationInput({
          release: input.release,
          existingVersions: [],
          existingDeployments: [],
          generatedBindings: conflict,
        }),
      /publication_input_conflict/u,
    );
    assert.equal(f.modelRequests.length, 0);
  },
);
