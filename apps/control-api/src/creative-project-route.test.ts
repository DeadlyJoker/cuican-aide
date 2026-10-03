import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  CreativeProjectApplicationService,
  type CreativeProjectAuthorizationAction,
} from "@crewon/application";
import { MAX_CREATIVE_PROJECT_RESPONSE_BYTES } from "@crewon/contracts";
import {
  actor,
  digester,
  fixture,
  timestamp,
  type Backend,
  type ProjectStore,
} from "../../../packages/store/src/creative-project-store.test-support.ts";
import { registerCreativeProjectRoutes } from "./creative-project-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

const ROOT = "/api/v1/creative-projects";
const ORIGIN = "http://127.0.0.1:5731";
const CSRF = "creative-test-csrf-32-bytes-minimum-0001";
const TOKENS = ["owner", "other-principal", "other-space", "other-tenant"].map(
  (name) => `creative-test-session-${name}-32-bytes-minimum`,
);
const ACTORS = [
  actor,
  { ...actor, principalId: "principal-other", actorId: "actor-other" },
  { ...actor, spaceId: "space-other" },
  { ...actor, tenantId: "tenant-other" },
];

function http(store: ProjectStore) {
  const policy: { denied: CreativeProjectAuthorizationAction | null } = {
    denied: null,
  };
  const identities = ACTORS.map(
    (who, index) =>
      new StandaloneIdentity({
        actor: who,
        sessionToken: TOKENS[index]!,
        csrfToken: CSRF,
        allowedOrigins: [ORIGIN],
      }),
  );
  const app = Fastify({ bodyLimit: 64 * 1024 });
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
  registerCreativeProjectRoutes(app, {
    identity: {
      resolveActor: async (context) => {
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
    creativeProjects: new CreativeProjectApplicationService({
      store,
      authorization: {
        authorize: async (request) =>
          policy.denied === request.action
            ? { outcome: "deny", reasonCode: "creative-test-revoked" }
            : { outcome: "allow" },
      },
      clock: { now: () => timestamp },
      ids: { nextId: () => randomUUID() },
      digester,
    }),
  });
  const headers = (key = "create-project", account = 0) => ({
    "authorization": `Bearer ${TOKENS[account]}`,
    "origin": ORIGIN,
    "x-csrf-token": CSRF,
    "idempotency-key": key,
  });
  return { app, headers, policy };
}

async function setup(t: TestContext, backend: Backend) {
  const database = await fixture(t, backend);
  const runtime = http(database.first.store);
  t.after(() => runtime.app.close());
  const create = async (key = "create-project", title = "雨夜相逢") => {
    const result = await runtime.app.inject({
      method: "POST",
      url: ROOT,
      headers: runtime.headers(key),
      payload: { title, briefText: "两人在雨夜重逢。" },
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  return { ...database, ...runtime, create };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };

  test(
    `${backend} project HTTP: authenticated immutable inputs, concepts, metadata and cold restore`,
    options,
    async (t) => {
      const f = await setup(t, backend);
      const created = await f.create();
      assert.equal(created.project.revision, 2);
      assert.equal(created.brief.briefRevision, 1);
      assert.deepEqual(
        Object.keys(created.project).sort(),
        [
          "createdAt",
          "kind",
          "latestBriefRevision",
          "projectId",
          "revision",
          "state",
          "title",
          "updatedAt",
        ].sort(),
      );
      const base = `${ROOT}/${created.project.projectId}`;
      const concept = await f.app.inject({
        method: "POST",
        url: `${base}/concepts`,
        headers: f.headers("concept-1"),
        payload: {
          name: "雨夜",
          briefRevision: 1,
          prompt: "雨夜街道，写实质感",
          expectedProjectRevision: 2,
        },
      });
      assert.equal(concept.statusCode, 200, concept.body);
      const firstConcept = concept.json();
      const brief = await f.app.inject({
        method: "POST",
        url: `${base}/briefs`,
        headers: f.headers("brief-2"),
        payload: {
          text: "清晨重逢。",
          expectedProjectRevision: firstConcept.project.revision,
        },
      });
      assert.equal(brief.statusCode, 200, brief.body);
      const secondBrief = brief.json();
      const assetBase = `${base}/concepts/${firstConcept.asset.assetId}`;
      const revised = await f.app.inject({
        method: "POST",
        url: `${assetBase}/revisions`,
        headers: f.headers("concept-2"),
        payload: {
          briefRevision: secondBrief.brief.briefRevision,
          prompt: "清晨街道",
          expectedProjectRevision: secondBrief.project.revision,
          expectedAssetMetadataRevision: firstConcept.asset.revision,
        },
      });
      assert.equal(revised.statusCode, 200, revised.body);
      const secondConcept = revised.json();
      const renamed = await f.app.inject({
        method: "PUT",
        url: `${base}/title`,
        headers: f.headers("rename"),
        payload: {
          title: "新的列表标题",
          expectedProjectRevision: secondConcept.project.revision,
        },
      });
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.equal(
        renamed.json().project.latestBriefRevision,
        secondBrief.brief.briefRevision,
      );
      const assetPage = await f.app.inject({
        method: "GET",
        url: `${base}/concepts?limit=1`,
        headers: f.headers(),
      });
      assert.equal(assetPage.statusCode, 200, assetPage.body);
      assert.deepEqual(assetPage.json(), {
        assets: [secondConcept.asset],
        nextAfterAssetId: secondConcept.asset.assetId,
      });
      const emptyAssetPage = await f.app.inject({
        method: "GET",
        url: `${base}/concepts?afterAssetId=${encodeURIComponent(secondConcept.asset.assetId)}&limit=1`,
        headers: f.headers(),
      });
      assert.deepEqual(emptyAssetPage.json(), {
        assets: [],
        nextAfterAssetId: null,
      });
      const revisionPage = await f.app.inject({
        method: "GET",
        url: `${assetBase}/revisions?limit=1`,
        headers: f.headers(),
      });
      assert.equal(revisionPage.statusCode, 200, revisionPage.body);
      assert.deepEqual(revisionPage.json(), {
        revisions: [firstConcept.assetRevision],
        nextAfterAssetRevision: 1,
      });
      const secondRevisionPage = await f.app.inject({
        method: "GET",
        url: `${assetBase}/revisions?afterAssetRevision=1&limit=20`,
        headers: f.headers(),
      });
      assert.deepEqual(secondRevisionPage.json(), {
        revisions: [secondConcept.assetRevision],
        nextAfterAssetRevision: null,
      });
      await f.app.close();
      await f.first.parent.close();
      await f.second.parent.close();
      const reopened = await f.open();
      const restored = http(reopened.store);
      t.after(() => restored.app.close());
      for (const [url, field, expected] of [
        [base, "project", renamed.json().project],
        [`${base}/briefs/1`, "brief", created.brief],
        [`${base}/briefs/2`, "brief", secondBrief.brief],
        [assetBase, "asset", secondConcept.asset],
        [
          `${assetBase}/revisions/1`,
          "assetRevision",
          firstConcept.assetRevision,
        ],
        [
          `${assetBase}/revisions/2`,
          "assetRevision",
          secondConcept.assetRevision,
        ],
      ] as const) {
        const result = await restored.app.inject({
          method: "GET",
          url,
          headers: restored.headers(),
        });
        assert.equal(result.statusCode, 200, result.body);
        assert.deepEqual(result.json()[field], expected);
        assert.equal(
          /ownerPrincipalId|tenantId|spaceId|createdByActorId|updatedByActorId|operationId|images|credits/.test(
            result.body,
          ),
          false,
        );
      }
      assert.equal(await f.count("run_snapshots"), 0);
      assert.equal(await f.count("threads"), 0);
    },
  );

  test(
    `${backend} project HTTP: exact input, current access, session Origin and CSRF fences`,
    options,
    async (t) => {
      const f = await setup(t, backend);
      const valid = { title: "项目", briefText: "需求" };
      for (const [headers, status] of [
        [{}, 401],
        [{ ...f.headers(), origin: "https://untrusted.invalid" }, 403],
        [{ ...f.headers(), "x-csrf-token": "wrong" }, 403],
      ] as const) {
        assert.equal(
          (
            await f.app.inject({
              method: "POST",
              url: ROOT,
              headers,
              payload: valid,
            })
          ).statusCode,
          status,
        );
      }
      for (const extra of [
        "owner",
        "ownerPrincipalId",
        "principalId",
        "tenantId",
        "spaceId",
        "actorId",
        "projectId",
        "idempotencyKey",
      ]) {
        assert.equal(
          (
            await f.app.inject({
              method: "POST",
              url: ROOT,
              headers: f.headers(),
              payload: { ...valid, [extra]: "claimed" },
            })
          ).statusCode,
          400,
          extra,
        );
      }
      for (const headers of [
        { ...f.headers(), "idempotency-key": "" },
        { ...f.headers(), "idempotency-key": ["one", "two"] },
      ])
        assert.equal(
          (
            await f.app.inject({
              method: "POST",
              url: ROOT,
              headers,
              payload: valid,
            })
          ).statusCode,
          400,
        );
      const created = await f.create();
      const base = `${ROOT}/${created.project.projectId}`;
      for (const suffix of [
        "?owner=claimed",
        "?limit=01",
        "?limit=51",
        "?limit=1&limit=2",
        "?state=invalid",
      ]) {
        assert.equal(
          (
            await f.app.inject({
              method: "GET",
              url: `${ROOT}${suffix}`,
              headers: f.headers(),
            })
          ).statusCode,
          400,
          suffix,
        );
      }
      for (const url of [
        `${base}?limit=1`,
        `${base}/briefs?afterBriefRevision=01`,
        `${base}/briefs/01`,
        `${base}/briefs/1e0`,
        `${base}/briefs/9007199254740992`,
      ])
        assert.equal(
          (await f.app.inject({ method: "GET", url, headers: f.headers() }))
            .statusCode,
          400,
          url,
        );
      f.policy.denied = "creativeProject:read";
      assert.equal(
        (await f.app.inject({ method: "GET", url: base, headers: f.headers() }))
          .statusCode,
        403,
      );
      f.policy.denied = "creativeProject:create";
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: ROOT,
            headers: f.headers(),
            payload: { title: "雨夜相逢", briefText: "两人在雨夜重逢。" },
          })
        ).statusCode,
        403,
      );
      assert.equal(await f.count("creative_projects"), 1);
    },
  );

  test(
    `${backend} project HTTP: owner and tenant isolation cannot be replaced by same-space access`,
    options,
    async (t) => {
      const f = await setup(t, backend);
      const created = await f.create();
      const base = `${ROOT}/${created.project.projectId}`;
      const conceptReply = await f.app.inject({
        method: "POST",
        url: `${base}/concepts`,
        headers: f.headers("isolation-concept"),
        payload: {
          name: "本人概念",
          briefRevision: 1,
          prompt: "本人保存的描述",
          expectedProjectRevision: 2,
        },
      });
      assert.equal(conceptReply.statusCode, 200, conceptReply.body);
      const concept = conceptReply.json();
      const assetBase = `${base}/concepts/${concept.asset.assetId}`;
      for (const account of [1, 2, 3]) {
        for (const url of [
          base,
          `${base}/briefs`,
          `${base}/briefs/1`,
          `${base}/concepts`,
          assetBase,
          `${assetBase}/revisions`,
          `${assetBase}/revisions/1`,
        ]) {
          const result = await f.app.inject({
            method: "GET",
            url,
            headers: f.headers("foreign", account),
          });
          assert.equal(result.statusCode, 404, result.body);
          assert.equal(result.body.includes(created.project.title), false);
        }
        const listed = await f.app.inject({
          method: "GET",
          url: ROOT,
          headers: f.headers("foreign", account),
        });
        assert.deepEqual(listed.json(), { projects: [], nextCursor: null });
        assert.equal(
          (
            await f.app.inject({
              method: "POST",
              url: `${base}/briefs`,
              headers: f.headers("foreign", account),
              payload: {
                text: "夺取项目",
                expectedProjectRevision: concept.project.revision,
              },
            })
          ).statusCode,
          404,
        );
        assert.equal(
          (
            await f.app.inject({
              method: "POST",
              url: `${assetBase}/revisions`,
              headers: f.headers("foreign-concept", account),
              payload: {
                briefRevision: 1,
                prompt: "夺取概念",
                expectedProjectRevision: concept.project.revision,
                expectedAssetMetadataRevision: concept.asset.revision,
              },
            })
          ).statusCode,
          404,
        );
      }
      assert.equal(await f.count("creative_project_briefs"), 1);
    },
  );

  test(
    `${backend} project HTTP: lost-response replay, mutation conflicts and concurrent CAS`,
    options,
    async (t) => {
      const f = await setup(t, backend);
      const created = await f.create();
      const replayed = await f.create();
      assert.equal(replayed.disposition, "replayed");
      assert.deepEqual(replayed.project, created.project);
      assert.deepEqual(replayed.brief, created.brief);
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: ROOT,
            headers: f.headers(),
            payload: { title: "换输入", briefText: "两人在雨夜重逢。" },
          })
        ).statusCode,
        409,
      );
      const base = `${ROOT}/${created.project.projectId}`;
      const writes = await Promise.all(
        ["新需求A", "新需求B"].map((text, index) =>
          f.app.inject({
            method: "POST",
            url: `${base}/briefs`,
            headers: f.headers(`concurrent-${index}`),
            payload: { text, expectedProjectRevision: 2 },
          }),
        ),
      );
      assert.deepEqual(
        writes.map((reply) => reply.statusCode).sort(),
        [200, 409],
      );
      const committed = writes
        .find((reply) => reply.statusCode === 200)!
        .json();
      const list = await f.app.inject({
        method: "GET",
        url: `${base}/briefs`,
        headers: f.headers(),
      });
      assert.equal(list.json().briefs.length, 2);
      assert.deepEqual(list.json().briefs[0], created.brief);
      assert.deepEqual(list.json().briefs[1], committed.brief);
      assert.equal(await f.count("creative_projects"), 1);
      assert.equal(await f.count("creative_project_briefs"), 2);
      assert.equal(await f.count("creative_project_mutation_receipts"), 2);
    },
  );

  test(
    `${backend} project HTTP: archive preserves history and blocks new creative revisions until restore`,
    options,
    async (t) => {
      const f = await setup(t, backend);
      const created = await f.create();
      const base = `${ROOT}/${created.project.projectId}`;
      const archived = await f.app.inject({
        method: "PUT",
        url: `${base}/state`,
        headers: f.headers("archive"),
        payload: { state: "archived", expectedProjectRevision: 2 },
      });
      assert.equal(archived.statusCode, 200, archived.body);
      const revision = archived.json().project.revision;
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: `${base}/briefs`,
            headers: f.headers("archived-brief"),
            payload: { text: "不应写入", expectedProjectRevision: revision },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: `${base}/concepts`,
            headers: f.headers("archived-concept"),
            payload: {
              name: "图",
              prompt: "不应写入",
              briefRevision: 1,
              expectedProjectRevision: revision,
            },
          })
        ).statusCode,
        409,
      );
      assert.deepEqual(
        (
          await f.app.inject({
            method: "GET",
            url: `${base}/briefs/1`,
            headers: f.headers(),
          })
        ).json().brief,
        created.brief,
      );
      assert.equal(
        (
          await f.app.inject({ method: "GET", url: ROOT, headers: f.headers() })
        ).json().projects.length,
        0,
      );
      assert.equal(
        (
          await f.app.inject({
            method: "GET",
            url: `${ROOT}?state=archived`,
            headers: f.headers(),
          })
        ).json().projects.length,
        1,
      );
      const restored = await f.app.inject({
        method: "PUT",
        url: `${base}/state`,
        headers: f.headers("restore"),
        payload: { state: "active", expectedProjectRevision: revision },
      });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: `${base}/briefs`,
            headers: f.headers("restored-brief"),
            payload: {
              text: "恢复后的需求",
              expectedProjectRevision: restored.json().project.revision,
            },
          })
        ).statusCode,
        200,
      );
    },
  );

  test(
    `${backend} project HTTP: project cursors bind state and large histories remain byte-bounded with no gaps`,
    options,
    async (t) => {
      const f = await setup(t, backend);
      const created = await f.create();
      await f.create("create-2", "第二个项目");
      await f.create("create-3", "第三个项目");
      const firstPage = await f.app.inject({
        method: "GET",
        url: `${ROOT}?limit=1`,
        headers: f.headers(),
      });
      const page = firstPage.json();
      assert.equal(page.projects.length, 1);
      assert.equal(typeof page.nextCursor, "string");
      const cursor = encodeURIComponent(page.nextCursor);
      assert.equal(
        (
          await f.app.inject({
            method: "GET",
            url: `${ROOT}?limit=1&state=archived&cursor=${cursor}`,
            headers: f.headers(),
          })
        ).statusCode,
        400,
      );
      const nextPage = await f.app.inject({
        method: "GET",
        url: `${ROOT}?limit=1&cursor=${cursor}`,
        headers: f.headers(),
      });
      assert.equal(nextPage.statusCode, 200, nextPage.body);
      assert.notEqual(
        nextPage.json().projects[0].projectId,
        page.projects[0].projectId,
      );
      const base = `${ROOT}/${created.project.projectId}`;
      let revision = created.project.revision;
      for (let index = 0; index < 10; index++) {
        const response = await f.app.inject({
          method: "POST",
          url: `${base}/briefs`,
          headers: f.headers(`large-${index}`),
          payload: {
            text: `${index}${"\n".repeat(8191)}`,
            expectedProjectRevision: revision,
          },
        });
        assert.equal(response.statusCode, 200, response.body);
        revision = response.json().project.revision;
      }
      const seen: number[] = [];
      let afterBriefRevision = 0;
      for (let reads = 0; reads < 12; reads++) {
        const response = await f.app.inject({
          method: "GET",
          url: `${base}/briefs?limit=50&afterBriefRevision=${afterBriefRevision}`,
          headers: f.headers(),
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.ok(
          Buffer.byteLength(response.body) <=
            MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
        );
        const result = response.json();
        for (const brief of result.briefs) {
          seen.push(brief.briefRevision);
          if (brief.briefRevision > 1) assert.equal(brief.text.length, 8192);
        }
        if (result.nextAfterBriefRevision === null) break;
        assert.ok(result.nextAfterBriefRevision > afterBriefRevision);
        afterBriefRevision = result.nextAfterBriefRevision;
      }
      assert.deepEqual(
        seen,
        Array.from({ length: 11 }, (_, index) => index + 1),
      );
    },
  );

  test(
    `${backend} project HTTP: receipt failure rolls back metadata and input together`,
    options,
    async (t) => {
      const f = await setup(t, backend);
      await f.failInserts("creative_project_mutation_receipts", true);
      const response = await f.app.inject({
        method: "POST",
        url: ROOT,
        headers: f.headers(),
        payload: { title: "回滚", briefText: "不能留下孤立需求" },
      });
      assert.equal(response.statusCode, 500);
      assert.equal(await f.count("creative_projects"), 0);
      assert.equal(await f.count("creative_project_briefs"), 0);
      assert.equal(await f.count("creative_project_mutation_receipts"), 0);
      await f.failInserts("creative_project_mutation_receipts", false);
      const retry = await f.app.inject({
        method: "POST",
        url: ROOT,
        headers: f.headers(),
        payload: { title: "回滚", briefText: "不能留下孤立需求" },
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json().disposition, "committed");
      assert.equal(await f.count("creative_projects"), 1);
    },
  );
}
