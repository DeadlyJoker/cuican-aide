import type { TestContext } from "node:test";
import Fastify from "fastify";
import {
  OfficeApplicationService,
  OfficeThreadApplicationService,
  ThreadApplicationService,
  type ActorContext,
  type AuthorizationAction,
  type AuthorizationPort,
  type DomainStore,
} from "@crewon/application";
import type { OfficeDefinition } from "@crewon/domain";
import { InMemoryRunStore } from "@crewon/store";
import { ControlApiClient } from "@crewon/control-client";
import {
  NodeSha256ContentDigester,
  StandaloneIdentity,
} from "./standalone-adapters.ts";
import { errorResponse } from "./control-api-errors.ts";
import { registerOfficeThreadRoutes } from "./office-thread-route.ts";

export const officeActor: ActorContext = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};
export const definition: OfficeDefinition = {
  schemaVersion: "crewon.office-definition.v0",
  tenantId: officeActor.tenantId,
  spaceId: officeActor.spaceId,
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 1,
  title: "Delivery",
  members: [
    { memberId: "member-1", displayName: "Agent", agentVersionId: "agent-1" },
  ],
  executionTargets: [{ targetId: "primary", agentVersionId: "agent-1" }],
  createdByActorId: officeActor.actorId,
  createdAt: "2026-09-14T00:00:00.000Z",
};
const session = "office-route-session-".repeat(3);
const csrf = "office-route-csrf-".repeat(3);
export const officeHeaders = {
  "authorization": `Bearer ${session}`,
  "origin": "http://office.test",
  "x-csrf-token": csrf,
  "idempotency-key": "office-create-1",
};
export async function officeRouteFixture(
  t: TestContext,
  suppliedStore?: DomainStore,
) {
  const store = suppliedStore ?? new InMemoryRunStore();
  let sequence = 0;
  let denied: AuthorizationAction | null = null;
  const authorizationRequests: Parameters<AuthorizationPort["authorize"]>[0][] =
    [];
  const authorization: AuthorizationPort = {
    async authorize(request) {
      authorizationRequests.push(request);
      return request.action === denied
        ? { outcome: "deny", reasonCode: "test-denied" }
        : { outcome: "allow" };
    },
  };
  const clock = { now: () => "2026-09-14T00:00:01.000Z" };
  const ids = { nextId: (kind: string) => `${kind}-${++sequence}` };
  const offices = new OfficeApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester: new NodeSha256ContentDigester(),
  });
  const threads = new ThreadApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester: new NodeSha256ContentDigester(),
  });
  const officeThreads = new OfficeThreadApplicationService({
    store,
    authorization,
    clock,
    ids,
    offices,
    threads,
    digester: new NodeSha256ContentDigester(),
  });
  const seedOffice = async (value = definition) =>
    store.commitOfficeDefinition({
      definition: value,
      expectedRevision: value.revision - 1,
      receipt: {
        actorId: value.createdByActorId,
        idempotencyKey: `seed:${value.officeVersionId}`,
        requestDigest: `digest:${value.officeVersionId}`,
      },
    });
  if (
    !(await store.loadOfficeDefinition({
      tenantId: officeActor.tenantId,
      spaceId: officeActor.spaceId,
      officeVersionId: definition.officeVersionId,
    }))
  )
    await seedOffice();
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const response = errorResponse(error, request.id);
    return reply.code(response.statusCode).send(response.body);
  });
  registerOfficeThreadRoutes(app, {
    officeThreads,
    identity: new StandaloneIdentity({
      actor: officeActor,
      sessionToken: session,
      csrfToken: csrf,
      allowedOrigins: [officeHeaders.origin],
    }),
  });
  await app.ready();
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await app.close();
      await store.close();
    }
  };
  t.after(close);
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push(`${init.method ?? "GET"} ${url.pathname}`);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const result = await app.inject({
      method: init.method === "POST" ? "POST" : "GET",
      url: url.pathname + url.search,
      headers,
      ...(init.body === undefined ? {} : { payload: String(init.body) }),
      remoteAddress: "127.0.0.1",
    });
    return new Response(result.body, {
      status: result.statusCode,
      headers: { "content-type": "application/json" },
    });
  };
  const makeClient = (transport = fetch) =>
    new ControlApiClient({
      baseUrl: officeHeaders.origin,
      accessToken: session,
      csrfToken: csrf,
      origin: officeHeaders.origin,
      fetch: transport,
    });
  return {
    app,
    store,
    threads,
    offices,
    officeThreads,
    seedOffice,
    authorizationRequests,
    client: makeClient(),
    makeClient,
    fetch,
    requests,
    close,
    deny: (action: AuthorizationAction | null) => {
      denied = action;
    },
  };
}
