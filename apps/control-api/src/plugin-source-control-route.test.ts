import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ApplicationError } from "@crewon/application";
import { parsePluginSourceListResponse } from "@crewon/contracts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { createProductionPluginSourceRegistry } from "./production-plugin-source-registry.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import {
  pluginRouteActor,
  pluginRouteCredentials,
  pluginRouteHeaders,
} from "./plugin-control-route.test-support.ts";

test("sources route returns exact approved real-file metadata with bounded paging and existing request identity", async (t) => {
  const f = await productionSourceFixture(t);
  const a = await f.source("source-a");
  const b = await f.source("source-b", { version: "2.0.0" });
  const registry = await createProductionPluginSourceRegistry(
    f.configuration([b, a]),
  );
  const app = Fastify();
  t.after(() => app.close());
  let reads = 0;
  let denied = false;
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    reply.code(result.statusCode).send(result.body);
  });
  registerPluginControlRoutes(app, {
    identity: new StandaloneIdentity({
      actor: pluginRouteActor,
      sessionToken: pluginRouteCredentials.sessionToken,
      csrfToken: pluginRouteCredentials.csrfToken,
      allowedOrigins: [pluginRouteCredentials.origin],
    }),
    pluginSources: {
      async listSources(actor, query) {
        assert.deepEqual(actor, pluginRouteActor);
        reads++;
        if (denied)
          throw new ApplicationError(
            "authorization",
            "test_source_read_denied",
          );
        const all = registry
          .list()
          .filter(
            (item) =>
              query.afterSourceId === null ||
              item.sourceId > query.afterSourceId,
          );
        const sources = all.slice(0, query.limit);
        return parsePluginSourceListResponse(
          {
            sources,
            next: all.length > query.limit ? sources.at(-1)!.sourceId : null,
          },
          query,
        );
      },
    },
  });
  const first = await app.inject({
    url: "/api/v1/plugins/sources?limit=1",
    headers: pluginRouteHeaders,
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().next, "source-a");
  assert.equal(first.json().sources[0].title, a.descriptor.title);
  assert.ok(!first.body.includes(f.root));
  assert.ok(!first.body.includes("directory"));
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.headers["x-content-type-options"], "nosniff");
  const second = await app.inject({
    url: "/api/v1/plugins/sources?limit=1&afterSourceId=source-a",
    headers: pluginRouteHeaders,
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().next, null);
  assert.equal(second.json().sources[0].sourceId, "source-b");
  const empty = await app.inject({
    url: "/api/v1/plugins/sources?afterSourceId=source-b",
    headers: pluginRouteHeaders,
  });
  assert.deepEqual(empty.json(), { sources: [], next: null });
  const before = reads;
  for (const query of [
    "limit=51",
    "limit=01",
    "limit=1&limit=2",
    "owner=other",
    "sourceId=/private/source",
  ])
    assert.equal(
      (
        await app.inject({
          url: `/api/v1/plugins/sources?${query}`,
          headers: pluginRouteHeaders,
        })
      ).statusCode,
      400,
    );
  assert.equal(reads, before);
  assert.equal(
    (await app.inject({ url: "/api/v1/plugins/sources" })).statusCode,
    401,
  );
  assert.equal(reads, before);
  denied = true;
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/plugins/sources",
        headers: pluginRouteHeaders,
      })
    ).statusCode,
    403,
  );
});
test("sources stays absent without explicit service and corrupt/private service output never reaches renderer", async (t) => {
  const identity = new StandaloneIdentity({
    actor: pluginRouteActor,
    sessionToken: pluginRouteCredentials.sessionToken,
    csrfToken: pluginRouteCredentials.csrfToken,
    allowedOrigins: [pluginRouteCredentials.origin],
  });
  const absent = Fastify();
  t.after(() => absent.close());
  registerPluginControlRoutes(absent, { identity });
  assert.equal(
    (
      await absent.inject({
        url: "/api/v1/plugins/sources",
        headers: pluginRouteHeaders,
      })
    ).statusCode,
    404,
  );
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    reply.code(result.statusCode).send(result.body);
  });
  registerPluginControlRoutes(app, {
    identity,
    pluginSources: {
      async listSources() {
        return {
          sources: [{ directory: "/private/secret" }],
          next: null,
        } as never;
      },
    },
  });
  const response = await app.inject({
    url: "/api/v1/plugins/sources",
    headers: pluginRouteHeaders,
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, "plugin_control_response_invalid");
  assert.ok(!response.body.includes("/private/secret"));
});
