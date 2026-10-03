import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import type {
  ConceptRevisionListResponse,
  CreativeProjectBriefMutationResponse,
  CreativeProjectConceptMutationResponse,
  CreativeProjectListResponse,
  CreativeProjectMetadataMutationResponse,
  ErrorEnvelope,
  GetConceptRevisionResponse,
  GetCreativeProjectResponse,
  GetProjectBriefResponse,
  ProjectBriefListResponse,
} from "@crewon/contracts";
import { CreativeProjectApplicationService } from "../../../packages/application/src/creative-project-application-service.ts";
import { SqliteRunStore } from "../../../packages/store/src/sqlite-run-store.ts";
import { registerCreativeProjectRoutes } from "../../control-api/src/creative-project-route.ts";
import { errorResponse } from "../../control-api/src/control-api-errors.ts";
import { ControlApiIdentityError } from "../../control-api/src/control-api-ports.ts";
import { StandaloneIdentity } from "../../control-api/src/standalone-adapters.ts";
import { createWebBff } from "./web-bff.ts";
import { CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES } from "./creative-project-proxy-policy.ts";

const ROOT = "/api/v1/creative-projects";
const publicOrigin = "https://creative-control-bff.example.test";
const controlCsrf = "creative-control-csrf-at-least-32-characters";
const serviceToken = "creative-control-bff-service-at-least-32";
const actors = [
  {
    principalId: "owner-a",
    actorId: "actor-a",
    tenantId: "tenant",
    spaceId: "space",
  },
  {
    principalId: "owner-b",
    actorId: "actor-b",
    tenantId: "tenant",
    spaceId: "space",
  },
  {
    principalId: "owner-a",
    actorId: "actor-a",
    tenantId: "tenant",
    spaceId: "other-space",
  },
  {
    principalId: "owner-a",
    actorId: "actor-a",
    tenantId: "other-tenant",
    spaceId: "space",
  },
];
const tokens = actors.map(
  (_, index) => `creative-control-access-${index}-at-least-32`,
);
const cookies = actors.map(
  (_, index) => `crewon_session=creative-cookie-${index}`,
);

