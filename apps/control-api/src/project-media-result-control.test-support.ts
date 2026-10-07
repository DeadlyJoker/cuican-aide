import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import { ApplicationError } from "@crewon/application";
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
import { ControlApiClient } from "@crewon/control-client";
import { mediaResultFixture } from "../../runtime-worker/src/project-media-result-publisher.test-support.ts";
import { SystemProviderProbeDnsResolver } from "../../../packages/media-runtime/src/provider-probe-egress.ts";
import {
  PinnedNodeHttpTransport,
  type PinnedHttpRequest,
} from "../../../packages/media-runtime/src/pinned-node-http.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { InstalledProjectMediaResultRuntime } from "./installed-project-media-result-runtime.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { registerProjectMediaResultRoutes } from "./project-media-result-route.ts";
import { errorResponse } from "./control-api-errors.ts";

/** Real installed media handler, original Run, native stores/Core, archive and HTTP/client.
 * Identity/PDP and supplier DNS/socket bytes are explicit fixtures, not a live provider or full Agent loop. */
export async function mediaResultControlFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const f = await mediaResultFixture(t, backend, kind);
  const state = {
    profileId: f.pin.profileId,
    allowed: true,
    network: true,
    dns: 0,
    gets: 0,
    onGet: undefined as undefined | (() => Promise<void>),
  };
  t.mock.method(
    SystemProviderProbeDnsResolver.prototype,
    "resolveAll",
    async () => {
      state.dns++;
      return [{ address: "8.8.8.8", family: 4 }];
    },
  );
  t.mock.method(
    PinnedNodeHttpTransport.prototype,
    "request",
    async (request: PinnedHttpRequest) => {
      state.gets++;
      assert.equal(request.method, "GET");
      assert.equal(request.target.endpoint.pathname, "/view");
      assert.equal(request.target.address, "8.8.8.8");
      await state.onGet?.();
      return {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(f.state.bytes.length),
        },
        body: f.state.bytes,
      };
    },
  );
  const token = "named-results-control-" + "s".repeat(32),
    csrf = "named-results-control-" + "c".repeat(32),
    origin = "http://127.0.0.1:18479";
  const identity = new StandaloneIdentity({
    actor: f.actor,
    sessionToken: token,
    csrfToken: csrf,
    allowedOrigins: [origin],
  });
  const profiles = {
    resolve: async () => ({
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      profileId: state.profileId,
    }),
  };
  const opened: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const owner of opened.slice().reverse()) await owner.close();
  });
  const open = async (
    parent = f.parent,
    purposes: readonly ("read" | "publish")[] = ["read", "publish"],
  ) => {
    const requests = new InstalledPluginRequestOwner({
      identity: { resolveCurrentActor: (r) => identity.resolveActor(r) },
      profiles,
    });
    const core = await createInstalledPluginTaskRuntimeCore({
      store: parent,
      requests,
      installRoot: f.pluginRoot,
      maximumPackages: 4,
      publications: [
        { pluginId: f.pin.pluginId, packageDigest: f.pin.packageDigest },
      ],
      profiles,
      businessAuthorization: {
        authorize: async () => f.decision(state.allowed),
      },
      uiAuthorization: {
        authorize: async () => ({
          outcome: "allow",
          authorityEpoch: "named-result-control",
        }),
      },
      authorizePackage: async () => "allow",
      unmeteredTasks: {
        prepareGeneration: async () => {
          throw new Error("result_history_must_not_prepare_generation");
        },
      },
      clock: f.dependencies.clock,
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
      ...(purposes.includes("publish")
        ? {
            projectMediaGenerationStorage: {
              version: "crewon.project-media-generation-storage.v1" as const,
            },
          }
        : {}),
    });
    const active = () => {
      if (!state.allowed)
        throw new ApplicationError(
          "authorization",
          "named_result_control_revoked",
        );
    };
    const owner = await InstalledProjectMediaResultRuntime.prepare({
      core,
      configuration: {
        version: "crewon.project-media-results-control.v1",
        profileId: f.pin.profileId,
        purposes,
        reviews: f.reviews.map(({ targetIdentity, workflow }) => ({
          targetIdentity,
          workflow,
        })),
        authorization: {
          authorize: async () => f.decision(state.allowed),
          assertActive: active,
        },
        catalogAuthorization: {
          authorize: async () => f.decision(state.allowed),
          assertActive: active,
        },
        outputApproval: {
          assertCurrent: async () => {
            if (!state.network)
              throw new ApplicationError(
                "authorization",
                "named_output_grant_denied",
              );
          },
        },
        clock: f.dependencies.clock,
        createArchive: () =>
          new FilesystemProjectMediaResultArchive(f.archiveConfig),
      },
    });
    const app = Fastify();
    app.setErrorHandler((error, request, reply) => {
      const r = errorResponse(error, request.id);
      return reply.code(r.statusCode).send(r.body);
    });
    registerProjectMediaResultRoutes(app, { identity, owner });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await app.close();
      await owner.close();
      await core.close();
      await requests.close();
    };
    opened.push({ close });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const client = new ControlApiClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      accessToken: token,
      csrfToken: csrf,
      origin,
    });
    return { app, owner, core, requests, client, close };
  };
  const current = await open();
  const headers = {
    "authorization": `Bearer ${token}`,
    origin,
    "x-csrf-token": csrf,
  };
  const root = `/api/v1/creative-projects/${encodeURIComponent(f.query.projectId)}/media-results`;
  const path = root + `/${encodeURIComponent(f.query.runId)}/0`;
  const request = {
    method: "GET",
    url: path,
    remoteAddress: "127.0.0.1",
    headers,
  };
  return {
    ...f,
    ...current,
    controlState: state,
    openControl: open,
    headers,
    root,
    path,
    controlRequest: request,
  };
}
