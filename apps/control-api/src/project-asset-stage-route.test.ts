import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  ApplicationError,
  CreativeProjectApplicationService,
  ProjectConversationApplicationService,
  ProjectAssetStageApplicationService,
  ThreadApplicationService,
  type CreativeProjectAuthorizationPort,
  type ProjectConversationCommitAuthority,
} from "@crewon/application";
import { projectAssetScriptSourcePath } from "@crewon/contracts/project-asset-stages";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import {
  businessExecutionFixture,
  digester,
} from "../../runtime-worker/src/installed-plugin-business-execution.integration.test-support.ts";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { errorResponse } from "./control-api-errors.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { registerProjectAssetStageRoutes } from "./project-asset-stage-route.ts";
import { ProjectAssetStageControlOwner } from "./project-asset-stage-control-owner.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { InstalledPluginConfigurationMetadata } from "./installed-plugin-configuration-metadata.ts";

const origin = "crewon://desktop",
  token = "asset-stage-route-session-32-byte-minimum",
  csrf = "asset-stage-route-csrf-32-byte-minimum";
const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_ASSET_PLUGIN_DIR;
function http() {
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const r = errorResponse(error, request.id);
    return reply.code(r.statusCode).send(r.body);
  });
  return app;
}
const headers = (key = "asset-stage-original") => ({
  "authorization": `Bearer ${token}`,
  origin,
  "x-csrf-token": csrf,
  "idempotency-key": key,
});
const stage = {
  kind: "assets" as const,
  assetKind: "character" as const,
  briefRevision: 1,
  script: null,
};

test("asset stage unavailable opt-in still authenticates actual Thread access, accepts no execution and strictly validates requests", async (t) => {
  const f = await conversationFixture(t, "sqlite"),
    p = await f.prepare();
  await f.store.commitBinding(p, { authority: f.authority });
  const app = http(),
    identity = new StandaloneIdentity({
      actor: f.actor,
      sessionToken: token,
      csrfToken: csrf,
      allowedOrigins: [origin],
    });
  let wakes = 0;
  registerProjectAssetStageRoutes(app, {
    identity,
    owner: null,
    threads: f.threads,
    outboxWakeup: {
      wake: async () => {
        wakes++;
      },
    },
  });
  t.after(() => app.close());
  const url = `/api/v1/threads/${p.binding.threadId}/project-asset-stage`,
    valid = {
      projectId: f.reference.projectId,
      threadId: p.binding.threadId,
      expectedThreadRevision: 1,
      expectedBindingRevision: 1,
      stage,
      content: "创作一个角色候选",
      idempotencyKey: "asset-stage-original",
    };
  const before = await f.rows(`SELECT run_id FROM ${f.prefix}run_snapshots`);
  const get = await app.inject({ method: "GET", url, headers: headers() });
  assert.equal(get.statusCode, 200, get.body);
  assert.deepEqual(get.json(), { available: false });
  assert.equal(
    (await app.inject({ method: "HEAD", url, headers: headers() })).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url,
        headers: { ...headers(), authorization: "Bearer wrong" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/threads/absent/project-asset-stage",
        headers: headers(),
      })
    ).statusCode,
    404,
  );
  const post = await app.inject({
    method: "POST",
    url,
    headers: headers(),
    payload: valid,
  });
  assert.equal(post.statusCode, 409, post.body);
  assert.equal(post.json().error.code, "project_asset_stage_unavailable");
  for (const method of ["GET", "POST"] as const) {
    assert.equal(
      (
        await app.inject({
          method,
          url: url + "?unknown=x",
          headers: headers(),
          ...(method === "POST" ? { payload: valid } : {}),
        })
      ).statusCode,
      400,
    );
  }
  for (const payload of [
    { ...valid, threadId: "other" },
    { ...valid, idempotencyKey: "different" },
    { ...valid, actorId: "claimed" },
    { ...valid, stage: { ...stage, kind: "discussion" } },
    { ...valid, expectedThreadRevision: 0 },
    [],
    { ...valid, content: "" },
  ]) {
    const r = await app.inject({
      method: "POST",
      url,
      headers: headers(),
      payload,
    });
    assert.equal(r.statusCode, 400, r.body);
  }
  for (const [h, status] of [
    [{ ...headers(), "idempotency-key": "" }, 400],
    [{ ...headers(), authorization: "Bearer wrong" }, 401],
    [{ ...headers(), origin: "https://foreign.invalid" }, 403],
    [{ ...headers(), "x-csrf-token": "wrong" }, 403],
  ] as const) {
    const r = await app.inject({
      method: "POST",
      url,
      headers: h,
      payload: valid,
    });
    assert.equal(r.statusCode, status, r.body);
  }
  assert.deepEqual(
    await f.rows(`SELECT run_id FROM ${f.prefix}run_snapshots`),
    before,
  );
  assert.equal(wakes, 0);
  const unregistered = http();
  t.after(() => unregistered.close());
  assert.throws(
    () =>
      registerProjectAssetStageRoutes(unregistered, {
        identity,
        threads: f.threads,
        outboxWakeup: { wake: async () => {} },
        owner: {} as ProjectAssetStageControlOwner,
      }),
    /project_asset_stage_owner_required/,
  );
});

