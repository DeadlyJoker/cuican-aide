import type { PublicProjectTextRevision } from "../project-texts-ui-service";

/** Render persisted output, never unsaved form state or an invented completion. */
export function ProjectTextDocument({
  revision,
  selected,
  stale,
  locked,
  onOpenEpisode,
}: {
  revision: PublicProjectTextRevision | null;
  selected: boolean;
  stale: boolean;
  locked: boolean;
  onOpenEpisode?(episodeId: string): void;
}) {
  if (!revision)
    return (
      <div className="drama-output-empty">
        <h3>还没有产物</h3>
        <p>在项目对话中让 Agent 创作，保存后会显示在这里。也可以手动填写。</p>
      </div>
    );
  return (
    <article className="drama-output-document" aria-label="产物正文">
      <div className="panel-heading">
        <h3>{revision.content.title}</h3>
        <span className="version-chip">
          {selected ? "已采用" : "待确认"}
          {selected && locked ? " · 已锁定" : ""}
        </span>
      </div>
      {stale && (
        <p role="status" className="detail-note">
          上游内容已更新，请复核此产物。
        </p>
      )}
      {revision.kind === "outline" ? (
        <>
          <p className="drama-readable-text">{revision.content.logline}</p>
          <p className="drama-readable-text">{revision.content.synopsis}</p>
          {!selected && (
            <p className="detail-note">
              采用大纲后，可从各集故事进入对应剧本。
            </p>
          )}
          {revision.content.episodes.map((episode, index) => (
            <section key={episode.episodeId}>
              <h4>
                第 {index + 1} 集 · {episode.title}
              </h4>
              <p className="drama-readable-text">{episode.summary}</p>
              {selected && (
                <button
                  type="button"
                  className="text-button"
                  aria-label={`查看第 ${index + 1} 集剧本`}
                  disabled={!onOpenEpisode}
                  onClick={() => onOpenEpisode?.(episode.episodeId)}
                >
                  查看本集剧本
                </button>
              )}
            </section>
          ))}
        </>
      ) : (
        revision.content.scenes.map((scene, index) => (
          <section key={scene.sceneId}>
            <h4>
              {index + 1}. {scene.location} · {scene.timeOfDay}
            </h4>
            <p className="drama-readable-text">{scene.action}</p>
            {scene.dialogue.map((line, i) => (
              <p key={i} className="drama-readable-text">
                <strong>{line.speaker}：</strong>
                {line.text}
              </p>
            ))}
          </section>
        ))
      )}
    </article>
  );
}
