import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  ProjectAssetApplicationService,
  type CreativeProjectAuthorizationAction,
} from "@crewon/application";
import {
  conceptSelectionFixture,
  selectionVerifier,
} from "../../../packages/store/src/project-concept-selection.test-support.ts";
import {
  assetContent,
  assetTestOptions,
} from "../../../packages/store/src/project-asset.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import { errorResponse } from "./control-api-errors.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { registerProjectAssetRoutes } from "./project-asset-route.ts";

const origin = "crewon://desktop";
const csrf = "asset-route-csrf-32-byte-minimum";
const tokens = [0, 1, 2, 3].map(
  (n) => `asset-route-session-${n}-32-byte-minimum`,
);
const body = {
  kind: "character",
  expectedAssetRevision: 0,
  briefRevision: 1,
  script: null,
  content: assetContent,
};

async function setup(t: TestContext, backend: "sqlite" | "postgres") {
  // The image history is a genuine succeeded Store fixture. The route never runs a model or provider.
  const f = await conceptSelectionFixture(t, backend);
  await f.first.parent.projectTextStore().migrate();
  const store = f.first.parent.projectAssetStore({
    verifier: selectionVerifier,
  });
  await store.migrate();
  const policy: { denied: CreativeProjectAuthorizationAction | null } = {
    denied: null,
  };
  const actors = [
    f.actor,
    { ...f.actor, principalId: "other-principal", actorId: "other-actor" },
    { ...f.actor, spaceId: "other-space" },
    { ...f.actor, tenantId: "other-tenant" },
  ];
  const identities = actors.map(
    (actor, index) =>
      new StandaloneIdentity({
        actor,
        sessionToken: tokens[index]!,
        csrfToken: csrf,
        allowedOrigins: [origin],
      }),
  );
  const assets = new ProjectAssetApplicationService({
    store,
    projects: f.first.parent.creativeProjectStore(),
    texts: f.first.parent.projectTextStore(),
    authorization: {
      authorize: async (req) =>
        policy.denied === req.action
          ? { outcome: "deny", reasonCode: "asset-route-policy-denied" }
          : { outcome: "allow" },
    },
    clock: { now: () => timestamp },
    ids: { nextId: () => randomUUID() },
    digester: extensionStoreDigester,
  });
  const app = Fastify({ bodyLimit: 64 * 1024 });
  app.setErrorHandler((error, request, reply) => {
    const r = errorResponse(error, request.id);
    return reply.code(r.statusCode).send(r.body);
  });
  registerProjectAssetRoutes(app, {
    assets,
    identity: {
      resolveActor(context) {
        const index = tokens.findIndex(
          (token) => context.headers.authorization === `Bearer ${token}`,
        );
        if (index < 0)
          throw new ControlApiIdentityError(
            "authentication",
            "session_invalid",
          );
        return identities[index]!.resolveActor(context);
      },
    },
  });
  t.after(() => app.close());
  const headers = (key = "asset-route-key", account = 0) => ({
    "authorization": `Bearer ${tokens[account]}`,
    origin,
    "x-csrf-token": csrf,
    "idempotency-key": key,
  });
  const root = `/api/v1/creative-projects/${encodeURIComponent(f.reference.projectId)}/assets`;
  const request = (
    method: "GET" | "POST" | "PUT" | "HEAD",
    suffix: string,
    payload?: unknown,
    key = "asset-route-key",
    account = 0,
  ) =>
    app.inject({
      method,
      url: root + suffix,
      headers: {
        ...headers(key, account),
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const execution = async () => ({
    runs: await f.count("run_snapshots"),
    operations: await f.count("extension_external_operations"),
    workItems: await f.count("work_items"),
    outbox: await f.count("outbox"),
    funds: await f.count("plugin_credit_reservations"),
  });
  return {
    ...f,
    assets,
    store,
    app,
    policy,
    headers,
    root,
    request,
    execution,
  };
}

test("asset routes are absent without explicit registration and reject a structural service", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/creative-projects/project/assets",
      })
    ).statusCode,
    404,
  );
  assert.throws(
    () =>
      registerProjectAssetRoutes(app, {
        identity: {
          resolveActor: () => {
            throw Error("must-not-authenticate");
          },
        },
        assets: {} as ProjectAssetApplicationService,
      }),
    /project_asset_service_required/,
  );
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: asset HTTP dispatches all five metadata commands and six reads with durable exact replay, no extra execution`,
    assetTestOptions(backend),
    async (t) => {
      const f = await setup(t, backend),
        before = await f.execution();
      const selectedImage = await f.selectionStore.commitConceptImageSelection(
        f.selectionInput,
        f.selectionCommitOptions,
      );
      assert.deepEqual((await f.request("GET", "")).json(), {
        assets: [],
        nextAssetId: null,
      });
      const saved = await f.request(
        "POST",
        "/candidates",
        body,
        "original-create",
      );
      assert.equal(saved.statusCode, 200, saved.body);
      const first = saved.json(),
        id = first.asset.assetId,
        item = `/items/${encodeURIComponent(id)}`;
      assert.equal(first.kind, "save-content");
      assert.equal(first.disposition, "committed");
      assert.equal(first.asset.selectedContentRevision, null);
      assert.deepEqual(first.contentRevision.content, assetContent);
      assert.equal(Object.hasOwn(first.asset, "ownerPrincipalId"), false);
      const replay = await f.request(
        "POST",
        "/candidates",
        body,
        "original-create",
      );
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().disposition, "replayed");
      assert.deepEqual(replay.json().asset, first.asset);
      const selected = await f.request(
        "PUT",
        `${item}/selection`,
        { expectedAssetRevision: 1, contentRevision: 1 },
        "select-content",
      );
      assert.equal(selected.statusCode, 200, selected.body);
      assert.equal(selected.json().kind, "select-content");
      const refBody = {
        expectedAssetRevision: 2,
        assetContentRevision: 1,
        conceptAssetId: f.reference.assetId,
        selectionRevision: selectedImage.pointer.selectionRevision,
      };
      const reference = await f.request(
        "POST",
        `${item}/reference-candidates`,
        refBody,
        "reference-original",
      );
      assert.equal(reference.statusCode, 200, reference.body);
      assert.equal(reference.json().kind, "save-reference");
      assert.equal(
        reference.json().referenceRevision.source.sourceRunId,
        f.link.binding.runId,
      );
      const refSelect = await f.request(
        "PUT",
        `${item}/reference-selection`,
        { expectedAssetRevision: 3, referenceRevision: 1 },
        "reference-select",
      );
      assert.equal(refSelect.statusCode, 200, refSelect.body);
      assert.equal(refSelect.json().kind, "select-reference");
      const lock = await f.request(
        "PUT",
        `${item}/lock`,
        { expectedAssetRevision: 4, locked: true },
        "lock",
      );
      assert.equal(lock.statusCode, 200, lock.body);
      assert.equal(lock.json().kind, "set-lock");
      const later = await f.request(
        "POST",
        `${item}/candidates`,
        {
          ...body,
          expectedAssetRevision: 5,
          content: { ...assetContent, name: "新候选" },
        },
        "late-candidate",
      );
      assert.equal(later.statusCode, 200, later.body);
      assert.equal(later.json().asset.selectedContentRevision, 1);
      assert.equal(later.json().asset.selectedReferenceRevision, 1);
      assert.equal(later.json().asset.locked, true);
      assert.equal(
        (
          await f.request(
            "PUT",
            `${item}/selection`,
            { expectedAssetRevision: 6, contentRevision: 2 },
            "locked-select",
          )
        ).statusCode,
        409,
      );
      const view = await f.request("GET", item);
      assert.equal(view.statusCode, 200, view.body);
      assert.equal(view.json().view.selectedContentRevision.contentRevision, 1);
      const exact = await f.request("GET", `${item}/revisions/1`);
      assert.deepEqual(exact.json().contentRevision, first.contentRevision);
      const exactRef = await f.request("GET", `${item}/references/1`);
      assert.deepEqual(
        exactRef.json().referenceRevision,
        reference.json().referenceRevision,
      );
      const page = await f.request("GET", `${item}/revisions?limit=1`);
      assert.deepEqual(
        page
          .json()
          .revisions.map((r: { contentRevision: number }) => r.contentRevision),
        [1],
      );
      assert.equal(page.json().nextContentRevision, 1);
      const page2 = await f.request(
        "GET",
        `${item}/revisions?afterContentRevision=1&limit=16`,
      );
      assert.deepEqual(
        page2
          .json()
          .revisions.map((r: { contentRevision: number }) => r.contentRevision),
        [2],
      );
      const refs = await f.request("GET", `${item}/references?limit=16`);
      assert.equal(refs.json().references.length, 1);
      const list = await f.request("GET", "?limit=16");
      assert.equal(list.json().assets.length, 1);
      assert.equal(list.json().assets[0].assetId, id);
      const refReplay = await f.request(
        "POST",
        `${item}/reference-candidates`,
        refBody,
        "reference-original",
      );
      assert.equal(refReplay.statusCode, 200, refReplay.body);
      assert.equal(refReplay.json().disposition, "replayed");
      assert.deepEqual(
        refReplay.json().referenceRevision,
        reference.json().referenceRevision,
      );
      assert.deepEqual(await f.execution(), before);
      assert.equal((await f.request("HEAD", item)).statusCode, 404);
    },
  );

  test(
    `${backend}: asset HTTP rejects identity, foreign owner, revoked PDP, forged body, keys and malformed pagination without a candidate`,
    assetTestOptions(backend),
    async (t) => {
      const f = await setup(t, backend),
        before = await f.execution();
      for (const [headers, status] of [
        [{ ...f.headers(), authorization: "Bearer wrong" }, 401],
        [{ ...f.headers(), "x-csrf-token": "wrong" }, 403],
        [{ ...f.headers(), origin: "https://foreign.invalid" }, 403],
        [{ ...f.headers(), "idempotency-key": "" }, 400],
      ] as const) {
        const r = await f.app.inject({
          method: "POST",
          url: f.root + "/candidates",
          headers,
          payload: body,
        });
        assert.equal(r.statusCode, status, r.body);
      }
      for (const field of [
        "projectId",
        "tenantId",
        "spaceId",
        "actorId",
        "principalId",
        "idempotencyKey",
        "url",
        "sourceRunId",
        "assetId",
      ]) {
        const r = await f.request("POST", "/candidates", {
          ...body,
          [field]: "forged",
        });
        assert.equal(r.statusCode, 400, r.body);
      }
      for (const key of [".", "..", "bad,key"]) {
        const r = await f.request("POST", "/candidates", body, key);
        assert.equal(r.statusCode, 400, r.body);
      }
      for (const suffix of [
        "?limit=01",
        "?limit=17",
        "?limit=-1",
        "?limit=9007199254740993",
        "?limit=1&limit=2",
        "?unknown=x",
        "?afterAssetId=..",
        "/items/%20invalid",
        "/items/missing?unexpected=1",
        "/items/missing/revisions/01",
        "/items/missing/references/0",
        "/items/missing/revisions?afterContentRevision=-1",
        "/items/missing/references?limit=2&limit=3",
      ]) {
        const r = await f.request("GET", suffix);
        assert.equal(r.statusCode, 400, `${suffix}: ${r.body}`);
      }
      assert.equal(
        (await f.request("POST", "/candidates?unknown=1", body)).statusCode,
        400,
      );
      assert.equal(
        (await f.request("POST", "/candidates", [])).statusCode,
        400,
      );
      assert.equal(
        (
          await f.request("POST", "/candidates", {
            ...body,
            content: { ...assetContent, setting: "x".repeat(30 * 1024) },
          })
        ).statusCode,
        400,
      );
      for (const account of [1, 2, 3]) {
        const r = await f.request(
          "POST",
          "/candidates",
          body,
          `foreign-${account}`,
          account,
        );
        assert.ok(r.statusCode === 403 || r.statusCode === 404, r.body);
      }
      f.policy.denied = "creativeProject:write";
      assert.equal(
        (await f.request("POST", "/candidates", body, "withdrawn")).statusCode,
        403,
      );
      f.policy.denied = "creativeProject:read";
      assert.equal((await f.request("GET", "")).statusCode, 403);
      f.policy.denied = null;
      assert.deepEqual((await f.request("GET", "")).json(), {
        assets: [],
        nextAssetId: null,
      });
      assert.deepEqual(await f.execution(), before);
      const saved = await f.request("POST", "/candidates", body, "valid");
      assert.equal(saved.statusCode, 200, saved.body);
      const conflict = await f.request(
        "POST",
        "/candidates",
        { ...body, content: { ...assetContent, name: "不同正文" } },
        "valid",
      );
      assert.equal(conflict.statusCode, 409, conflict.body);
    },
  );
}
