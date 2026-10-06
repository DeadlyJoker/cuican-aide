import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ContractValidationError } from "@crewon/contracts";
import {
  parseSaveMediaInputHttpRequest,
  parseLoadMediaInputHttpRequest,
  MAX_PROJECT_MEDIA_INPUT_REQUEST_BYTES,
} from "@crewon/contracts/project-media-inputs";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import {
  isInstalledProjectMediaInputRuntime,
  InstalledProjectMediaInputRuntime,
} from "./installed-project-media-input-runtime.ts";

const ROOT = "/api/v1/creative-projects/:projectId/media-inputs";
/** Authenticated metadata only. The native owner derives actor/profile and rechecks purpose inside SQL. */
export function registerProjectMediaInputRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    owner: InstalledProjectMediaInputRuntime;
  }>,
) {
  if (!isInstalledProjectMediaInputRuntime(input.owner))
    throw new Error("installed_project_media_input_owner_required");
  const save = InstalledProjectMediaInputRuntime.prototype.saveInput.bind(
      input.owner,
    ),
    load = InstalledProjectMediaInputRuntime.prototype.loadInput.bind(
      input.owner,
    );
  app.post<{
    Params: { projectId: string };
    Querystring: unknown;
    Body: unknown;
  }>(
    ROOT,
    { bodyLimit: MAX_PROJECT_MEDIA_INPUT_REQUEST_BYTES },
    async (request, reply) =>
      withRequestSignal(request, reply, async (signal) => {
        querySnapshot(request.query, []);
        const context = requestContext(request),
          actor = await input.identity.resolveActor(context);
        const command = parseSaveMediaInputHttpRequest({
          body: request.body,
          projectId: request.params.projectId,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return save(context, actor, command, signal);
      }),
  );
  app.get<{
    Params: { projectId: string; mediaInputId: string };
    Querystring: unknown;
  }>(
    `${ROOT}/:mediaInputId`,
    { exposeHeadRoute: false },
    async (request, reply) =>
      withRequestSignal(request, reply, async (signal) => {
        const context = requestContext(request),
          actor = await input.identity.resolveActor(context);
        return load(
          context,
          actor,
          parseLoadMediaInputHttpRequest({
            ...request.params,
            query: querySnapshot(request.query, ["inputRevision"]),
          }),
          signal,
        );
      }),
  );
}

/** Fastify query records have a framework prototype; copy only bounded own data fields. */
function querySnapshot(input: unknown, allowed: readonly string[]) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length > allowed.length) invalid();
  const copy: Record<string, string> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) invalid();
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (
      !field?.enumerable ||
      !Object.hasOwn(field, "value") ||
      typeof field.value !== "string" ||
      field.value.length > 32
    )
      invalid();
    copy[key] = field.value;
  }
  return Object.freeze(copy);
}
async function withRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController(),
    abort = () => controller.abort(),
    closed = () => {
      if (!reply.raw.writableEnded) abort();
    };
  request.raw.once("aborted", abort);
  reply.raw.once("close", closed);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try {
    return await work(controller.signal);
  } finally {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", closed);
  }
}
function invalid(): never {
  throw new ContractValidationError("project_media_inputs_contract_invalid");
}
