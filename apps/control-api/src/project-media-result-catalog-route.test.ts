import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  ApplicationError,
  ProjectMediaResultCatalogApplicationService,
} from "@crewon/application";
import { ControlApiClient } from "@crewon/control-client";
import { mediaResultFixture } from "../../runtime-worker/src/project-media-result-publisher.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { registerProjectMediaResultCatalogRoutes } from "./project-media-result-catalog-route.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { errorResponse } from "./control-api-errors.ts";
const options = () => ({ signal: new AbortController().signal });
for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: original HTTP/client lists saved candidates and cold history without generation or adoption`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaResultFixture(t, backend, kind);
        const before = await f.referenceSource();
        const first = await f.publisher.publish(f.actor, f.query, options());
        const second = await f.publisher.publish(
          f.actor,
          { ...f.query, resultIndex: 1 },
          options(),
        );
        const expected = [first.candidate, second.candidate].sort((a, b) =>
          a.candidateId < b.candidateId ? -1 : 1,
        );
        let allowed = true;
        const service = new ProjectMediaResultCatalogApplicationService({
          store: f.store,
          authorization: {
            authorize: async (p) => {
              assert.equal(p.action, "projectMediaResult:list");
              return f.decision(allowed);
            },
            assertActive: () => {
              if (!allowed)
                throw new ApplicationError(
                  "authorization",
                  "named_catalog_read_revoked",
                );
            },
          },
        });
        t.after(() => service.close());
        const token = "named-result-session-" + "s".repeat(32),
          origin = "http://127.0.0.1:18479";
        const identity = new StandaloneIdentity({
          actor: f.actor,
          sessionToken: token,
          csrfToken: "named-result-csrf-" + "c".repeat(32),
          allowedOrigins: [origin],
        });
        const app = Fastify();
        app.setErrorHandler((error, request, reply) => {
          const r = errorResponse(error, request.id);
          void reply.code(r.statusCode).send(r.body);
        });
        registerProjectMediaResultCatalogRoutes(app, { identity, service });
        t.after(() => app.close());
        const root = `/api/v1/creative-projects/${encodeURIComponent(f.query.projectId)}/media-results`;
        const headers = { authorization: `Bearer ${token}`, origin };
        const read = (suffix = "", h = headers) =>
          app.inject({ method: "GET", url: root + suffix, headers: h });
        assert.equal(
          (await read("", { ...headers, authorization: "" })).statusCode,
          401,
        );
        assert.equal(
          (await read("", { ...headers, origin: "https://foreign.test" }))
            .statusCode,
          403,
        );
        for (const suffix of [
          "?limit=0",
          "?limit=17",
          "?limit=01",
          "?limit=1.0",
          "?limit=1&limit=2",
          "?afterCandidateId=",
          "?afterCandidateId=a&afterCandidateId=b",
          "?actor=other",
          `?afterCandidateId=${"x".repeat(129)}`,
        ])
          assert.equal((await read(suffix)).statusCode, 400, suffix);
        assert.equal(
          (await app.inject({ method: "HEAD", url: root, headers })).statusCode,
          404,
        );
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        assert.ok(address && typeof address !== "string");
        const client = new ControlApiClient({
          baseUrl: `http://127.0.0.1:${address.port}`,
          accessToken: token,
          csrfToken: null,
          origin,
        });
        const q = {
          projectId: f.query.projectId,
          afterCandidateId: null,
          limit: 1,
        };
        const page = await client.projectMediaResults.listCandidates(q);
        assert.equal(page.candidates[0]!.candidateId, expected[0]!.candidateId);
        assert.equal(page.candidates[0]!.runId, f.query.runId);
        assert.equal(
          page.candidates[0]!.inputRevision,
          f.task.reference.inputRevision,
        );
        assert.deepEqual(
          page.candidates[0]!.item,
          expected[0]!.frozen.source.projection.item,
        );
        const next = await client.projectMediaResults.listCandidates({
          ...q,
          afterCandidateId: page.nextCandidateId,
        });
        assert.equal(next.candidates[0]!.candidateId, expected[1]!.candidateId);
        assert.equal(next.nextCandidateId, null);
        const response = await read();
        assert.equal(response.headers["cache-control"], "no-store");
        const body = response.json();
        assert.equal(body.candidates.length, 2);
        for (const secret of [
          "targetIdentity",
          "configuration",
          "filename",
          "archiveId",
          "principalId",
          "https://",
        ])
          assert.ok(!response.body.includes(secret), secret);
        const actualBefore = [
          f.state.gets,
          f.state.dns,
          f.controls.posts,
          await f.count(),
          ...f.materialCounts(),
        ];
        assert.deepEqual(
          (
            await service.listCandidates(
              { ...f.actor, actorId: "other-owned-actor" },
              { ...q, limit: 16 },
              options(),
            )
          ).candidates,
          body.candidates,
        );
        const cold = await f.cold(),
          child = cold.ext.projectMediaResults();
        await child.enableCatalogReads();
        assert.equal(child.version, undefined);
        await assert.rejects(
          child.loadCandidate(f.request, f.authority()),
          /project_media_result_unavailable/u,
        );
        await assert.rejects(
          child.saveCandidate(first.candidate, f.authority("publish")),
          /project_media_result_unavailable/u,
        );
        const reopened = new ProjectMediaResultCatalogApplicationService({
          store: child,
          authorization: {
            authorize: async () => f.decision(true),
            assertActive: () => {},
          },
        });
        t.after(() => reopened.close());
        assert.deepEqual(
          await reopened.listCandidates(
            f.actor,
            { ...q, limit: 16 },
            options(),
          ),
          body,
        );
        assert.deepEqual(await f.referenceSource(), before);
        const project = await f.projects.getProject(f.actor, {
          projectId: q.projectId,
        });
        await f.projects.setProjectState(f.actor, {
          projectId: project.projectId,
          expectedProjectRevision: project.revision,
          state: "archived",
          idempotencyKey: "catalog-history-after-archive",
        });
        assert.deepEqual(
          await reopened.listCandidates(
            f.actor,
            { ...q, limit: 16 },
            options(),
          ),
          body,
        );
        allowed = false;
        assert.equal((await read()).statusCode, 403);
        await assert.rejects(client.projectMediaResults.listCandidates(q));
        assert.deepEqual(
          [
            f.state.gets,
            f.state.dns,
            f.controls.posts,
            await f.count(),
            ...f.materialCounts(),
          ],
          actualBefore,
        );
      },
    );
  test(
    `${backend}: catalog denies foreign owners and cancellation; close joins pending reads`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaResultFixture(t, backend);
      await f.publisher.publish(f.actor, f.query, options());
      let hook = async () => {};
      let allow = true;
      const service = new ProjectMediaResultCatalogApplicationService({
        store: f.store,
        authorization: {
          authorize: async () => {
            await hook();
            return f.decision(allow);
          },
          assertActive: () => {},
        },
      });
      t.after(() => service.close());
      const q = {
        projectId: f.query.projectId,
        afterCandidateId: null,
        limit: 16,
      };
      for (const actor of [
        { ...f.actor, tenantId: "foreign" },
        { ...f.actor, spaceId: "foreign" },
        { ...f.actor, principalId: "foreign" },
      ])
        await assert.rejects(service.listCandidates(actor, q, options()));
      await assert.rejects(
        service.listCandidates(
          f.actor,
          { ...q, projectId: "foreign-project" },
          options(),
        ),
      );
      await assert.rejects(
        service.listCandidates(f.actor, q, { signal: AbortSignal.abort() }),
      );
      allow = false;
      await assert.rejects(
        service.listCandidates(f.actor, q, options()),
        /project_media_result_denied/u,
      );
      allow = true;
      const entered = deferred(),
        release = deferred();
      hook = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = service.listCandidates(f.actor, q, options());
      const rejected = assert.rejects(pending);
      await entered.promise;
      let closed = false;
      const closing = service.close().then(() => {
        closed = true;
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(closed, false);
      release.resolve();
      await rejected;
      await closing;
      await assert.rejects(service.listCandidates(f.actor, q, options()));
      assert.equal(f.state.gets, 1);
      assert.equal(f.controls.posts, 1);
    },
  );
  test(
    `${backend}: catalog startup verifies existing schema without silently creating candidate tables`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaResultFixture(t, backend, "T10", { migrate: false });
      await assert.rejects(f.store.enableCatalogReads());
      assert.equal(f.store.version, undefined);
      await f.store.migrate();
      const request = {
        actor: f.actor,
        query: {
          projectId: f.query.projectId,
          afterCandidateId: null,
          limit: 16,
        },
      };
      assert.throws(
        () =>
          f.store.listCandidates(request, {
            request: {
              ...request,
              actor: { ...f.actor, principalId: "foreign" },
            },
            action: "list",
            assertCurrent: async () => {},
            assertActive: () => {},
          }),
        /authority_invalid/u,
      );
      const authority = {
        request,
        action: "list" as const,
        assertCurrent: async () => {},
        assertActive: () => {},
      };
      assert.deepEqual(await f.store.listCandidates(request, authority), {
        candidates: [],
        nextCandidateId: null,
      });
      assert.equal(f.state.gets, 0);
    },
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
