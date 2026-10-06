import type {
  MediaInputToolMethod,
  MediaInputToolRequests,
  MediaInputToolResponses,
  MediaInputToolCommand,
} from "./project-media-input-tools-service.js";
export function parseMediaInputToolCommand(
  input: unknown,
): MediaInputToolCommand;
export function parseMediaInputToolRequest<M extends MediaInputToolMethod>(
  method: M,
  input: unknown,
): MediaInputToolRequests[M];
export function parseMediaInputToolResponse<M extends MediaInputToolMethod>(
  method: M,
  request: MediaInputToolRequests[M],
  input: unknown,
): MediaInputToolResponses[M];
