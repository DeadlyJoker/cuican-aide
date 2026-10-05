import type { PluginCreativeProjectClient } from "@crewon/plugin-sdk/ui";
import type { PluginProjectTextUiClient } from "../project-texts-ui-service";
import type { TextRecoveryRecord } from "./ProjectTextRecoveryController";
import { textRecoveryIntent } from "./ProjectTextRecoveryController";
import type { TextSnapshot, TextTarget } from "./ProjectTextController.types";
import { emptyOutline, emptyScript } from "./ProjectTextDraft";

/** Projects current state and the exact original request; no supplier or business write. */
export async function loadProjectTextRecoveryView(ports: {
  client: PluginProjectTextUiClient;
  projects: Pick<PluginCreativeProjectClient, "getProject" | "getBrief">;
  record: TextRecoveryRecord;
  signal: AbortSignal;
}) {
  const { client, projects, record, signal } = ports;
  const intent = textRecoveryIntent(record),
    projectId = intent.input.projectId;
  const options = { signal };
  const project = (await projects.getProject({ projectId }, options)).project;
  const brief = (
    await projects.getBrief(
      { projectId, briefRevision: project.latestBriefRevision },
      options,
    )
  ).brief;
  const view = (
    intent.kind === "save-outline"
      ? await client.getOutline({ projectId }, options)
      : intent.kind === "save-script"
        ? await client.getScript(
            { projectId, episodeId: intent.input.episodeId },
            options,
          )
        : await client.getArtifact(
            { projectId, artifactId: intent.input.artifactId },
            options,
          )
  ).view;
  if (
    record.phase === "accepted" &&
    (!view ||
      view.artifact.artifactId !== record.confirmed.artifactId ||
      view.artifact.revision < record.confirmed.artifactRevision)
  )
    throw new Error("text_recovery_confirmed_artifact_unavailable");
  const outline =
    intent.kind === "save-outline" || view?.artifact.kind === "outline"
      ? view
      : (await client.getOutline({ projectId }, options)).view;
  let content = view?.selectedRevision ?? null;
  if (
    record.phase === "accepted" &&
    record.confirmed.contentRevision !== null
  ) {
    content = (
      await client.getRevision(
        {
          projectId,
          artifactId: record.confirmed.artifactId,
          contentRevision: record.confirmed.contentRevision,
        },
        options,
      )
    ).contentRevision;
  } else if (!content && view) {
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
  }
  const target: TextTarget =
    intent.kind === "save-outline" ||
    view?.artifact.kind === "outline" ||
    (intent.kind !== "save-script" && !view)
      ? { kind: "outline" }
      : {
          kind: "script",
          episodeId:
            intent.kind === "save-script"
              ? intent.input.episodeId
              : view!.artifact.episodeId!,
          title:
            intent.kind === "save-script"
              ? intent.input.request.content.title
              : (content?.content.title ?? project.title),
        };
  const originalDraft =
    intent.kind === "save-outline" || intent.kind === "save-script"
      ? intent.input.request.content
      : null;
  const originalSources =
    intent.kind === "save-outline" || intent.kind === "save-script";
  const update: Partial<TextSnapshot> = {
    phase: "ready",
    target,
    outline,
    view,
    content: record.phase === "accepted" ? content : null,
    draft:
      record.phase === "accepted"
        ? (content?.content ??
          (target.kind === "outline"
            ? emptyOutline(project.title)
            : emptyScript(target.title)))
        : (originalDraft ??
          content?.content ??
          (target.kind === "outline"
            ? emptyOutline(project.title)
            : emptyScript(target.title))),
    dirty: record.phase !== "accepted" && originalDraft !== null,
    sourceBriefRevision:
      intent.kind === "save-outline" || intent.kind === "save-script"
        ? intent.input.request.briefRevision
        : (content?.brief.briefRevision ?? brief.briefRevision),
    sourceOutline:
      intent.kind === "save-script"
        ? intent.input.request.outline
        : (content?.outline ?? null),
    currentBriefRevision: brief.briefRevision,
    archived: project.state === "archived",
    history: [],
    nextContentRevision: null,
    opening: false,
    saving: false,
    pendingKind: record.phase === "accepted" ? null : intent.kind,
    failure:
      record.phase === "pending"
        ? "uncertain"
        : record.phase === "refused"
          ? "conflict"
          : null,
    conflictRefreshed: false,
    error: null,
    notice:
      record.phase === "accepted"
        ? "已读取上次操作的确切保存结果。确认后可继续创作。"
        : record.phase === "refused"
          ? "上次请求已确认未写入，原内容与来源保留。"
          : "找到未完成的原请求。请核对内容后用原请求重试。",
  };
  return { details: { project, brief }, intent, update };
}
