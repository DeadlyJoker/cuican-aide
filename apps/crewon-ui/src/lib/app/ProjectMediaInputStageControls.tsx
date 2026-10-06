import type { useProjectMediaInputStageComposer } from "./useProjectMediaInputStageComposer";
import type { PublicProjectMediaInputStage } from "@crewon/contracts/project-media-input-stages";

const names = {
  "krea2-reference-four-view": [
    "T10 · 角色参考四视图",
    "T10 · Character reference views",
  ],
  "flux2-three-reference-storyboard": [
    "D18 · 三素材分镜探索",
    "D18 · Three-reference frame exploration",
  ],
} as const;
/** Only the existing Composer extension slot; no shell layout or theme changes. */
export function ProjectMediaInputStageControls({
  media,
  episodes,
  retained,
  busy,
  zh,
}: {
  media: ReturnType<typeof useProjectMediaInputStageComposer>;
  episodes: readonly Readonly<{ episodeId: string; title: string }>[];
  retained: boolean;
  busy: boolean;
  zh: boolean;
}) {
  const workflows =
    retained && !media.workflows.includes(media.workflowId)
      ? [media.workflowId]
      : media.workflows;
  return (
    <>
      <select
        aria-label={zh ? "输入准备工作流" : "Input preparation workflow"}
        value={media.workflowId}
        disabled={busy || retained}
        onChange={(e) =>
          media.setWorkflowId(
            e.target.value as PublicProjectMediaInputStage["workflowId"],
          )
        }
      >
        {workflows.map((id) => (
          <option key={id} value={id}>
            {names[id][zh ? 0 : 1]}
          </option>
        ))}
      </select>
      <select
        aria-label={zh ? "画面剧本来源" : "Media script source"}
        value={media.episodeId}
        disabled={busy || retained}
        onChange={(e) => media.setEpisodeId(e.target.value)}
      >
        <option value="">
          {media.workflowId === "flux2-three-reference-storyboard"
            ? zh
              ? "请选择已采用的分集剧本"
              : "Select an adopted episode script"
            : zh
              ? "仅依据需求"
              : "Brief only"}
        </option>
        {retained &&
        media.episodeId !== "" &&
        !episodes.some((e) => e.episodeId === media.episodeId) ? (
          <option value={media.episodeId}>{media.episodeId}</option>
        ) : null}
        {episodes.map((e) => (
          <option key={e.episodeId} value={e.episodeId}>
            {e.title}
          </option>
        ))}
      </select>
      <span>
        {zh
          ? "准备描述与参考素材，不开始生成"
          : "Prepare prompts and references; no generation"}
      </span>
      {media.blocked ? (
        <span role="alert">
          {zh
            ? "工作流或已采用剧本暂不可用，请选择来源或刷新项目"
            : "Workflow or adopted script unavailable. Select a source or refresh project."}
        </span>
      ) : null}
    </>
  );
}
