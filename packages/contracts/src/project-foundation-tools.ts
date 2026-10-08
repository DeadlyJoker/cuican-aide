export * from "./plugin-project-foundation-tools-service.ts";
export { ProjectFoundationToolsContractError } from "./project-foundation-tools-contract-support.ts";
export { parseProjectFoundationToolsRequest } from "./project-foundation-tools-request-contract.ts";
export { parseProjectFoundationToolsResponse } from "./project-foundation-tools-response-contract.ts";
import { parseProjectFoundationToolsRequest } from "./project-foundation-tools-request-contract.ts";
import { parseProjectFoundationToolsResponse } from "./project-foundation-tools-response-contract.ts";
import type { ProjectFoundationToolsCodec } from "./plugin-project-foundation-tools-service.ts";

export const projectFoundationToolsCodec: ProjectFoundationToolsCodec =
  Object.freeze({
    parseRequest: parseProjectFoundationToolsRequest,
    parseResponse: parseProjectFoundationToolsResponse,
  });