async function start(databasePath: string) {
  const store = new SqliteRunStore(databasePath);
  const control = Fastify({ bodyLimit: 64 * 1024 });
  try {
    const projects = store.creativeProjectStore();
    await projects.migrate();
    const identities = actors.map(
      (actor, index) =>
        new StandaloneIdentity({
          actor,
          sessionToken: tokens[index]!,
          csrfToken: controlCsrf,
          allowedOrigins: [publicOrigin],
        }),
    );
    const policy = { revoked: false };
    control.setErrorHandler((error, request, reply) => {
      const mapped = errorResponse(error, request.id);
      return reply.code(mapped.statusCode).send(mapped.body);
    });
    registerCreativeProjectRoutes(control, {
      identity: {
        resolveActor: async (request) => {
          const index = tokens.findIndex(
            (token) => request.headers.authorization === `Bearer ${token}`,
          );
          if (index < 0)
            throw new ControlApiIdentityError(
              "authentication",
              "session_invalid",
            );
          assert.equal(
            request.headers["x-crewon-bff-authorization"],
            `Bearer ${serviceToken}`,
          );
          return identities[index]!.resolveActor(request);
        },
      },
      creativeProjects: new CreativeProjectApplicationService({
        store: projects,
        authorization: {
          authorize: async ({ actor, resource }) => {
            assert.equal(resource.tenantId, actor.tenantId);
            assert.equal(resource.spaceId, actor.spaceId);
            return policy.revoked
              ? { outcome: "deny", reasonCode: "creative_fixture_revoked" }
              : { outcome: "allow" };
          },
        },
        clock: { now: () => "2026-10-03T00:00:00.000Z" },
        ids: { nextId: () => randomUUID() },
        digester: {
          sha256: (input) =>
            `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`,
        },
      }),
    });
    const controlOrigin = await control.listen({ host: "127.0.0.1", port: 0 });
    const calls: string[] = [];
    const browser = createWebBff({
      publicOrigin,
      controlTarget: controlOrigin,
      controlBffToken: serviceToken,
      controlCsrfToken: controlCsrf,
      csrfSecret: "creative-browser-csrf-secret-at-least-32",
      identity: {
        resolve: async ({ cookie }) => {
          const index = cookies.indexOf(cookie ?? "");
          return index < 0
            ? null
            : {
                controlAccessToken: tokens[index]!,
                sessionId: `creative-verified-session-${index}-at-least-32`,
                expiresAt: "2030-01-01T00:00:00.000Z",
              };
        },
      },
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("cookie"), null);
        assert.equal(init?.redirect, "manual");
        for (const name of [
          "x-crewon-principal-id",
          "x-crewon-actor-id",
          "x-crewon-tenant-id",
          "x-crewon-space-id",
        ])
          assert.equal(headers.get(name), null);
        calls.push(String(input));
        return fetch(input, init);
      },
    });
    const csrf = await Promise.all(
      cookies.map(async (cookie) => {
        const response = await browser.handle(
          new Request(`${publicOrigin}/control-api/session`, {
            headers: { cookie },
          }),
        );
        assert.equal(response.status, 200);
        return ((await response.json()) as { csrfToken: string }).csrfToken;
      }),
    );
    async function json<T = ErrorEnvelope>(
      path: string,
      options: {
        method?: string;
        body?: unknown;
        key?: string;
        account?: number;
      } = {},
    ): Promise<{ status: number; body: T }> {
      const account = options.account ?? 0;
      const response = await browser.handle(
        new Request(`${publicOrigin}${path}`, {
          method: options.method ?? "GET",
          headers: {
            "cookie": cookies[account]!,
            "origin": publicOrigin,
            "x-csrf-token": csrf[account]!,
            "content-type": "application/json",
            "idempotency-key": options.key ?? "original-key",
            "authorization": "Bearer browser-forged-token",
            "x-crewon-principal-id": "forged-owner",
            "x-crewon-actor-id": "forged-actor",
            "x-crewon-tenant-id": "forged-tenant",
            "x-crewon-space-id": "forged-space",
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        }),
      );
      const text = await response.text();
      assert.ok(
        Buffer.byteLength(text) <= CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES,
      );
      return { status: response.status, body: JSON.parse(text) as T };
    }
    return {
      browser,
      json,
      calls,
      csrf,
      policy,
      store,
      close: async () => {
        await control.close();
        await store.close();
      },
    };
  } catch (error) {
    try {
      await control.close();
    } finally {
      await store.close();
    }
    throw error;
  }
}

