import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import { join } from "node:path";
import { createProjectMediaMaterialRuntime } from "@crewon/media-runtime/project-media-material-runtime";
import { materialRuntimeFixtureInput } from "../../runtime-worker/src/project-media-material-runtime.test-support.ts";
import { selectionVerifier } from "../../../packages/store/src/project-concept-selection.test-support.ts";
import { mediaGenerationControlFixture } from "./project-media-generation-control.test-support.ts";
import { InstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";
import type {
  InstalledProjectMediaGenerationConfiguration,
  ProjectMediaGenerationMaterialScope,
} from "./installed-project-media-generation-configuration.ts";
import { registerProjectMediaGenerationRoutes } from "./project-media-generation-route.ts";
import { errorResponse } from "./control-api-errors.ts";

/** Real original parent, Core, encrypted material archive and HTTP handler. Network/readiness/PDP are named fixtures. */
export async function mediaGenerationRuntimeFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const f = await mediaGenerationControlFixture(t, backend, kind);
  const state = { created: 0, closed: 0, wakes: 0, materialChecks: 0 };
  let materialScope: ProjectMediaGenerationMaterialScope;
  const configuration: InstalledProjectMediaGenerationConfiguration = {
    version: "crewon.project-media-generation-control.v1",
    profileId: f.pin.profileId,
    reviews: f.generationReviews,
    metadataAuthorization: f.mediaAuthorization,
    authorization: f.generationAuthorization,
    verifier: selectionVerifier,
    createMaterials: async (scope) => {
      assert.equal(scope.store, f.parent);
      state.created++;
      materialScope = scope;
      const base = materialRuntimeFixtureInput(f, {
        archiveId: "real-control-material-archive",
        rootDirectory: join(f.installRoot, "media-archive"),
        keyId: "named-control-material-key",
        encryptionKey: Buffer.alloc(32, 87),
      });
      const runtime = await createProjectMediaMaterialRuntime({
        ...base,
        store: scope.store,
        configurations: f.core.extensions,
        signal: scope.signal,
        reviews: f.generationReviews,
        metadata: scope.metadataAuthorization,
        profiles: {
          resolve: async (actor) => {
            await scope.assertTransactionCurrent(actor);
            return f.requests.currentScope();
          },
        },
        projects: {
          authorize: async (p) => {
            await scope.assertTransactionCurrent(p.actor);
            return base.projects.authorize(p);
          },
        },
        installations: {
          authorize: async (p) => {
            await scope.assertTransactionCurrent(p.actor);
            return base.installations.authorize(p);
          },
        },
        read: {
          authorize: async (p) => {
            await scope.assertCurrent(p.actor);
            return base.read.authorize(p);
          },
        },
        freeze: {
          authorize: async (p) => {
            await scope.assertCurrent(p.actor);
            return base.freeze.authorize(p);
          },
        },
        preparation: {
          authorize: async (p) => {
            state.materialChecks++;
            const current =
              p.action === "projectMaterial:prepare"
                ? scope.assertTransactionCurrent
                : scope.assertCurrent;
            await current(p.actor);
            const result = await f.dependencies.authorization.authorize(p);
            await current(p.actor);
            return result;
          },
          assertActive: (p) => {
            scope.assertActive(p.request.source.actor);
            f.dependencies.authorization.assertActive(p);
          },
        },
      });
      return {
        materials: runtime.materials,
        close: async () => {
          await runtime.close();
          state.closed++;
        },
      };
    },
  };
  const owner = await InstalledProjectMediaGenerationRuntime.prepare({
    core: f.core,
    configuration,
  });
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerProjectMediaGenerationRoutes(app, {
    identity: f.identity,
    owner,
    outboxWakeup: {
      wake: async () => {
        state.wakes++;
      },
    },
  });
  t.after(async () => {
    await app.close();
    await owner.close();
  });
  const url = `/api/v1/creative-projects/${f.command.projectId}/media-generations`;
  const { projectId: _, idempotencyKey, ...body } = f.command;
  const headers = { ...f.request.headers, "idempotency-key": idempotencyKey };
  const post = (
    changes: { headers?: typeof headers; url?: string; body?: unknown } = {},
  ) =>
    app.inject({
      method: "POST",
      url: changes.url ?? url,
      headers: changes.headers ?? headers,
      payload: changes.body ?? body,
    });
  return {
    ...f,
    owner,
    app,
    configuration,
    runtimeState: state,
    materialScope: () => materialScope!,
    url,
    headers,
    body,
    post,
  };
}

export function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
