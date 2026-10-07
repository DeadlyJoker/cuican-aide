import { ProjectTextDocument } from "./ProjectTextDocument";
import { useEffect, useSyncExternalStore } from "react";
import type { ProjectDetails } from "./creative-project-controller";
import { ProjectTextController } from "./ProjectTextController";
import type { TextSnapshot } from "./ProjectTextController";
import {
  newEpisode,
  newScene,
  textBytes,
  type OutlineDraft,
  type ScriptDraft,
} from "./ProjectTextDraft";

function TextFeedback({
  controller,
  snapshot,
}: {
  controller: ProjectTextController;
  snapshot: TextSnapshot;
}) {
  return (
    <>
      {snapshot.error && (
        <p className="detail-note" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.notice && (
        <p className="detail-note" role="status">
          {snapshot.notice}
        </p>
      )}
      {snapshot.failure === "uncertain" && !snapshot.recovery.intent && (
        <button
          className="button secondary"
          disabled={snapshot.saving}
          onClick={() => void controller.retry()}
        >
          用原请求重试
        </button>
      )}
      {snapshot.failure === "conflict" && !snapshot.recovery.intent && (
        <div className="detail-actions">
          <button
            className="button secondary"
            disabled={snapshot.saving}
            onClick={() => void controller.refreshConflict()}
          >
            读取当前状态
          </button>
          {snapshot.conflictRefreshed && (
            <button
              className="button secondary"
              onClick={() => void controller.continueDraft()}
            >
              保留草稿继续编辑
            </button>
          )}
        </div>
      )}
    </>
  );
}

function OutlineEditor({
  draft,
  controller,
  disabled,
}: {
  draft: OutlineDraft;
  controller: ProjectTextController;
  disabled: boolean;
}) {
  const change = (value: Partial<OutlineDraft>) =>
    controller.setDraft({ ...draft, ...value });
  return (
    <div className="text-editor">
      <label className="form-field">
        大纲标题
        <input
          aria-label="大纲标题"
          value={draft.title}
          disabled={disabled}
          onChange={(event) => change({ title: event.target.value })}
        />
      </label>
      <label className="form-field">
        一句话故事
        <textarea
          aria-label="一句话故事"
          value={draft.logline}
          disabled={disabled}
          onChange={(event) => change({ logline: event.target.value })}
        />
      </label>
      <label className="form-field">
        故事梗概
        <textarea
          aria-label="故事梗概"
          value={draft.synopsis}
          disabled={disabled}
          onChange={(event) => change({ synopsis: event.target.value })}
        />
      </label>
      <div className="panel-heading">
        <h3>分集大纲</h3>
        <button
          className="text-button"
          disabled={disabled || draft.episodes.length >= 16}
          onClick={() =>
            change({ episodes: [...draft.episodes, newEpisode()] })
          }
        >
          添加一集
        </button>
      </div>
      {draft.episodes.map((episode, index) => (
        <section
          className="version-card text-editor"
          key={episode.episodeId}
          aria-label={`第 ${index + 1} 集大纲`}
        >
          <div className="panel-heading">
            <strong>第 {index + 1} 集</strong>
            <button
              className="text-button"
              disabled={disabled}
              onClick={() =>
                change({
                  episodes: draft.episodes.filter(
                    (item) => item.episodeId !== episode.episodeId,
                  ),
                })
              }
            >
              移除第 {index + 1} 集
            </button>
          </div>
          <label className="form-field">
            分集标题
            <input
              aria-label={`第 ${index + 1} 集标题`}
              value={episode.title}
              disabled={disabled}
              onChange={(event) =>
                change({
                  episodes: draft.episodes.map((item) =>
                    item.episodeId === episode.episodeId
                      ? { ...item, title: event.target.value }
                      : item,
                  ),
                })
              }
            />
          </label>
          <label className="form-field">
            本集故事
            <textarea
              aria-label={`第 ${index + 1} 集故事`}
              value={episode.summary}
              disabled={disabled}
              onChange={(event) =>
                change({
                  episodes: draft.episodes.map((item) =>
                    item.episodeId === episode.episodeId
                      ? { ...item, summary: event.target.value }
                      : item,
                  ),
                })
              }
            />
          </label>
        </section>
      ))}
      {draft.episodes.length === 0 && (
        <p className="detail-note">添加分集，填写每集的主要冲突与结尾。</p>
      )}
    </div>
  );
}

function ScriptEditor({
  draft,
  controller,
  disabled,
}: {
  draft: ScriptDraft;
  controller: ProjectTextController;
  disabled: boolean;
}) {
  const change = (value: Partial<ScriptDraft>) =>
    controller.setDraft({ ...draft, ...value });
  const updateScene = (
    id: string,
    value: Partial<ScriptDraft["scenes"][number]>,
  ) =>
    change({
      scenes: draft.scenes.map((scene) =>
        scene.sceneId === id ? { ...scene, ...value } : scene,
      ),
    });
  return (
    <div className="text-editor">
      <label className="form-field">
        剧本标题
        <input
          aria-label="剧本标题"
          value={draft.title}
          disabled={disabled}
          onChange={(event) => change({ title: event.target.value })}
        />
      </label>
      <div className="panel-heading">
        <h3>场次与对白</h3>
        <button
          className="text-button"
          disabled={disabled || draft.scenes.length >= 32}
          onClick={() => change({ scenes: [...draft.scenes, newScene()] })}
        >
          添加场次
        </button>
      </div>
      {draft.scenes.map((scene, index) => (
        <section
          className="version-card text-editor"
          key={scene.sceneId}
          aria-label={`第 ${index + 1} 场`}
        >
          <div className="panel-heading">
            <strong>第 {index + 1} 场</strong>
            <button
              className="text-button"
              disabled={disabled}
              onClick={() =>
                change({
                  scenes: draft.scenes.filter(
                    (item) => item.sceneId !== scene.sceneId,
                  ),
                })
              }
            >
              移除第 {index + 1} 场
            </button>
          </div>
          <div className="text-scene-heading">
            <label className="form-field">
              地点
              <input
                aria-label={`第 ${index + 1} 场地点`}
                value={scene.location}
                disabled={disabled}
                onChange={(event) =>
                  updateScene(scene.sceneId, { location: event.target.value })
                }
              />
            </label>
            <label className="form-field">
              时间
              <input
                aria-label={`第 ${index + 1} 场时间`}
                value={scene.timeOfDay}
                disabled={disabled}
                onChange={(event) =>
                  updateScene(scene.sceneId, { timeOfDay: event.target.value })
                }
              />
            </label>
          </div>
          <label className="form-field">
            动作与画面
            <textarea
              aria-label={`第 ${index + 1} 场动作`}
              value={scene.action}
              disabled={disabled}
              onChange={(event) =>
                updateScene(scene.sceneId, { action: event.target.value })
              }
            />
          </label>
          {scene.dialogue.map((line, lineIndex) => (
            <div className="text-dialogue" key={lineIndex}>
              <label className="form-field">
                说话角色
                <input
                  aria-label={`第 ${index + 1} 场对白 ${lineIndex + 1} 角色`}
                  value={line.speaker}
                  disabled={disabled}
                  onChange={(event) =>
                    updateScene(scene.sceneId, {
                      dialogue: scene.dialogue.map((item, at) =>
                        at === lineIndex
                          ? { ...item, speaker: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label className="form-field">
                对白
                <textarea
                  aria-label={`第 ${index + 1} 场对白 ${lineIndex + 1} 内容`}
                  value={line.text}
                  disabled={disabled}
                  onChange={(event) =>
                    updateScene(scene.sceneId, {
                      dialogue: scene.dialogue.map((item, at) =>
                        at === lineIndex
                          ? { ...item, text: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <button
                className="text-button"
                disabled={disabled}
                onClick={() =>
                  updateScene(scene.sceneId, {
                    dialogue: scene.dialogue.filter(
                      (_, at) => at !== lineIndex,
                    ),
                  })
                }
              >
                移除对白 {lineIndex + 1}
              </button>
            </div>
          ))}
          <button
            className="text-button"
            disabled={disabled || scene.dialogue.length >= 64}
            onClick={() =>
              updateScene(scene.sceneId, {
                dialogue: [...scene.dialogue, { speaker: "", text: "" }],
              })
            }
          >
            第 {index + 1} 场添加对白
          </button>
        </section>
      ))}
      {draft.scenes.length === 0 && (
        <p className="detail-note">添加场次，填写地点、时间、动作与对白。</p>
      )}
    </div>
  );
}

export function StoryScriptWorkbench({
  page,
  onPageChange,
  controller,
  details,
  blocked,
}: {
  page: "outline" | "script";
  onPageChange(page: "outline" | "script"): void;
  controller: ProjectTextController;
  details: ProjectDetails;
  blocked: boolean;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.setProject(details);
    const current = controller.getSnapshot();
    if (page === "outline") void controller.open({ kind: "outline" });
    else if (!(current.opening && current.target.kind === "script"))
      void controller.open();
  }, [controller, details.project.projectId, page]);
  useEffect(() => {
    controller.setProject(details);
  }, [controller, details]);
  const disabled =
    blocked ||
    controller.locked ||
    snapshot.opening ||
    details.project.state === "archived" ||
    snapshot.archived;
  const outline = snapshot.outline?.selectedRevision;
  const episodes = new Map(
    outline?.kind === "outline"
      ? outline.content.episodes.map((episode) => [
          episode.episodeId,
          episode.title,
        ])
      : [],
  );
  for (const artifact of snapshot.artifacts)
    if (artifact.kind === "script" && !episodes.has(artifact.episodeId))
      episodes.set(artifact.episodeId, "独立分集剧本");
  const artifact = snapshot.view?.artifact;
  return (
    <section
      className="story-script-workbench"
      aria-label={page === "outline" ? "故事大纲" : "分集剧本"}
    >
      {snapshot.archived && (
        <p className="detail-note" role="status">
          项目已归档，文本内容只能查看。
        </p>
      )}
      <div className="concept-version-bar">
        <div className="detail-actions">
          <button
            className={`button ${snapshot.target.kind === "outline" ? "primary" : "secondary"}`}
            disabled={controller.contentReadBlocked || snapshot.opening}
            onClick={() => onPageChange("outline")}
          >
            故事大纲
          </button>
          {[...episodes].map(([episodeId, title], index) => (
            <button
              className={`button ${snapshot.target.kind === "script" && snapshot.target.episodeId === episodeId ? "primary" : "secondary"}`}
              key={episodeId}
              disabled={controller.contentReadBlocked || snapshot.opening}
              onClick={() => {
                onPageChange("script");
                void controller.open({ kind: "script", episodeId, title });
              }}
            >
              第 {index + 1} 集 · {title}
            </button>
          ))}
          {snapshot.nextArtifactId && (
            <button
              className="text-button"
              disabled={snapshot.opening}
              onClick={() => void controller.loadArtifacts(true)}
            >
              更多分集
            </button>
          )}
        </div>
        <button
          className="text-button"
          disabled={controller.contentReadBlocked || snapshot.opening}
          onClick={() => void controller.open()}
        >
          刷新内容
        </button>
      </div>
      <TextFeedback controller={controller} snapshot={snapshot} />
      {snapshot.phase === "loading" && (
        <p className="detail-note" role="status">
          正在读取内容…
        </p>
      )}
      {snapshot.phase === "unavailable" && (
        <button
          className="button secondary"
          onClick={() => void controller.open()}
        >
          重新读取大纲与剧本
        </button>
      )}
      {page === "script" &&
        snapshot.target.kind !== "script" &&
        snapshot.phase === "ready" && (
          <div className="empty-state">
            <h2>选择分集剧本</h2>
            <p>
              {episodes.size
                ? "选择上方的一集，查看、编辑或采用剧本。"
                : "先保存并采用故事大纲，分集目录会按已采用内容生成。"}
            </p>
          </div>
        )}
      {snapshot.phase === "ready" &&
        snapshot.draft &&
        snapshot.target.kind === page && (
          <>
            <ProjectTextDocument
              revision={snapshot.content}
              selected={
                artifact?.selectedContentRevision ===
                snapshot.content?.contentRevision
              }
              stale={snapshot.view?.dependencyState === "stale"}
            />
            <details className="drama-secondary-disclosure">
              <summary>
                编辑与版本管理{snapshot.dirty ? " · 有未保存修改" : ""}
              </summary>
              <div className="detail-layout">
                <section className="detail-panel">
                  <div className="panel-heading">
                    <h2>
                      {snapshot.target.kind === "outline"
                        ? "故事大纲"
                        : "分集剧本"}
                    </h2>
                    <span className="detail-note">
                      {snapshot.content
                        ? `正在编辑内容 v${snapshot.content.contentRevision}`
                        : "尚未保存"}
                    </span>
                  </div>
                  <p className="detail-note">
                    新候选来源：已保存需求 v{snapshot.sourceBriefRevision}
                    {snapshot.target.kind === "script"
                      ? snapshot.sourceOutline
                        ? ` · 大纲 v${snapshot.sourceOutline.contentRevision}`
                        : " · 独立剧本，无来源大纲"
                      : ""}
                  </p>
                  {(snapshot.sourceBriefRevision !==
                    snapshot.currentBriefRevision ||
                    (snapshot.target.kind === "script" &&
                      snapshot.sourceOutline?.contentRevision !==
                        outline?.contentRevision)) && (
                    <div className="detail-actions">
                      <span className="detail-note">
                        当前来源有更新，原来源与内容保留。
                      </span>
                      <button
                        className="text-button"
                        disabled={disabled}
                        onClick={() => controller.useCurrentSource()}
                      >
                        使用当前来源
                      </button>
                    </div>
                  )}
                  {snapshot.target.kind === "outline" ? (
                    <OutlineEditor
                      draft={snapshot.draft as OutlineDraft}
                      controller={controller}
                      disabled={disabled}
                    />
                  ) : (
                    <ScriptEditor
                      draft={snapshot.draft as ScriptDraft}
                      controller={controller}
                      disabled={disabled}
                    />
                  )}
                  <div className="detail-actions">
                    <button
                      className="button primary"
                      disabled={blocked || !controller.canSave}
                      onClick={() => void controller.save()}
                    >
                      {snapshot.saving ? "正在保存…" : "保存候选版本"}
                    </button>
                    <span className="detail-note">
                      {textBytes(snapshot.draft).toLocaleString()} /{" "}
                      {snapshot.target.kind === "outline" ? "16,384" : "32,768"}{" "}
                      字节
                    </span>
                  </div>
                  <p className="detail-note">
                    填写完整内容后保存。候选不会自动替换已采用版本。
                  </p>
                </section>
                <section className="detail-panel">
                  <div className="panel-heading">
                    <h2>版本与来源</h2>
                    {artifact && (
                      <button
                        className="text-button"
                        disabled={snapshot.saving || snapshot.loadingHistory}
                        onClick={() => void controller.loadHistory()}
                      >
                        查看内容历史
                      </button>
                    )}
                  </div>
                  <p className="detail-note">
                    {artifact?.selectedContentRevision
                      ? `已采用 v${artifact.selectedContentRevision}${artifact.locked ? " · 已锁定" : ""}`
                      : "尚未采用内容版本"}
                  </p>
                  {snapshot.view?.dependencyState === "stale" && (
                    <p className="detail-note" role="status">
                      来源已变化：
                      {snapshot.view.staleReasons
                        .map((reason) =>
                          reason === "brief-changed"
                            ? "创作需求有新版本"
                            : "采用的大纲有变化",
                        )
                        .join("；")}
                      。请检查内容后再继续制作。
                    </p>
                  )}
                  {snapshot.content && (
                    <div className="version-card">
                      <strong>
                        打开的内容 v{snapshot.content.contentRevision}
                      </strong>
                      <p>
                        来源需求 v{snapshot.content.brief.briefRevision}
                        {snapshot.content.outline
                          ? ` · 大纲 v${snapshot.content.outline.contentRevision}`
                          : snapshot.content.kind === "script"
                            ? " · 无来源大纲"
                            : ""}
                      </p>
                      <button
                        className="button secondary"
                        disabled={
                          disabled ||
                          controller.recovery.blocksWrites ||
                          !artifact ||
                          artifact.locked ||
                          snapshot.dirty ||
                          artifact.selectedContentRevision ===
                            snapshot.content.contentRevision
                        }
                        onClick={() => void controller.select()}
                      >
                        采用此版本
                      </button>
                    </div>
                  )}
                  {artifact?.selectedContentRevision && (
                    <button
                      className="button secondary"
                      disabled={disabled || controller.recovery.blocksWrites}
                      onClick={() => void controller.setLocked()}
                    >
                      {artifact.locked ? "解锁采用版本" : "锁定采用版本"}
                    </button>
                  )}
                  {artifact?.locked && (
                    <p className="detail-note">
                      锁定后仍可保存新候选；解锁后才能采用其他版本。
                    </p>
                  )}
                  {snapshot.dirty && snapshot.history.length > 0 && (
                    <p className="detail-note">
                      当前有未保存的修改，保存候选后可打开历史内容。
                    </p>
                  )}
                  {snapshot.history.map((revision) => (
                    <div
                      className="version-card"
                      key={revision.contentRevision}
                    >
                      <strong>
                        内容 v{revision.contentRevision}
                        <span>
                          {artifact?.selectedContentRevision ===
                          revision.contentRevision
                            ? "已采用"
                            : "候选"}
                        </span>
                      </strong>
                      <p>
                        {revision.content.title} · 来源需求 v
                        {revision.brief.briefRevision}
                      </p>
                      <button
                        className="text-button"
                        disabled={
                          controller.locked ||
                          snapshot.opening ||
                          snapshot.dirty
                        }
                        onClick={() => controller.editRevision(revision)}
                      >
                        打开内容 v{revision.contentRevision}
                      </button>
                    </div>
                  ))}
                  {snapshot.nextContentRevision !== null && (
                    <button
                      className="text-button"
                      disabled={snapshot.loadingHistory}
                      onClick={() => void controller.loadHistory(true)}
                    >
                      更多内容历史
                    </button>
                  )}
                  {snapshot.loadingHistory && (
                    <p className="detail-note" role="status">
                      正在读取历史…
                    </p>
                  )}
                  {!outline && episodes.size === 0 && (
                    <p className="detail-note">
                      采用故事大纲后，分集剧本会出现在上方。
                    </p>
                  )}
                </section>
              </div>
            </details>
          </>
        )}
    </section>
  );
}
