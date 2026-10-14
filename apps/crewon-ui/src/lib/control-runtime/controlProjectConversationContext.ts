import {
  ControlApiClientError,
  type ControlApiClient,
} from "@crewon/control-client";
import type { ProjectConversationContextResponse } from "@crewon/contracts/project-conversations";
import { readProjectConversationOutline } from "./controlProjectConversationOutline";

/** New servers authorize one actual bound Thread. Only a missing route may use legacy public project reads. */
export async function readProjectConversationComposerContext(
  client: ControlApiClient,
  threadId: string,
  options: Readonly<{ signal?: AbortSignal }>,
): Promise<ProjectConversationContextResponse> {
  try {
    return await client.projectConversations.getContext(threadId, options);
  } catch (error) {
    if (
      !(
        error instanceof ControlApiClientError &&
        error.status === 404 &&
        error.code === "route_not_found"
      )
    )
      throw error;
  }
  const { binding } = await client.projectConversations.getBinding(
    threadId,
    options,
  );
  if (binding === null) return { context: null };
  if (binding.threadId !== threadId || binding.state !== "active")
    throw new Error("binding_inactive");
  const { project } = await client.creativeProjects.getProject(
    binding.projectId,
    options,
  );
  const outline = await readProjectConversationOutline(
    client,
    {
      projectId: binding.projectId,
      briefRevision: project.latestBriefRevision,
    },
    options,
  );
  return {
    context: {
      binding,
      projectRevision: project.revision,
      briefRevision: project.latestBriefRevision,
      outline,
    },
  };
}
