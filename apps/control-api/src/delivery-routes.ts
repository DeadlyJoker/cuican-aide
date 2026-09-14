import {
  ApplicationError,
  type DeliveryApplicationService,
} from "@crewon/application";
import {
  DELIVERY_LIMITS,
  DeliveryError,
  deliveryObject,
  parseDeliveryAssembleRequest,
  parseDeliveryPatchRequest,
  type DeliveryInputRecord,
} from "@crewon/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";

type Params = {
  threadId: string;
  inputId: string;
  versionId: string;
  deliveryId: string;
};
type Request = FastifyRequest<{
  Params: Params;
  Querystring: Record<string, unknown>;
}>;
export function registerDeliveryRoutes(
  app: FastifyInstance,
  dependencies: {
    deliveries?: DeliveryApplicationService | null;
    identity: ControlApiIdentityPort;
  },
) {
  const base = "/api/v1/threads/:threadId/delivery";
  const service = () => {
    if (!dependencies.deliveries)
      throw new ApplicationError("notFound", "delivery_unavailable");
    return dependencies.deliveries;
  };
  const actor = (request: FastifyRequest) =>
    dependencies.identity.resolveActor(requestContext(request));
  const key = (request: FastifyRequest) => {
    const value = request.headers["idempotency-key"];
    if (typeof value !== "string")
      throw new ApplicationError(
        "validation",
        "delivery_idempotency_key_required",
      );
    return value;
  };
  const route =
    (handler: (request: Request, reply: FastifyReply) => Promise<unknown>) =>
    async (request: Request, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        if (error instanceof DeliveryError)
          throw new ApplicationError("validation", error.code);
        throw error;
      }
    };
  const file = (
    reply: FastifyReply,
    stored: {
      record: {
        name: string;
        mediaType: string;
        byteLength: number;
        contentDigest: string;
      };
      content: Uint8Array;
    },
  ) =>
    reply
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(stored.record.name).replaceAll("'", "%27")}`,
      )
      .header("content-length", stored.record.byteLength)
      .header("x-content-digest", stored.record.contentDigest)
      .type(stored.record.mediaType)
      .send(Buffer.from(stored.content));

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    base,
    route(async (request) =>
      service().catalog(await actor(request), request.params.threadId),
    ),
  );
  app.post<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/inputs`,
    { bodyLimit: Math.ceil((DELIVERY_LIMITS.fileBytes * 4) / 3) + 4096 },
    route(async (request) => {
      const identity = await actor(request);
      const body = deliveryObject(request.body, [
        "name",
        "role",
        "mediaType",
        "contentBase64",
      ]);
      if (
        typeof body.contentBase64 !== "string" ||
        body.contentBase64.length >
          Math.ceil(DELIVERY_LIMITS.fileBytes / 3) * 4 ||
        body.contentBase64.length % 4 !== 0 ||
        /[^A-Za-z0-9+/=]/u.test(body.contentBase64)
      )
        throw new ApplicationError("validation", "delivery_base64_invalid");
      const content = Buffer.from(body.contentBase64, "base64");
      if (content.toString("base64") !== body.contentBase64)
        throw new ApplicationError("validation", "delivery_base64_invalid");
      return service().upload(
        identity,
        request.params.threadId,
        {
          name: body.name as string,
          role: body.role as "data" | "template",
          mediaType: body.mediaType as DeliveryInputRecord["mediaType"],
          content,
        },
        key(request),
      );
    }),
  );
  for (const kind of ["input", "version"] as const) {
    const idName = kind === "input" ? "inputId" : "versionId";
    const path = `${base}/${kind === "input" ? "inputs" : "versions"}/:${idName}`;
    app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
      `${path}/content`,
      route(async (request, reply) => {
        const identity = await actor(request);
        const stored =
          kind === "input"
            ? await service().readInput(
                identity,
                request.params.threadId,
                request.params[idName],
              )
            : await service().readVersion(
                identity,
                request.params.threadId,
                request.params[idName],
              );
        return file(reply, stored);
      }),
    );
    app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
      `${path}/page`,
      route(async (request) => {
        const identity = await actor(request);
        const query = deliveryObject(request.query, [
          "sheet",
          "startRow",
          "limit",
        ]);
        if (
          typeof query.startRow !== "string" ||
          !/^[1-9][0-9]*$/u.test(query.startRow) ||
          typeof query.limit !== "string" ||
          !/^[1-9][0-9]*$/u.test(query.limit)
        )
          throw new ApplicationError("validation", "delivery_page_invalid");
        return service().page(identity, request.params.threadId, {
          kind,
          id: request.params[idName],
          sheet: query.sheet as string,
          startRow: Number(query.startRow),
          limit: Number(query.limit),
        });
      }),
    );
  }
  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/versions/:versionId`,
    route(
      async (request) =>
        (
          await service().readVersion(
            await actor(request),
            request.params.threadId,
            request.params.versionId,
          )
        ).record,
    ),
  );
  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/history/:deliveryId`,
    route(async (request) =>
      service().history(
        await actor(request),
        request.params.threadId,
        request.params.deliveryId,
      ),
    ),
  );
  app.post<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/assemble`,
    route(async (request) => {
      const identity = await actor(request);
      return service().assemble(
        identity,
        request.params.threadId,
        parseDeliveryAssembleRequest(request.body),
        { key: key(request), sourceRunId: null },
      );
    }),
  );
  app.post<{ Params: Params; Querystring: Record<string, unknown> }>(
    `${base}/patch`,
    route(async (request) => {
      const identity = await actor(request);
      return service().patch(
        identity,
        request.params.threadId,
        parseDeliveryPatchRequest(request.body),
        { key: key(request), sourceRunId: null },
      );
    }),
  );
}
