import { useEffect, useMemo, useRef, useState } from "react";
import {
  ControlApiClientError,
  type ControlApiClient,
} from "@crewon/control-client";
import type {
  PublicProjectConversationBinding,
  ProjectConversationStage,
} from "@crewon/contracts/project-conversations";
import type { ProjectConversationComposerSelection } from "../control-runtime/controlProjectConversationTurn";

type Snapshot = Readonly<{
  binding: PublicProjectConversationBinding;
  briefRevision: number;
  outline: Readonly<{
    artifactId: string;
    contentRevision: number;
    episodes: readonly Readonly<{ episodeId: string; title: string }>[];
  }> | null;
}>;
/** Reads the actual selected Thread. Workspace hints and unrelated selected tasks supply no authority. */
export function useProjectConversationComposer(
  input: Readonly<{
    client: ControlApiClient | null;
    threadId: string | null;
    threadRevision: number | null;
    locale: "zh" | "en";
    busy: boolean;
    retainedSelection?: ProjectConversationComposerSelection | null;
  }>,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [failure, setFailure] = useState(false),
    [loading, setLoading] = useState(
      input.client !== null && input.threadId !== null,
    ),
    [kind, setKind] = useState<ProjectConversationStage["kind"]>("discussion"),
    [episode, setEpisode] = useState(""),
    [refresh, setRefresh] = useState(0);
  const owner = useMemo(
    () => ({ client: input.client, threadId: input.threadId }),
    [input.client, input.threadId],
  );
  const current = useRef(owner);
  current.current = owner;
  const [snapshotOwner, setSnapshotOwner] = useState(owner);
  useEffect(() => {
    setSnapshot(null);
    setFailure(false);
    setSnapshotOwner(owner);
    setKind("discussion");
    setEpisode("");
    setLoading(owner.client !== null && owner.threadId !== null);
  }, [owner]);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setFailure(false);
    setLoading(owner.client !== null && owner.threadId !== null);
    if (owner.client === null || owner.threadId === null)
      return () => {
        alive = false;
        controller.abort();
      };
    const options = { signal: controller.signal };
    void (async () => {
      const { binding } = await owner.client!.projectConversations.getBinding(
        owner.threadId!,
        options,
      );
      if (binding === null) {
        if (alive && current.current === owner) setSnapshot(null);
        return;
      }
      if (binding.threadId !== owner.threadId || binding.state !== "active")
        throw new Error("binding_inactive");
      const [{ project }, outline] = await Promise.all([
        owner.client!.creativeProjects.getProject(binding.projectId, options),
        owner.client!.projectTexts.getOutline(binding.projectId, options),
      ]);
      const selected = outline.view?.selectedRevision;
      const selectedOutline =
        selected?.kind === "outline" &&
        selected.brief.briefRevision === project.latestBriefRevision
          ? {
              artifactId: selected.artifactId,
              contentRevision: selected.contentRevision,
              episodes: selected.content.episodes,
            }
          : null;
      if (alive && current.current === owner) {
        setSnapshot({
          binding,
          briefRevision: project.latestBriefRevision,
          outline: selectedOutline,
        });
        setEpisode((previous) =>
          selectedOutline?.episodes.some(
            (entry) => entry.episodeId === previous,
          )
            ? previous
            : (selectedOutline?.episodes[0]?.episodeId ?? ""),
        );
      }
    })()
      .catch((error: unknown) => {
        if (!alive || current.current !== owner) return;
        // Older Control deployments have no new route; their original ordinary chat stays unchanged.
        if (
          error instanceof ControlApiClientError &&
          error.status === 404 &&
          error.code === "route_not_found"
        )
          return;
        setFailure(true);
      })
      .finally(() => {
        if (alive && current.current === owner) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [owner, input.threadRevision, refresh]);
  const actual = snapshotOwner === owner ? snapshot : null;
  const retained =
    input.retainedSelection?.binding.threadId === owner.threadId
      ? input.retainedSelection
      : null;
  const retainedScript =
    retained?.stage.kind === "script" ? retained.stage : null;
  const selectedKind = retained?.stage.kind ?? kind;
  const stage: ProjectConversationStage =
    retained?.stage ??
    (kind === "discussion"
      ? { kind }
      : kind === "brief" || kind === "outline"
        ? { kind, briefRevision: actual?.briefRevision ?? 0 }
        : {
            kind: "script",
            episodeId: episode,
            briefRevision: actual?.briefRevision ?? 0,
            outline:
              actual?.outline === null || actual?.outline === undefined
                ? null
                : {
                    artifactId: actual.outline.artifactId,
                    contentRevision: actual.outline.contentRevision,
                  },
          });
  const selection: ProjectConversationComposerSelection | null =
    actual === null ? null : (retained ?? { binding: actual.binding, stage });
  const zh = input.locale === "zh";
  const view =
    actual === null ? (
      failure && snapshotOwner === owner ? (
        <span role="alert" className="composer-state">
          {zh
            ? "项目会话状态暂不可用，请重新进入会话"
            : "Project conversation unavailable. Reopen the conversation."}
        </span>
      ) : null
    ) : (
      <div
        className="composer-state"
        aria-label={zh ? "项目创作阶段" : "Project creation stage"}
      >
        <span>{zh ? "项目创作" : "Project creation"}</span>{" "}
        <select
          aria-label={zh ? "创作阶段" : "Creation stage"}
          value={selectedKind}
          disabled={input.busy || retained !== null}
          onChange={(event) =>
            setKind(event.target.value as ProjectConversationStage["kind"])
          }
        >
          <option value="discussion">
            {zh ? "讨论（只读）" : "Discussion (read only)"}
          </option>
          <option value="brief" disabled={actual.briefRevision < 1}>
            {zh ? "需求" : "Brief"}
          </option>
          <option value="outline" disabled={actual.briefRevision < 1}>
            {zh ? "大纲" : "Outline"}
          </option>
          <option value="script" disabled={actual.outline === null}>
            {zh ? "分集剧本" : "Episode script"}
          </option>
        </select>
        {retained !== null ? (
          <span>
            {zh
              ? "重试将继续原请求的阶段与来源"
              : "Retry keeps the original stage and sources"}
          </span>
        ) : null}
        {selectedKind === "script" &&
        (actual.outline !== null || retainedScript !== null) ? (
          <select
            aria-label={zh ? "剧本集数" : "Script episode"}
            value={retainedScript !== null ? retainedScript.episodeId : episode}
            disabled={input.busy || retained !== null}
            onChange={(event) => setEpisode(event.target.value)}
          >
            {retainedScript !== null &&
            !actual.outline?.episodes.some(
              (entry) => entry.episodeId === retainedScript.episodeId,
            ) ? (
              <option value={retainedScript.episodeId}>
                {retainedScript.episodeId}
              </option>
            ) : null}
            {actual.outline?.episodes.map((entry) => (
              <option key={entry.episodeId} value={entry.episodeId}>
                {entry.title}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          disabled={input.busy || loading}
          onClick={() => {
            setLoading(true);
            setRefresh((value) => value + 1);
          }}
        >
          {zh ? "刷新项目" : "Refresh project"}
        </button>
      </div>
    );
  return {
    selection,
    view,
    blocked:
      owner.client !== null &&
      owner.threadId !== null &&
      (snapshotOwner !== owner ||
        failure ||
        loading ||
        (retained === null &&
          kind === "script" &&
          (actual?.outline === null ||
            !actual?.outline?.episodes.some(
              (entry) => entry.episodeId === episode,
            )))),
  };
}
