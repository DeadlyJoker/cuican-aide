import type { FastifyRequest } from "fastify";

import type { ControlApiRequestContext } from "./control-api-ports.ts";

export function requestContext(
  request: FastifyRequest,
): ControlApiRequestContext {
  return {
    method: request.method,
    url: request.url,
    remoteAddress: request.ip,
    headers: request.headers,
  };
}