test("real SQLite Control metadata and immutable inputs survive BFF writes, account isolation and restart", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-project-bff-"));
  const databasePath = join(directory, "control.sqlite");
  let runtime: Awaited<ReturnType<typeof start>> | undefined;
  context.after(async () => {
    try {
      await runtime?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  runtime = await start(databasePath);
  const command = {
    title: "雨夜相逢",
    briefText: "两人在雨夜重逢。\n保留真实输入。",
  };
  const created = await runtime.json<CreativeProjectBriefMutationResponse>(
    ROOT,
    {
      method: "POST",
      body: command,
      key: "create-owner-a",
    },
  );
  assert.equal(created.status, 200);
  assert.equal(created.body.project.revision, 2);
  assert.equal(created.body.brief.briefRevision, 1);
  assert.equal(created.body.brief.text, command.briefText);
  for (const field of [
    "ownerPrincipalId",
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
    "createdByActorId",
    "updatedByActorId",
  ])
    assert.equal(Object.hasOwn(created.body.project, field), false);
  const projectId = created.body.project.projectId;
  const base = `${ROOT}/${encodeURIComponent(projectId)}`;
  const replay = await runtime.json<CreativeProjectBriefMutationResponse>(
    ROOT,
    {
      method: "POST",
      body: command,
      key: "create-owner-a",
    },
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.disposition, "replayed");
  assert.deepEqual(replay.body.project, created.body.project);
  const changed = await runtime.json(ROOT, {
    method: "POST",
    body: { ...command, title: "冲突" },
    key: "create-owner-a",
  });
  assert.equal(changed.status, 409);
  for (const account of [1, 2, 3]) {
    assert.equal((await runtime.json(base, { account })).status, 404);
    assert.equal(
      (await runtime.json(`${base}/briefs/1`, { account })).status,
      404,
    );
    const list: { status: number; body: CreativeProjectListResponse } =
      await runtime.json<CreativeProjectListResponse>(ROOT, {
        account,
      });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.projects, []);
  }
  const other = await runtime.json<CreativeProjectBriefMutationResponse>(ROOT, {
    method: "POST",
    body: { title: "另一位用户", briefText: "私人项目" },
    key: "create-owner-a",
    account: 1,
  });
  assert.equal(other.status, 200);
  assert.notEqual(other.body.project.projectId, projectId);
  assert.deepEqual(
    (await runtime.json<CreativeProjectListResponse>(ROOT)).body.projects.map(
      (project) => project.projectId,
    ),
    [projectId],
  );

  const renamed = await runtime.json<CreativeProjectMetadataMutationResponse>(
    `${base}/title`,
    {
      method: "PUT",
      body: { title: "雨夜重逢", expectedProjectRevision: 2 },
      key: "rename-a",
    },
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.project.revision, 3);
  assert.equal(
    (
      await runtime.json(`${base}/briefs`, {
        method: "POST",
        body: { text: "过期写入", expectedProjectRevision: 2 },
        key: "stale-write",
      })
    ).status,
    409,
  );
  const brief = await runtime.json<CreativeProjectBriefMutationResponse>(
    `${base}/briefs`,
    {
      method: "POST",
      body: { text: "新需求\n仍不触发生图。", expectedProjectRevision: 3 },
      key: "brief-a-2",
    },
  );
  assert.equal(brief.status, 200);
  assert.equal(brief.body.brief.briefRevision, 2);
  const concept = await runtime.json<CreativeProjectConceptMutationResponse>(
    `${base}/concepts`,
    {
      method: "POST",
      key: "concept-a-1",
      body: {
        briefRevision: 1,
        name: "雨夜街道",
        prompt: "用户确认的第一版描述。",
        expectedProjectRevision: brief.body.project.revision,
      },
    },
  );
  assert.equal(concept.status, 200);
  assert.equal(concept.body.assetRevision.briefRevision, 1);
  assert.equal(
    concept.body.assetRevision.briefContentDigest,
    created.body.brief.contentDigest,
  );
  const assetBase = `${base}/concepts/${encodeURIComponent(concept.body.asset.assetId)}`;
  const revised = await runtime.json<CreativeProjectConceptMutationResponse>(
    `${assetBase}/revisions`,
    {
      method: "POST",
      key: "concept-a-2",
      body: {
        briefRevision: 2,
        prompt: "用户确认的第二版描述。",
        expectedProjectRevision: concept.body.project.revision,
        expectedAssetMetadataRevision: concept.body.asset.revision,
      },
    },
  );
  assert.equal(revised.status, 200);
  assert.equal(revised.body.assetRevision.assetRevision, 2);
  assert.equal(
    revised.body.assetRevision.briefContentDigest,
    brief.body.brief.contentDigest,
  );
  assert.deepEqual(
    (await runtime.json<GetConceptRevisionResponse>(`${assetBase}/revisions/1`))
      .body.assetRevision,
    concept.body.assetRevision,
  );

  const archived = await runtime.json<CreativeProjectMetadataMutationResponse>(
    `${base}/state`,
    {
      method: "PUT",
      body: {
        state: "archived",
        expectedProjectRevision: revised.body.project.revision,
      },
      key: "archive-a",
    },
  );
  assert.equal(archived.status, 200);
  assert.equal(
    (
      await runtime.json(`${base}/briefs`, {
        method: "POST",
        body: {
          text: "归档后禁止新创作",
          expectedProjectRevision: archived.body.project.revision,
        },
        key: "archived-write",
      })
    ).status,
    409,
  );
  assert.equal(
    (await runtime.json<GetProjectBriefResponse>(`${base}/briefs/1`)).body.brief
      .text,
    command.briefText,
  );
  const restored = await runtime.json<CreativeProjectMetadataMutationResponse>(
    `${base}/state`,
    {
      method: "PUT",
      body: {
        state: "active",
        expectedProjectRevision: archived.body.project.revision,
      },
      key: "restore-a",
    },
  );
  assert.equal(restored.status, 200);
  runtime.policy.revoked = true;
  assert.equal((await runtime.json(base)).status, 403);
  assert.equal(
    (
      await runtime.json(ROOT, {
        method: "POST",
        body: command,
        key: "create-owner-a",
      })
    ).status,
    403,
  );
  runtime.policy.revoked = false;

  const calls = runtime.calls.length;
  assert.equal((await runtime.json(`${base}/unknown`)).status, 404);
  assert.equal((await runtime.json(`${base}?principalId=forged`)).status, 400);
  assert.equal(runtime.calls.length, calls);
  const csrfMismatch = await runtime.browser.handle(
    new Request(`${publicOrigin}${ROOT}`, {
      method: "POST",
      body: JSON.stringify(command),
      headers: {
        "cookie": cookies[1]!,
        "origin": publicOrigin,
        "x-csrf-token": runtime.csrf[0]!,
        "content-type": "application/json",
        "idempotency-key": "csrf-mismatch",
      },
    }),
  );
  assert.equal(csrfMismatch.status, 403);
  assert.equal(runtime.calls.length, calls);

  await runtime.close();
  runtime = undefined;
  runtime = await start(databasePath);
  assert.deepEqual(
    (await runtime.json<GetCreativeProjectResponse>(base)).body.project,
    restored.body.project,
  );
  assert.deepEqual(
    (await runtime.json<GetProjectBriefResponse>(`${base}/briefs/1`)).body
      .brief,
    created.body.brief,
  );
  assert.deepEqual(
    (await runtime.json<GetConceptRevisionResponse>(`${assetBase}/revisions/1`))
      .body.assetRevision,
    concept.body.assetRevision,
  );
  assert.deepEqual(
    (await runtime.json<GetConceptRevisionResponse>(`${assetBase}/revisions/2`))
      .body.assetRevision,
    revised.body.assetRevision,
  );
  assert.deepEqual(
    (
      await runtime.json<ProjectBriefListResponse>(
        `${base}/briefs?afterBriefRevision=1`,
      )
    ).body.briefs,
    [brief.body.brief],
  );
  assert.deepEqual(
    (
      await runtime.json<ConceptRevisionListResponse>(
        `${assetBase}/revisions?afterAssetRevision=1`,
      )
    ).body.revisions,
    [revised.body.assetRevision],
  );
  const recoveredReplay =
    await runtime.json<CreativeProjectConceptMutationResponse>(
      `${assetBase}/revisions`,
      {
        method: "POST",
        key: "concept-a-2",
        body: {
          briefRevision: 2,
          prompt: "用户确认的第二版描述。",
          expectedProjectRevision: concept.body.project.revision,
          expectedAssetMetadataRevision: concept.body.asset.revision,
        },
      },
    );
  assert.equal(recoveredReplay.status, 200);
  assert.equal(recoveredReplay.body.disposition, "replayed");
  assert.deepEqual(
    recoveredReplay.body.assetRevision,
    revised.body.assetRevision,
  );
  assert.equal((await runtime.json(base, { account: 1 })).status, 404);
  // This is the metadata/input boundary only: no Thread, Run, operation, model, supplier or credit API exists in this fixture.
});
