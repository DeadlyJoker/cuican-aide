import type { ProjectMediaInputRevision } from "@crewon/application";
import {
  mediaInputToolMetadata,
  parseMediaInputToolResponse,
  type MediaInputToolRequests,
} from "@crewon/contracts/project-media-input-tools";

/** Logical source identities only; provider paths, transport evidence and prompt bodies stay out of the ACK. */
export function mediaInputMetadata(input: ProjectMediaInputRevision) {
  return mediaInputToolMetadata({
    projectId: input.projectId,
    mediaInputId: input.mediaInputId,
    inputRevision: input.inputRevision,
    item: input.item,
    briefRevision: input.brief.briefRevision,
    script:
      input.script === null
        ? null
        : {
            artifactId: input.script.artifactId,
            contentRevision: input.script.contentRevision,
          },
    workflowId: input.workflow.workflowId,
    configurationRevision: input.target.configuration.revision,
    prompt: input.prompt,
    references: Object.fromEntries(
      input.references.map((r) => [r.role, r.preparation.source.query]),
    ),
    createdAt: input.createdAt,
    contentDigest: input.contentDigest,
  });
}

/** Reserve the worst allowed new ID and revision before committing. A saved result must always fit its Tool ACK. */
export function proveMediaInputSaveAck(
  request: MediaInputToolRequests["saveInput"],
): void {
  const { expectedInputRevision, ...input } = request;
  parseMediaInputToolResponse("saveInput", request, {
    disposition: "committed",
    input: mediaInputToolMetadata({
      ...input,
      mediaInputId: input.mediaInputId ?? "\\".repeat(128),
      inputRevision: Math.max(1, expectedInputRevision + 1),
      createdAt: "2026-10-06T00:00:00.000Z",
      contentDigest: `sha256:${"f".repeat(64)}`,
    }),
  });
}
export function mediaInputPromptChunk(
  request: MediaInputToolRequests["readPrompt"],
  input: ProjectMediaInputRevision,
) {
  const points = Array.from(input.prompt);
  if (request.offset > points.length)
    throw new Error("plugin_media_input_prompt_offset_invalid");
  let end = request.offset,
    bytes = 0;
  while (end < points.length) {
    const size = Buffer.byteLength(points[end]!, "utf8");
    if (bytes + size > 2048) break;
    end++;
    bytes += size;
  }
  while (true) {
    try {
      return parseMediaInputToolResponse("readPrompt", request, {
        ...request,
        contentDigest: input.contentDigest,
        nextOffset: end === points.length ? null : end,
        totalCodePoints: points.length,
        text: points.slice(request.offset, end).join(""),
      });
    } catch (error) {
      if (end <= request.offset + 1) throw error;
      end--;
    }
  }
}