async function installedFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  // Named HTTP identity/peer ports use real installed bytes, Node declarations, activation and TaskCore.
  // This is a Control integration fixture; it does not claim the separate Native Main signing path.
  const f = await businessExecutionFixture(t, backend, {
    packageDirectory: packageDirectory!,
    configurationParameters: {
      baseUrl: "https://no-provider-request.example/",
      preset: "krea2-portrait",
    },
    taskAction: { contributionId: "workbench", action: "project.execute" },
    projectAssetStageQuotes: true,
    taskClock: { now: () => new Date().toISOString() },
    installedQueryHost: true,
  });
  const actor = f.actor,
    scope = f.scope,
    metadata = f.store.creativeProjectStore(),
    texts = f.store.projectTextStore(),
    conversations = f.store.projectConversationStore(),
    stages = f.store.projectAssetStageStore();
  await metadata.migrate();
  await texts.migrate();
  await f.store.projectAssetStore().migrate();
  await conversations.migrate();
  await stages.migrate();
  const state = {
    projectDenied: false,
    uiDenied: false,
    packageDenied: false,
    identityChanged: false,
    wakes: 0,
    peerPrepares: 0,
    executionReady: true,
  };
  const authorization: CreativeProjectAuthorizationPort = {
    authorize: async (input) => {
      assert.deepEqual(input.actor, actor);
      return state.projectDenied
        ? { outcome: "deny", reasonCode: "named_asset_route_project_denied" }
        : { outcome: "allow" };
    },
  };
  const base = {
    authorization,
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester,
  };
  const projects = new CreativeProjectApplicationService({
    ...base,
    store: metadata,
  });
  const created = await projects.createProject(actor, {
    title: "夜航",
    briefText: "摄影师在雨夜收到父亲的来信",
    idempotencyKey: "route-project-create",
  });
  const selection = await f.installations.loadSelection({
    scope,
    pluginId: f.entry.registration.identity.pluginId,
  });
  assert.ok(selection);
  const pkg = await f.installations.loadPackage({
    scope,
    packageDigest: selection.selectedPackageDigest!,
  });
  assert.ok(pkg);
  const pin = parsePluginTaskAdmissionPin({
    ...actor,
    ...scope,
    ...f.entry.registration.identity,
    selectionRevision: selection.revision,
    contributionId: "workbench",
    action: "project.execute",
    authorityEpoch: "asset-route-authority-epoch",
  });
  const installation = {
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    profileId: pin.profileId,
    pluginId: pin.pluginId,
    publisherId: pin.publisherId,
    version: pin.version,
    packageDigest: pin.packageDigest,
    selectionRevision: pin.selectionRevision,
  };
  const q: ProjectConversationCommitAuthority = {
    version: "crewon.project-conversation-commit.v1",
    actor,
    installation,
    pin,
    selection,
    package: pkg,
    assertActive: () => {},
    assertCurrent: async () => {
      assert.deepEqual(
        await f.installations.loadSelection({ scope, pluginId: pin.pluginId }),
        selection,
      );
    },
    assertTransactionCurrent: async () => {},
  };
  const threads = new ThreadApplicationService({
    ...base,
    store: f.store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    workspaceAdmission: { admit: async () => {} },
  });
  const conversationApp = new ProjectConversationApplicationService({
    ...base,
    conversations,
    threads,
    threadStore: f.store,
    projects: metadata,
    texts,
    tasks: f.tasks,
  });
  const bound = await conversationApp.createConversation(
    actor,
    {
      projectId: created.project.projectId,
      workspaceId: "asset-route-workspace",
      title: "角色创作",
      idempotencyKey: "route-conversation-create",
    },
    q,
  );
  const identity = new StandaloneIdentity({
    actor,
    sessionToken: token,
    csrfToken: csrf,
    allowedOrigins: [origin],
  });
  const configurationMetadata = new InstalledPluginConfigurationMetadata({
    installRoot: f.pkg.input.installRoot,
    installations: f.installations,
    maximumPackages: 8,
    authorizeRead: async () => "allow",
  });
  const catalog = {
    list: () => [f.entry.registration],
    resolve: (input: { pluginId: string; pluginVersion: string }) =>
      input.pluginId === pin.pluginId && input.pluginVersion === pin.version
        ? f.entry.registration
        : null,
  };
  assert.ok(f.queryHost);
  const requests = new InstalledPluginRequestOwner({
    identity: {
      resolveCurrentActor: async (context, signal) => {
        signal.throwIfAborted();
        if (state.identityChanged)
          throw new ApplicationError(
            "authorization",
            "named_identity_withdrawn",
          );
        return identity.resolveActor(context);
      },
    },
    profiles: { resolve: async () => scope },
    metadata: configurationMetadata,
    peer: {
      prepare: async (input, options) => {
        options?.signal?.throwIfAborted();
        assert.deepEqual(input.actor, actor);
        assert.deepEqual(input.scope, scope);
        state.peerPrepares++;
        return { catalog, host: f.host!, pluginQueryHost: f.queryHost! };
      },
    },
  });
  const service = new ProjectAssetStageApplicationService({
    conversations,
    stages,
    threadStore: f.store,
    projects: metadata,
    texts,
    tasks: f.tasks,
    authorization,
    digester,
  });
  const owner = new ProjectAssetStageControlOwner({
    executionAvailable: () =>
      state.executionReady && f.tasks !== undefined && f.host !== undefined,
    service,
    conversations,
    configuration: {
      version: "crewon.project-asset-stages.v1",
      publications: [
        {
          pluginId: pin.pluginId,
          packageDigest: pin.packageDigest,
          contributionId: "workbench",
        },
      ],
    },
    installations: f.installations,
    requests,
    installRoot: f.pkg.input.installRoot,
    authorization: {
      authorize: async () =>
        state.uiDenied
          ? { outcome: "deny", reasonCode: "named_ui_withdrawn" }
          : { outcome: "allow", authorityEpoch: pin.authorityEpoch },
    },
    authorizePackage: async () => (state.packageDenied ? "deny" : "allow"),
    assertExternal: () => {
      if (state.identityChanged)
        throw new ApplicationError("authorization", "named_identity_withdrawn");
    },
  });
  const app = http();
  registerProjectAssetStageRoutes(app, {
    identity,
    owner,
    threads,
    outboxWakeup: {
      wake: async () => {
        state.wakes++;
        throw Error("named_wakeup_transport_failure");
      },
    },
  });
  t.after(async () => {
    await app.close();
    await owner.close();
    await requests.close();
    await configurationMetadata.close();
  });
  const request = {
    projectId: created.project.projectId,
    threadId: bound.binding.threadId,
    expectedThreadRevision: 1,
    expectedBindingRevision: 1,
    stage,
    content: "创作一个角色档案候选，保留人工采用。",
    idempotencyKey: "asset-stage-original",
  };
  const url = `/api/v1/threads/${request.threadId}/project-asset-stage`;
  return { ...f, state, app, request, url, stages, owner };
}

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: installed asset stage HTTP checks genuine owner/Node action, commits one original Run, replays, and wakes only accepted requests`,
    {
      timeout: 60000,
      skip:
        !packageDirectory ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
    },
    async (t) => {
      const f = await installedFixture(t, backend),
        get = () =>
          f.app.inject({ method: "GET", url: f.url, headers: headers() }),
        post = () =>
          f.app.inject({
            method: "POST",
            url: f.url,
            headers: headers(),
            payload: f.request,
          });
      const available = await get();
      assert.equal(available.statusCode, 200, available.body);
      assert.deepEqual(available.json(), { available: true });
      const sourceUrl = projectAssetScriptSourcePath({
        projectId: f.request.projectId,
        threadId: f.request.threadId,
        expectedBindingRevision: 1,
        briefRevision: 1,
        episodeId: "ep-1",
      });
      const source = await f.app.inject({
        method: "GET",
        url: sourceUrl,
        headers: headers(),
      });
      assert.equal(source.statusCode, 200, source.body);
      assert.deepEqual(source.json(), {
        projectId: f.request.projectId,
        threadId: f.request.threadId,
        bindingRevision: 1,
        briefRevision: 1,
        episodeId: "ep-1",
        script: null,
      });
      for (const bad of [
        sourceUrl + "&actorId=forged",
        sourceUrl + "&episodeId=foreign",
        sourceUrl.replace("briefRevision=1", "briefRevision=01"),
      ])
        assert.equal(
          (await f.app.inject({ method: "GET", url: bad, headers: headers() }))
            .statusCode,
          400,
        );
      assert.equal(
        (
          await f.app.inject({
            method: "GET",
            url: sourceUrl,
            headers: { ...headers(), authorization: "Bearer foreign" },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await f.app.inject({
            method: "HEAD",
            url: sourceUrl,
            headers: headers(),
          })
        ).statusCode,
        404,
      );
      f.state.executionReady = false;
      const notReady = await get();
      assert.equal(notReady.statusCode, 200, notReady.body);
      assert.deepEqual(notReady.json(), { available: false });
      const stillReadable = await f.app.inject({
        method: "GET",
        url: sourceUrl,
        headers: headers(),
      });
      assert.equal(stillReadable.statusCode, 200, stillReadable.body);
      f.state.executionReady = true;
      assert.equal(f.state.peerPrepares, 0);
      assert.equal(await f.count("run_snapshots"), 0);
      f.state.projectDenied = true;
      const deniedAvailability = await get();
      assert.equal(deniedAvailability.statusCode, 403, deniedAvailability.body);
      assert.equal((await post()).statusCode, 403);
      assert.equal(await f.count("run_snapshots"), 0);
      assert.equal(f.state.wakes, 0);
      f.state.projectDenied = false;
      f.state.uiDenied = true;
      assert.equal((await post()).statusCode, 403);
      f.state.uiDenied = false;
      f.state.packageDenied = true;
      assert.equal((await post()).statusCode, 403);
      f.state.packageDenied = false;
      f.state.identityChanged = true;
      assert.equal((await post()).statusCode, 403);
      f.state.identityChanged = false;
      const first = await post();
      assert.equal(first.statusCode, 201, first.body);
      assert.equal(first.json().disposition, "committed");
      assert.ok(
        f.state.peerPrepares > 0,
        "only the actual execution request prepares the real installed Task peer",
      );
      assert.equal(first.json().threadRevision, 2);
      assert.equal(f.state.wakes, 1);
      const admission = await f.stages.loadAssetStageAdmission({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: first.json().runId,
      });
      assert.ok(admission);
      assert.equal(admission.contentDigest, first.json().stageAdmissionDigest);
      assert.equal(admission.workspaceId, "asset-route-workspace");
      assert.equal(admission.projectId, f.request.projectId);
      assert.equal(await f.count("run_snapshots"), 1);
      const binding = await f.extensions.loadExtensionRunBinding({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: first.json().runId,
      });
      assert.ok(binding);
      assert.equal(
        (
          await f.store.externalOperationStore().listExternalOperations({
            tenantId: binding.tenantId,
            runId: binding.runId,
            bindingDigest: binding.bindingDigest,
            limit: 16,
          })
        ).operations.length,
        0,
      );
      const replay = await post();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().disposition, "replayed");
      assert.equal(replay.json().runId, first.json().runId);
      assert.equal(f.state.wakes, 2);
      assert.equal(await f.count("run_snapshots"), 1);
      const conflict = await f.app.inject({
        method: "POST",
        url: f.url,
        headers: headers(),
        payload: { ...f.request, content: "另一个正文" },
      });
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.equal(f.state.wakes, 2);
      await f.owner.close();
      assert.equal((await post()).statusCode, 409);
      assert.equal(f.state.wakes, 2);
      assert.equal(await f.count("run_snapshots"), 1);
    },
  );
