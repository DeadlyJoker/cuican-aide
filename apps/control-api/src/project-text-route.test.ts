import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  ProjectTextApplicationService,
  type CreativeProjectAuthorizationAction,
} from "@crewon/application";
import { MAX_PROJECT_TEXT_RESPONSE_BYTES } from "@crewon/contracts";
import {
  projectTextFixture,
  textActor,
  textAt,
  textDigester,
} from "../../../packages/store/src/project-text-store.test-support.ts";
import {
  publicTextOutline as outline,
  publicTextScript as script,
  textEpisodeId as episodeId,
} from "../../../packages/contracts/src/project-text-control.test-support.ts";
import { errorResponse } from "./control-api-errors.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { registerProjectTextRoutes } from "./project-text-route.ts";
const ORIGIN = "crewon://desktop";
const CSRF = "project-text-test-csrf-32-byte-minimum";
const TOKENS = [0, 1, 2, 3].map(
  (n) => `project-text-session-${n}-32-byte-minimum`,
);
const ACTORS = [
  textActor,
  { ...textActor, principalId: "other-principal", actorId: "other-actor" },
  { ...textActor, spaceId: "other-space" },
  { ...textActor, tenantId: "other-tenant" },
];
async function setup(t: TestContext, backend: "sqlite" | "postgres") {
  const f = await projectTextFixture(t, backend);
  const policy: { denied: CreativeProjectAuthorizationAction | null } = {
    denied: null,
  };
  const identities = ACTORS.map(
    (actor, index) =>
      new StandaloneIdentity({
        actor,
        sessionToken: TOKENS[index]!,
        csrfToken: CSRF,
        allowedOrigins: [ORIGIN],
      }),
  );
  let next = 0;
  const openHttp = (opened = f.first) => {
    const app = Fastify({ bodyLimit: 64 * 1024 });
    app.setErrorHandler((error, request, reply) => {
      const result = errorResponse(error, request.id);
      return reply.code(result.statusCode).send(result.body);
    });
    registerProjectTextRoutes(app, {
      identity: {
        resolveActor: (context) => {
          const index = TOKENS.findIndex(
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
      projectTexts: new ProjectTextApplicationService({
        store: opened.text,
        projects: opened.projects,
        authorization: {
          authorize: async (req) =>
            policy.denied === req.action
              ? { outcome: "deny", reasonCode: "text-policy-revoked" }
              : { outcome: "allow" },
        },
        clock: { now: () => textAt },
        ids: {
          nextId: () =>
            ["outline", "scripts", "manual"][next++] ?? `artifact-${next}`,
        },
        digester: textDigester,
      }),
    });
    t.after(() => app.close());
    return app;
  };
  const app = openHttp();
  const headers = (key = "text-key", account = 0) => ({
    "authorization": `Bearer ${TOKENS[account]}`,
    "origin": ORIGIN,
    "x-csrf-token": CSRF,
    "idempotency-key": key,
  });
  const root = `/api/v1/creative-projects/${encodeURIComponent(f.created.project.projectId)}/text-artifacts`;
  return { ...f, app, policy, headers, root, openHttp };
}
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} text HTTP candidate/selection/lock/history survive cold restore without touching project or execution`,
    options,
    async (t) => {
      const f = await setup(t, backend),
        root = f.root;
      const request = (
        method: "GET" | "POST" | "PUT",
        suffix: string,
        payload?: Record<string, unknown>,
        key = "text-key",
      ) =>
        f.app.inject({
          method,
          url: root + suffix,
          headers: f.headers(key),
          ...(payload === undefined ? {} : { payload }),
        });
      assert.deepEqual((await request("GET", "/outline")).json(), {
        view: null,
      });
      const body = {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outline,
      };
      const saved = await request(
        "POST",
        "/outline/candidates",
        body,
        "outline-first",
      );
      assert.equal(saved.statusCode, 200, saved.body);
      const first = saved.json();
      assert.equal(first.artifact.artifactId, "outline");
      assert.equal(first.artifact.selectedContentRevision, null);
      assert.equal(first.contentRevision.content.logline, outline.logline);
      assert.deepEqual(
        Object.keys(first.artifact).sort(),
        [
          "projectId",
          "artifactId",
          "kind",
          "episodeId",
          "revision",
          "latestContentRevision",
          "selectedContentRevision",
          "locked",
          "createdAt",
          "updatedAt",
        ].sort(),
      );
      const replay = await request(
        "POST",
        "/outline/candidates",
        body,
        "outline-first",
      );
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().disposition, "replayed");
      assert.deepEqual(replay.json().contentRevision, first.contentRevision);
      const selected = await request(
        "PUT",
        "/items/outline/selection",
        { expectedArtifactRevision: 1, contentRevision: 1 },
        "outline-select",
      );
      assert.equal(selected.statusCode, 200, selected.body);
      const scriptBody = {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: { artifactId: "outline", contentRevision: 1 },
        content: script,
      };
      const scriptSaved = await request(
        "POST",
        `/scripts/${encodeURIComponent(episodeId)}/candidates`,
        scriptBody,
        "script-first",
      );
      assert.equal(scriptSaved.statusCode, 200, scriptSaved.body);
      assert.equal(scriptSaved.json().artifact.artifactId, "scripts");
      const scriptSelected = await request(
        "PUT",
        "/items/scripts/selection",
        { expectedArtifactRevision: 1, contentRevision: 1 },
        "script-select",
      );
      assert.equal(scriptSelected.statusCode, 200, scriptSelected.body);
      const locked = await request(
        "PUT",
        "/items/scripts/lock",
        { expectedArtifactRevision: 2, locked: true },
        "script-lock",
      );
      assert.equal(locked.statusCode, 200, locked.body);
      assert.equal(locked.json().contentRevision, null);
      const appended = await request(
        "POST",
        `/scripts/${encodeURIComponent(episodeId)}/candidates`,
        {
          ...scriptBody,
          expectedArtifactRevision: 3,
          content: { ...script, title: "新候选" },
        },
        "script-candidate-two",
      );
      assert.equal(appended.statusCode, 200, appended.body);
      assert.equal(appended.json().artifact.locked, true);
      assert.equal(appended.json().artifact.selectedContentRevision, 1);
      const lockedSelection = await request(
        "PUT",
        "/items/scripts/selection",
        { expectedArtifactRevision: 4, contentRevision: 2 },
        "locked-selection",
      );
      assert.equal(lockedSelection.statusCode, 409, lockedSelection.body);
      const manual = await request(
        "POST",
        "/scripts/manual/candidates",
        { ...scriptBody, outline: null },
        "manual-script",
      );
      assert.equal(manual.statusCode, 200, manual.body);
      assert.equal(manual.json().contentRevision.outline, null);
      const page = await request("GET", "?limit=1");
      assert.equal(page.statusCode, 200, page.body);
      assert.equal(
        page.json().nextArtifactId,
        page.json().artifacts[0].artifactId,
      );
      const history = await request(
        "GET",
        "/items/scripts/revisions?afterContentRevision=0&limit=1",
      );
      assert.equal(history.statusCode, 200, history.body);
      assert.equal(history.json().nextContentRevision, 1);
      const history2 = await request(
        "GET",
        "/items/scripts/revisions?afterContentRevision=1&limit=16",
      );
      assert.deepEqual(
        history2
          .json()
          .revisions.map((r: { contentRevision: number }) => r.contentRevision),
        [2],
      );
      const exact = await request("GET", "/items/scripts/revisions/1");
      assert.equal(exact.statusCode, 200, exact.body);
      assert.deepEqual(
        exact.json().contentRevision,
        scriptSaved.json().contentRevision,
      );
      const logical = await request(
        "GET",
        `/scripts/${encodeURIComponent(episodeId)}`,
      );
      assert.equal(logical.json().view.dependencyState, "current");
      assert.equal(logical.json().view.selectedRevision.contentRevision, 1);
      await f.app.close();
      const cold = f.openHttp(await f.open());
      const resumed = await cold.inject({
        method: "GET",
        url: root + "/items/scripts",
        headers: f.headers(),
      });
      assert.equal(resumed.statusCode, 200, resumed.body);
      assert.deepEqual(resumed.json(), logical.json());
      assert.equal(
        (
          await f.projects.getProject(textActor, {
            projectId: f.created.project.projectId,
          })
        ).revision,
        f.created.project.revision,
      );
      assert.equal(await f.count("project_text_mutation_receipts"), 7);
      const tables = await f.sql(
        backend === "sqlite"
          ? "SELECT name FROM sqlite_master WHERE type='table'"
          : "SELECT tablename AS name FROM pg_tables WHERE schemaname=$1",
        backend === "sqlite" ? [] : [f.schema],
      );
      assert.equal(
        tables.some((row) =>
          /^(runs|extension_external_operations|extension_credit_|plugin_task_admission)/u.test(
            String(row.name),
          ),
        ),
        false,
      );
    },
  );
  test(
    `${backend} text HTTP refuses identity claims, CAS/key conflicts, foreign ownership and withdrawn policy`,
    options,
    async (t) => {
      const f = await setup(t, backend),
        valid = {
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: outline,
        };
      const post = (payload: Record<string, unknown>, headers = f.headers()) =>
        f.app.inject({
          method: "POST",
          url: f.root + "/outline/candidates",
          headers,
          payload,
        });
      for (const [headers, status] of [
        [{ ...f.headers(), authorization: "Bearer wrong" }, 401],
        [{ ...f.headers(), "x-csrf-token": "wrong" }, 403],
        [{ ...f.headers(), origin: "https://foreign.test" }, 403],
        [{ ...f.headers(), "idempotency-key": "" }, 400],
      ] as const)
        assert.equal((await post(valid, headers)).statusCode, status);
      for (const field of [
        "projectId",
        "tenantId",
        "spaceId",
        "actorId",
        "principalId",
        "idempotencyKey",
      ])
        assert.equal(
          (await post({ ...valid, [field]: "claimed" })).statusCode,
          400,
          field,
        );
      assert.equal((await post(valid)).statusCode, 200);
      assert.equal(
        (
          await post({
            ...valid,
            content: { ...outline, logline: "different" },
          })
        ).statusCode,
        409,
      );
      assert.equal((await post(valid, f.headers("other-key"))).statusCode, 409);
      for (const account of [1, 2, 3]) {
        for (const suffix of [
          "",
          "/outline",
          "/items/outline",
          "/items/outline/revisions",
          "/items/outline/revisions/1",
        ]) {
          const response = await f.app.inject({
            method: "GET",
            url: f.root + suffix,
            headers: f.headers("foreign", account),
          });
          assert.equal(response.statusCode, 404, response.body);
          assert.equal(response.body.includes(outline.logline), false);
        }
        assert.equal(
          (await post(valid, f.headers("foreign", account))).statusCode,
          404,
        );
      }
      for (const suffix of [
        "?limit=17",
        "?limit=01",
        "?limit=1&limit=2",
        "?owner=claimed",
        "/outline?limit=1",
        "/items/outline/revisions/01",
      ])
        assert.equal(
          (
            await f.app.inject({
              method: "GET",
              url: f.root + suffix,
              headers: f.headers(),
            })
          ).statusCode,
          400,
          suffix,
        );
      f.policy.denied = "creativeProject:read";
      assert.equal(
        (
          await f.app.inject({
            method: "GET",
            url: f.root + "/outline",
            headers: f.headers(),
          })
        ).statusCode,
        403,
      );
      f.policy.denied = "creativeProject:write";
      assert.equal((await post(valid)).statusCode, 403);
      assert.equal(await f.count("project_text_mutation_receipts"), 1);
    },
  );
  test(
    `${backend} text history trims complete records to sixty KiB and resumes from the last returned revision`,
    options,
    async (t) => {
      const f = await setup(t, backend);
      const large = {
        ...script,
        scenes: Array.from({ length: 3 }, (_, i) => ({
          ...script.scenes[0],
          sceneId: `scene-${i}`,
          action: "x".repeat(8192),
        })),
      };
      for (let i = 0; i < 5; i++) {
        const result = await f.app.inject({
          method: "POST",
          url: f.root + "/scripts/manual/candidates",
          headers: f.headers(`large-${i}`),
          payload: {
            expectedArtifactRevision: i,
            briefRevision: 1,
            outline: null,
            content: { ...large, title: `候选${i}` },
          },
        });
        assert.equal(result.statusCode, 200, result.body);
      }
      const first = await f.app.inject({
        method: "GET",
        url: f.root + "/items/outline/revisions?limit=16",
        headers: f.headers(),
      });
      assert.equal(first.statusCode, 200, first.body);
      assert.ok(
        Buffer.byteLength(first.body) <= MAX_PROJECT_TEXT_RESPONSE_BYTES,
      );
      assert.equal(first.json().revisions.length, 2);
      assert.equal(first.json().nextContentRevision, 2);
      const next = await f.app.inject({
        method: "GET",
        url:
          f.root + "/items/outline/revisions?afterContentRevision=2&limit=16",
        headers: f.headers(),
      });
      assert.deepEqual(
        next
          .json()
          .revisions.map((r: { contentRevision: number }) => r.contentRevision),
        [3, 4],
      );
      assert.equal(next.json().nextContentRevision, 4);
      assert.deepEqual(first.json().revisions[0].content, {
        ...large,
        title: "候选0",
      });
    },
  );
}
