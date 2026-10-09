import { ProjectMediaGenerationComposer } from "./ProjectMediaGenerationComposer";
import type { ProjectMediaGenerationPresenter } from "../control-runtime/controlProjectMediaGeneration";
import { useProjectMediaInputStageComposer } from "./useProjectMediaInputStageComposer";
import { ProjectMediaInputStageControls } from "./ProjectMediaInputStageControls";
import type { ProjectMediaInputStageComposerSelection } from "../control-runtime/controlProjectMediaInputStageTurn";
import { useProjectAssetStageComposer } from "./useProjectAssetStageComposer";
import type { ProjectAssetStageComposerSelection } from "../control-runtime/controlProjectAssetStageTurn";
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
import { subscribeProjectConversationBindingChanges } from "../plugins/projectConversationBindingChanges";
import { readProjectConversationOutline } from "../control-runtime/controlProjectConversationOutline";

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
    mediaGenerationPresenter?: ProjectMediaGenerationPresenter | null;
    retainedSelection?: ProjectConversationComposerSelection | null;
    retainedAssetSelection?: ProjectAssetStageComposerSelection | null;
    retainedMediaInputSelection?: ProjectMediaInputStageComposerSelection | null;
  }>,
) {
  const [generationBusy, setGenerationBusy] = useState(false);
  const busy = input.busy || generationBusy;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [failure, setFailure] = useState(false),
    [loading, setLoading] = useState(
      input.client !== null && input.threadId !== null,
    ),
    [kind, setKind] = useState<
      ProjectConversationStage["kind"] | "assets" | "media-input"
    >("discussion"),
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
    if (owner.client === null || owner.threadId === null) return;
    return subscribeProjectConversationBindingChanges(
      owner.client,
      owner.threadId,
      () => {
        if (current.current !== owner) return;
        setLoading(true);
        setRefresh((value) => value + 1);
      },
    );
  }, [owner]);
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
      const { project } = await owner.client!.creativeProjects.getProject(
        binding.projectId,
        options,
      );
      const selectedOutline = await readProjectConversationOutline(
        owner.client!,
        {
          projectId: binding.projectId,
          briefRevision: project.latestBriefRevision,
        },
        options,
      );
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
  const retainedAsset =
    input.retainedAssetSelection?.binding.threadId === owner.threadId
      ? input.retainedAssetSelection
      : null;
  const retainedMedia =
    input.retainedMediaInputSelection?.binding.threadId === owner.threadId
      ? input.retainedMediaInputSelection
      : null;
  const selectedKind =
    retainedMedia?.stage.kind ??
    retainedAsset?.stage.kind ??
    retained?.stage.kind ??
    kind;
  const assets = useProjectAssetStageComposer({
    client: owner.client,
    binding: actual?.binding ?? null,
    briefRevision: actual?.briefRevision ?? 0,
    episodeIds: actual?.outline?.episodes.map((e) => e.episodeId) ?? [],
    active: selectedKind === "assets",
    threadRevision: input.threadRevision,
    refresh,
    retained: retainedAsset,
  });
  const media = useProjectMediaInputStageComposer({
    client: owner.client,
    binding: actual?.binding ?? null,
    briefRevision: actual?.briefRevision ?? 0,
    episodeIds: actual?.outline?.episodes.map((e) => e.episodeId) ?? [],
    active: selectedKind === "media-input",
    threadRevision: input.threadRevision,
    refresh,
    retained: retainedMedia,
  });
  const stage: ProjectConversationStage =
    retained?.stage ??
    (kind === "assets" || kind === "media-input"
      ? { kind: "discussion" }
      : kind === "discussion"
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
    actual === null ||
    selectedKind === "assets" ||
    selectedKind === "media-input"
      ? null
      : (retained ?? { binding: actual.binding, stage });
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
        style={
          input.mediaGenerationPresenter
            ? { flexWrap: "wrap", maxWidth: "100%" }
            : undefined
        }
      >
        <span>{zh ? "项目创作" : "Project creation"}</span>{" "}
        <select
          aria-label={zh ? "创作阶段" : "Creation stage"}
          value={selectedKind}
          disabled={
            busy ||
            retained !== null ||
            retainedAsset !== null ||
            retainedMedia !== null
          }
          onChange={(event) =>
            setKind(
              event.target.value as
                | ProjectConversationStage["kind"]
                | "assets"
                | "media-input",
            )
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
          {assets.available || retainedAsset !== null ? (
            <option value="assets" disabled={actual.briefRevision < 1}>
              {zh ? "角色、场景与道具" : "Characters, scenes and props"}
            </option>
          ) : null}
          {media.available || retainedMedia !== null ? (
            <option value="media-input" disabled={actual.briefRevision < 1}>
              {zh ? "准备生成输入" : "Prepare media input"}
            </option>
          ) : null}
        </select>
        {selectedKind === "media-input" ? (
          <ProjectMediaInputStageControls
            media={media}
            episodes={actual.outline?.episodes ?? []}
            retained={retainedMedia !== null}
            busy={busy}
            zh={zh}
          />
        ) : null}
        {selectedKind === "assets" ? (
          <>
            <select
              aria-label={zh ? "资产类型" : "Asset kind"}
              value={assets.assetKind}
              disabled={
                busy || retainedAsset !== null || retainedMedia !== null
              }
              onChange={(e) =>
                assets.setAssetKind(
                  e.target.value as "character" | "scene" | "prop",
                )
              }
            >
              <option value="character">{zh ? "角色" : "Character"}</option>
              <option value="scene">{zh ? "场景" : "Scene"}</option>
              <option value="prop">{zh ? "道具" : "Prop"}</option>
            </select>
            <select
              aria-label={zh ? "资产剧本来源" : "Asset script source"}
              value={assets.episodeId}
              disabled={
                busy || retainedAsset !== null || retainedMedia !== null
              }
              onChange={(e) => assets.setEpisodeId(e.target.value)}
            >
              <option value="">{zh ? "仅依据需求" : "Brief only"}</option>
              {retainedAsset?.stage.script !== null &&
              retainedAsset?.stage.script !== undefined &&
              !actual.outline?.episodes.some(
                (e) => e.episodeId === retainedAsset.stage.script!.episodeId,
              ) ? (
                <option value={retainedAsset.stage.script.episodeId}>
                  {retainedAsset.stage.script.episodeId}
                </option>
              ) : null}
              {actual.outline?.episodes.map((e) => (
                <option key={e.episodeId} value={e.episodeId}>
                  {e.title}
                </option>
              ))}
            </select>
            {assets.blocked ? (
              <span role="alert">
                {zh
                  ? "资产阶段或所选剧本来源暂不可用，请刷新项目"
                  : "Asset stage or selected script unavailable. Refresh project."}
              </span>
            ) : null}
          </>
        ) : null}
        {retained !== null ||
        retainedAsset !== null ||
        retainedMedia !== null ? (
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
            disabled={
              busy ||
              retained !== null ||
              retainedAsset !== null ||
              retainedMedia !== null
            }
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
          disabled={busy || loading}
          onClick={() => {
            setLoading(true);
            setRefresh((value) => value + 1);
          }}
        >
          {zh ? "刷新项目" : "Refresh project"}
        </button>
        {owner.client !== null && input.mediaGenerationPresenter ? (
          <ProjectMediaGenerationComposer
            client={owner.client}
            binding={actual.binding}
            briefRevision={actual.briefRevision}
            presenter={input.mediaGenerationPresenter}
            busy={input.busy}
            zh={zh}
            onBusyChange={setGenerationBusy}
          />
        ) : null}
      </div>
    );
  return {
    selection,
    assetSelection: assets.selection,
    mediaInputSelection: media.selection,
    view,
    generationBusy,
    blocked:
      owner.client !== null &&
      owner.threadId !== null &&
      (generationBusy ||
        assets.blocked ||
        media.blocked ||
        snapshotOwner !== owner ||
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
