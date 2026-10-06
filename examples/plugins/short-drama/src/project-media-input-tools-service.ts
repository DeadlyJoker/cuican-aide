/** Portable optional Node service, separate from UI and execution v1. */
import type {
  SaveMediaInputRequest,
  LoadMediaInputRequest,
  PublicMediaInput,
  ListMediaInputsRequest,
  ListMediaInputsResponse,
  MediaInputOptionsRequest,
  MediaInputOptionsResponse,
} from "./project-media-inputs-ui-client.js";
/** Independent optional Node service. UI invocation and execution v1 grant no access to it. */
export const PROJECT_MEDIA_INPUT_TOOLS_SERVICE =
  "crewon.project-media-input-tools";
export const PROJECT_MEDIA_INPUT_TOOLS_API_VERSION = "1";
export const MAX_MEDIA_INPUT_TOOL_RESPONSE_BYTES = 8192;
export const MEDIA_INPUT_TOOL_METHODS = [
  "getContext",
  "getOptions",
  "listInputs",
  "getInput",
  "readPrompt",
  "saveInput",
] as const;
export type MediaInputToolMethod = (typeof MEDIA_INPUT_TOOL_METHODS)[number];
export type MediaInputToolMetadata = Omit<PublicMediaInput, "prompt">;
export type MediaInputToolContext = Readonly<{
  projectId: string;
  runId: string;
  threadId: string;
  workspaceId: string | null;
  bindingRevision: number;
  workflowId: PublicMediaInput["workflowId"];
  configurationRevision: number;
  briefRevision: number;
  script: Readonly<{
    artifactId: string;
    episodeId: string;
    contentRevision: number;
  }> | null;
}>;
export type MediaInputToolRequests = Readonly<{
  getContext: Readonly<Record<string, never>>;
  getOptions: MediaInputOptionsRequest;
  listInputs: ListMediaInputsRequest;
  getInput: LoadMediaInputRequest;
  readPrompt: Readonly<{
    projectId: string;
    mediaInputId: string;
    inputRevision: number;
    offset: number;
  }>;
  saveInput: Omit<SaveMediaInputRequest, "idempotencyKey">;
}>;
export type MediaInputToolResponses = Readonly<{
  getContext: MediaInputToolContext;
  getOptions: MediaInputOptionsResponse;
  listInputs: ListMediaInputsResponse;
  getInput: Readonly<{
    state: Readonly<{
      input: MediaInputToolMetadata;
      latestInputRevision: number;
    }> | null;
  }>;
  readPrompt: Readonly<{
    projectId: string;
    mediaInputId: string;
    inputRevision: number;
    contentDigest: string;
    offset: number;
    nextOffset: number | null;
    totalCodePoints: number;
    text: string;
  }>;
  saveInput: Readonly<{
    disposition: "committed" | "replayed";
    input: MediaInputToolMetadata;
  }>;
}>;
export type PluginProjectMediaInputToolsService = Readonly<{
  [M in MediaInputToolMethod]: (
    input: Readonly<{ command: unknown; request: MediaInputToolRequests[M] }>,
  ) => Promise<MediaInputToolResponses[M]>;
}>;
export type MediaInputToolCommand = {
  [M in MediaInputToolMethod]: Readonly<{
    method: M;
    request: MediaInputToolRequests[M];
  }>;
}[MediaInputToolMethod];
