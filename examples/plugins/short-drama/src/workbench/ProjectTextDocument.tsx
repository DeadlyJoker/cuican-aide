import type { PublicProjectTextRevision } from "../project-texts-ui-service";

/** Render persisted output, never unsaved form state or an invented completion. */
export function ProjectTextDocument({
  revision,
  selected,
  stale,
}: {
  revision: PublicProjectTextRevision | null;
  selected: boolean;
  stale: boolean;
}) {
  if (!revision)
    return (
      <div className="drama-output-empty">
        <h3>还没有产物</h3>
        <p>
          在项目对话中让 Agent
          创作，保存后会显示在这里。也可以展开下方编辑器手动填写。
        </p>
      </div>
    );
  return (
    <article className="drama-output-document" aria-label="产物正文">
      <div className="panel-heading">
        <h3>{revision.content.title}</h3>
        <span className="version-chip">
          {selected ? "已采用" : "待确认"} · v{revision.contentRevision}
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
          {revision.content.episodes.map((episode, index) => (
            <section key={episode.episodeId}>
              <h4>
                第 {index + 1} 集 · {episode.title}
              </h4>
              <p className="drama-readable-text">{episode.summary}</p>
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
