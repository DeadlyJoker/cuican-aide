export * from "./plugin-project-foundation-service.ts";
export {
  ProjectFoundationContractError,
  parseProjectFoundationParameters,
} from "./project-foundation-contract-support.ts";
export {
  parsePublicProjectFoundation,
  parsePublicProjectSource,
  parsePublicProjectSourceChapter,
  parsePublicProjectProposal,
} from "./project-foundation-public-contract.ts";
export { parseProjectFoundationUiRequest } from "./project-foundation-ui-request-contract.ts";
export { parseProjectFoundationUiResponse } from "./project-foundation-ui-response-contract.ts";
import { parseProjectFoundationUiRequest } from "./project-foundation-ui-request-contract.ts";
import { parseProjectFoundationUiResponse } from "./project-foundation-ui-response-contract.ts";
import type { ProjectFoundationUiCodec } from "./plugin-project-foundation-service.ts";
export const projectFoundationUiCodec: ProjectFoundationUiCodec = Object.freeze(
  {
    parseRequest: parseProjectFoundationUiRequest,
    parseResponse: parseProjectFoundationUiResponse,
  },
);
