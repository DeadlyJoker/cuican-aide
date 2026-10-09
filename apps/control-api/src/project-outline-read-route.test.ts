import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ProjectStructuredOutlineApplicationService } from "@crewon/application";
import { MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES } from "@crewon/contracts/project-outlines";
import {
  structuredOutlineFixture,
  candidate,
  selection,
  actor,
  time,
  digester,
  longOutlineDocument,
} from "../../../packages/store/src/project-structured-outline.test-support.ts";
import { registerProjectOutlineReadRoutes } from "./project-outline-read-route.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { errorResponse } from "./control-api-errors.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} authenticated outline reads page complete structured content and preserve candidate selection`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await structuredOutlineFixture(
        t,
        backend,
        longOutlineDocument(),
      );
      let denied = false;
      const service = new ProjectStructuredOutlineApplicationService({
        store: f.first.text,
        projects: f.first.projects,
        foundations: f.foundations,
        authorization: {
          authorize: async () =>
            denied
              ? { outcome: "deny", reasonCode: "outline-access-withdrawn" }
              : { outcome: "allow" },
        },
        clock: { now: () => time(5) },
        ids: { nextId: () => "http-outline" },
        digester,
      });
      const saved = await f.first.text.commitStructuredOutlineCandidate(
        candidate(f, "first"),
      );
      const chosen = await f.first.text.commitStructuredOutlineSelection(
        selection(
          f,
          "chosen",
          saved.artifact,
          saved.contentRevision! as Parameters<typeof selection>[3],
        ),
      );
      await f.first.text.commitStructuredOutlineCandidate(
        candidate(f, "second", chosen.artifact),
      );
      const app = Fastify();
      t.after(() => app.close());
      app.setErrorHandler((error, request, reply) => {
        const result = errorResponse(error, request.id);
        return reply.code(result.statusCode).send(result.body);
      });
      const token = "outline-http-session-32-byte-minimum";
      const identity = new StandaloneIdentity({
        actor,
        sessionToken: token,
        csrfToken: "outline-csrf-actual-32-byte-minimum",
        allowedOrigins: ["crewon://desktop"],
      });
      const foreignToken = "outline-http-foreign-32-byte-minimum";
      const foreign = new StandaloneIdentity({
        actor: {
          ...actor,
          principalId: "another-principal",
          actorId: "another-actor",
        },
        sessionToken: foreignToken,
        csrfToken: "outline-csrf-actual-32-byte-minimum",
        allowedOrigins: ["crewon://desktop"],
      });
      registerProjectOutlineReadRoutes(app, {
        identity: {
          resolveActor: (context) =>
            context.headers.authorization === `Bearer ${foreignToken}`
              ? foreign.resolveActor(context)
              : identity.resolveActor(context),
        },
        outlines: service,
      });
      const headers = {
        authorization: `Bearer ${token}`,
        origin: "crewon://desktop",
      };
      const root = `/api/v2/creative-projects/${encodeURIComponent(f.created.project.projectId)}/outline`;
      const get = (suffix = "", authenticated = true) =>
        app.inject({
          method: "GET",
          url: root + suffix,
          headers: authenticated ? headers : {},
        });
      const meta = await get();
      assert.equal(meta.statusCode, 200, meta.body);
      const view = meta.json().view;
      assert.equal(view.latestRevision.contentRevision, 2);
      assert.equal(view.selectedRevision.contentRevision, 1);
      assert.equal(view.selectedRevision.format, "structured-v2");
      const episodes = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const query: URLSearchParams = new URLSearchParams({
          artifactId: view.artifact.artifactId,
          contentRevision: "1",
          contentDigest: view.selectedRevision.contentDigest,
          section: "episodes",
          afterIndex: String(cursor),
          limit: "10",
        });
        const page = await get("/sections?" + query);
        assert.equal(page.statusCode, 200, page.body);
        assert.ok(
          Buffer.byteLength(page.body) <= MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES,
        );
        const body = page.json();
        episodes.push(...body.items);
        cursor = body.nextIndex;
        const substituted: URLSearchParams = new URLSearchParams(query);
        substituted.set("contentDigest", "sha256:" + "b".repeat(64));
        assert.equal((await get("/sections?" + substituted)).statusCode, 409);
      }
      assert.deepEqual(episodes, f.document.episodes);
      const history = await get(
        "/revisions?" +
          new URLSearchParams({
            artifactId: view.artifact.artifactId,
            afterContentRevision: "0",
            limit: "10",
          }),
      );
      assert.equal(history.statusCode, 200, history.body);
      assert.equal(history.json().revisions.length, 2);
      assert.equal((await get("", false)).statusCode, 401);
      assert.ok(
        [403, 404].includes(
          (
            await app.inject({
              method: "GET",
              url: root,
              headers: { ...headers, authorization: `Bearer ${foreignToken}` },
            })
          ).statusCode,
        ),
      );
      denied = true;
      assert.equal((await get()).statusCode, 403);
      denied = false;
      for (const suffix of [
        "?owner=another",
        "/sections?contentRevision=01",
        "/revisions?projectId=other",
        "/revisions?limit=11",
      ])
        assert.equal((await get(suffix)).statusCode, 400);
      assert.equal(
        (await app.inject({ method: "POST", url: root, headers })).statusCode,
        404,
      );
      assert.equal(
        (await service.getOutline(actor, {
          projectId: f.created.project.projectId,
        }))!.artifact.selectedContentRevision,
        1,
      );
    },
  );
}
