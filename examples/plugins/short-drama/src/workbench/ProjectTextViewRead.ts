import type { PluginCreativeProjectClient } from "@crewon/plugin-sdk/ui";
import type { PluginProjectTextUiClient } from "../project-texts-ui-service";
import type { TextTarget } from "./ProjectTextController.types";

export async function readProjectTextView(ports: {
  client: PluginProjectTextUiClient;
  projects: Pick<PluginCreativeProjectClient, "getProject" | "getBrief">;
  projectId: string;
  target: TextTarget;
  signal: AbortSignal;
}) {
  const { client, projects, projectId, target, signal } = ports;
  const options = { signal };
  const project = (await projects.getProject({ projectId }, options)).project;
  const brief = (
    await projects.getBrief(
      { projectId, briefRevision: project.latestBriefRevision },
      options,
    )
  ).brief;
  const view = (
    target.kind === "outline"
      ? await client.getOutline({ projectId }, options)
      : await client.getScript(
          { projectId, episodeId: target.episodeId },
          options,
        )
  ).view;
  const outline =
    target.kind === "outline"
      ? view
      : (await client.getOutline({ projectId }, options)).view;
  let content = view?.selectedRevision ?? null;
  if (!content && view)
    content = (
      await client.getRevision(
        {
          projectId,
          artifactId: view.artifact.artifactId,
          contentRevision: view.artifact.latestContentRevision,
        },
        options,
      )
    ).contentRevision;
  return { details: { project, brief }, view, outline, content };
}
