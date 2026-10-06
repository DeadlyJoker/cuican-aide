import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import {
  ApplicationError,
  ProjectMediaInputStageApplicationService,
} from "@crewon/application";
import type { ProjectMediaInputStageRequest } from "@crewon/contracts/project-media-input-stages";
import { errorResponse } from "./control-api-errors.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { ProjectMediaInputStageControlOwner } from "./project-media-input-stage-control-owner.ts";
import { registerProjectMediaInputStageRoutes } from "./project-media-input-stage-route.ts";
import type { mediaInputWorkerFixture } from "../../runtime-worker/src/project-media-input-worker.test-support.ts";

type Admission = NonNullable<
  NonNullable<Parameters<typeof mediaInputWorkerFixture>[3]>["admitStage"]
>;
export const mediaStageHeaders = (key = "public-media-stage") => ({
  "authorization": "Bearer public-media-stage-session-long-enough",
  "origin": "crewon://desktop",
  "x-csrf-token": "public-media-stage-csrf-long-enough",
  "idempotency-key": key,
});
/** Real public owner, HTTP, installed bytes/Node declarations and native task commit; named identity/PDP/peer readiness boundary. */
export async function publicMediaStageFixture(
  t: TestContext,
  input: Parameters<Admission>[0],
) {
  const {
    fixture: f,
    binding,
    conversations,
    stages,
    threadService,
    stage,
    content,
    installRoot,
  } = input;
  const scope = {
    tenantId: f.pin.tenantId,
    spaceId: f.pin.spaceId,
    profileId: f.pin.profileId,
  };
  const state = {
    project: true,
    ui: true,
    package: true,
    identity: true,
    prepares: 0,
    wakes: 0,
  };
  const identity = new StandaloneIdentity({
    actor: f.actor,
    sessionToken: mediaStageHeaders().authorization.slice(7),
    csrfToken: mediaStageHeaders()["x-csrf-token"],
    allowedOrigins: ["crewon://desktop"],
  });
  const requests = new InstalledPluginRequestOwner({
    identity: {
      resolveCurrentActor: async (context, signal) => {
        signal.throwIfAborted();
        if (!state.identity)
          throw new ApplicationError(
            "authorization",
            "named_identity_withdrawn",
          );
        return identity.resolveActor(context);
      },
    },
    profiles: { resolve: async () => scope },
    peer: {
      prepare: async () => {
        state.prepares++;
        return {
          catalog: {
            list: () => [f.registration],
            resolve: () => f.registration,
          },
          host: {
            validateConfiguration: async () => {
              throw Error("unused_named_peer");
            },
            evaluate: async () => {
              throw Error(
                "named_peer_readiness_not_used_by_fixture_task_service",
              );
            },
          },
          pluginQueryHost: {
            resolveRegistration: async () => {
              throw Error("unused_named_peer");
            },
            evaluate: async () => {
              throw Error("input_stage_must_not_query_provider");
            },
          },
        };
      },
    },
  });
  let admitted: Awaited<ReturnType<Admission>> | undefined;
  const service = new ProjectMediaInputStageApplicationService({
    conversations,
    stages,
    threadStore: f.parent,
    projects: f.parent.creativeProjectStore(),
    texts: f.parent.projectTextStore(),
    digester: f.digester,
    authorization: {
      authorize: async () =>
        state.project
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_project_denied" },
    },
    tasks: {
      createProjectMediaInputStageTurnFromHost: async (...args) => {
        admitted = await f.service.createProjectMediaInputStageTurnFromHost(
          ...args,
        );
        return admitted;
      },
    },
  });
  const owner = new ProjectMediaInputStageControlOwner({
    service,
    conversations,
    configuration: {
      version: "crewon.project-media-input-stages.v1",
      publications: [
        {
          pluginId: f.pin.pluginId,
          packageDigest: f.pin.packageDigest,
          contributionId: "workbench",
        },
      ],
    },
    installations: f.parent.pluginInstallationStore(),
    requests,
    installRoot,
    authorization: {
      authorize: async () =>
        state.ui
          ? { outcome: "allow", authorityEpoch: f.pin.authorityEpoch }
          : { outcome: "deny", reasonCode: "named_ui_denied" },
    },
    authorizePackage: async () => (state.package ? "allow" : "deny"),
    assertExternal: () => {
      if (!state.identity)
        throw new ApplicationError("authorization", "named_identity_withdrawn");
    },
  });
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerProjectMediaInputStageRoutes(app, {
    identity,
    owner,
    threads: threadService,
    outboxWakeup: {
      wake: async () => {
        state.wakes++;
      },
    },
  });
  t.after(async () => {
    await app.close();
    await owner.close();
    await requests.close();
  });
  const request: ProjectMediaInputStageRequest = {
    projectId: binding.projectId,
    threadId: binding.threadId,
    expectedThreadRevision: 1,
    expectedBindingRevision: 1,
    stage,
    content,
    idempotencyKey: "public-media-stage",
  };
  const url = `/api/v1/threads/${binding.threadId}/project-media-input-stage`;
  const post = (payload: unknown = request, key = request.idempotencyKey) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        ...mediaStageHeaders(key),
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  return {
    app,
    owner,
    requests,
    state,
    request,
    url,
    post,
    get: () => app.inject({ method: "GET", url, headers: mediaStageHeaders() }),
    admitted: () => {
      assert.ok(admitted);
      return admitted;
    },
  };
}
