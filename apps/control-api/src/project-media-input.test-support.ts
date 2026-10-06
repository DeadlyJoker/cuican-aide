import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import type {
  ActorContext,
  ProjectMediaInputPermission,
} from "@crewon/application";
import { projectMediaInputFixture } from "../../runtime-worker/src/project-media-input.test-support.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { registerProjectMediaInputRoutes } from "./project-media-input-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { parseSaveMediaInputRequest } from "@crewon/contracts/project-media-inputs";
import { selectionVerifier } from "../../../packages/store/src/project-concept-selection.test-support.ts";

/** Original SQLite/Pg records, actual TaskCore/request/identity and HTTP. Deployment/PDP are named fixtures.
 * No model, provider, native file approval or production plugin activation is claimed. */
export async function mediaInputControlFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await projectMediaInputFixture(t, backend),
    origin = "http://127.0.0.1:18479",
    csrf = "media-input-original-csrf-" + "c".repeat(32);
  const tokens = [0, 1, 2, 3].map(
    (n) => `media-input-session-${n}-` + "s".repeat(32),
  );
  const actors = [
    f.actor,
    { ...f.actor, principalId: "other-principal", actorId: "other-actor" },
    { ...f.actor, tenantId: "other-tenant" },
    { ...f.actor, spaceId: "other-space" },
  ];
  const identities = actors.map(
    (actor, n) =>
      new StandaloneIdentity({
        actor,
        sessionToken: tokens[n]!,
        csrfToken: csrf,
        allowedOrigins: [origin],
      }),
  );
  const identity = {
    resolveActor: async (
      request: import("./control-api-ports.ts").ControlApiRequestContext,
    ) => {
      const index = tokens.findIndex(
        (token) => request.headers.authorization === `Bearer ${token}`,
      );
      if (index < 0)
        throw new ControlApiIdentityError("authentication", "session_invalid");
      return identities[index]!.resolveActor(request);
    },
  };
  const state = {
    profileId: f.target.installation.profileId,
    quotes: 0,
    metadata: [] as ProjectMediaInputPermission[],
    revoked: false,
    beforeMetadata: undefined as
      | undefined
      | ((permission: ProjectMediaInputPermission) => Promise<void>),
    projectReads: 0,
    errors: [] as string[],
    beforeConfiguration: undefined as undefined | (() => Promise<void>),
  };
  const owners: {
    core: Awaited<ReturnType<typeof createInstalledPluginTaskRuntimeCore>>;
    requests: InstalledPluginRequestOwner;
    app: ReturnType<typeof Fastify>;
  }[] = [];
  t.after(async () => {
    for (const owner of [...owners].reverse()) {
      await owner.app.close();
      await owner.core.close();
      await owner.requests.close();
    }
  });
  const open = async (parent = f.parent) => {
    const profiles = {
      resolve: async (actor: ActorContext) => ({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: state.profileId,
      }),
    };
    const requests = new InstalledPluginRequestOwner({
      identity: {
        resolveCurrentActor: async (request) => identity.resolveActor(request),
      },
      profiles,
    });
    const configuration = {
      version: "crewon.project-media-input-control.v1" as const,
      reviews: f.reviews,
      authorization: {
        authorize: async (permission: ProjectMediaInputPermission) => {
          state.metadata.push(permission);
          await state.beforeMetadata?.(permission);
          return f.mediaAuthorization.authorize(permission);
        },
        assertActive: (permission: ProjectMediaInputPermission) => {
          if (state.revoked)
            throw new Error("named_media_metadata_approval_retired");
          f.mediaAuthorization.assertActive(permission);
        },
      },
      projects: {
        authorize: async () => {
          state.projectReads++;
          return f.decision(f.policy.allow);
        },
      },
      installations: {
        authorize: async () => f.decision(f.state.installationAllowed),
      },
      verifier: selectionVerifier,
    };
    const input = {
      store: parent,
      requests,
      installRoot: f.root,
      maximumPackages: 4,
      publications: [
        {
          pluginId: "crewon.short-drama",
          packageDigest: f.reviewedTarget.packageDigest,
        },
      ],
      profiles,
      businessAuthorization: {
        authorize: async () => {
          await state.beforeConfiguration?.();
          return f.decision(f.state.configurationAllowed);
        },
      },
      uiAuthorization: {
        authorize: async () => ({
          outcome: "allow" as const,
          authorityEpoch: "named-media-ui-epoch",
        }),
      },
      authorizePackage: async () => "allow" as const,
      creditQuotes: {
        quoteGeneration: async () => {
          state.quotes++;
          throw new Error("media-input-must-never-request-funding");
        },
      },
      clock: f.dependencies.clock,
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
      projectMediaInputs: configuration,
    };
    const core = await createInstalledPluginTaskRuntimeCore(input);
    assert.ok(core.projectMediaInputs);
    const app = Fastify();
    app.setErrorHandler((error, request, reply) => {
      state.errors.push(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      );
      const response = errorResponse(error, request.id);
      return reply.code(response.statusCode).send(response.body);
    });
    registerProjectMediaInputRoutes(app, {
      identity,
      owner: core.projectMediaInputs,
    });
    const owner = { core, requests, app };
    owners.push(owner);
    return { ...owner, configuration, input };
  };
  const opened = await open();
  const command = (kind: "T10" | "D18" = "T10") => {
    const { target, ...input } = kind === "T10" ? f.command : f.d18Command;
    return parseSaveMediaInputRequest({
      ...input,
      configurationRevision: target.configurationRevision,
    });
  };
  const headers = (key = command().idempotencyKey, account = 0) => ({
    "authorization": `Bearer ${tokens[account]}`,
    origin,
    "x-csrf-token": csrf,
    "idempotency-key": key,
  });
  const root = `/api/v1/creative-projects/${encodeURIComponent(f.query.projectId)}/media-inputs`;
  const save = (app = opened.app, value = command(), overrides = {}) => {
    const { projectId, idempotencyKey, ...body } = value;
    return app.inject({
      method: "POST",
      url: `/api/v1/creative-projects/${encodeURIComponent(projectId)}/media-inputs`,
      headers: { ...headers(idempotencyKey), ...overrides },
      payload: body,
    });
  };
  const noExecution = async () => {
    assert.equal(state.quotes, 0);
    assert.equal(f.state.sourceGets, 0);
    assert.equal(f.state.uploads, 0);
    assert.equal(f.state.targetGets, 0);
    assert.deepEqual(await f.counts(), before);
  };
  const before = await f.counts();
  return {
    ...f,
    ...opened,
    controlState: state,
    identity,
    open,
    command,
    headers,
    root,
    save,
    noExecution,
    actors,
  };
}
