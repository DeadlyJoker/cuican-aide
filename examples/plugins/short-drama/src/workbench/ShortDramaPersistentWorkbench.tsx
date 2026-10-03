import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ChevronRight,
  Clock3,
  Film,
  FolderOpen,
  Layers3,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  CreativeProjectController,
  briefBytes,
  validBrief,
  validTitle,
  type ProjectSnapshot,
} from "./creative-project-controller";
import { ConceptWorkbench } from "./ConceptWorkbench";
import { ConceptGenerationActions } from "./ConceptGenerationActions";
import { ConceptQueryActions } from "./ConceptQueryActions";

function SaveFeedback({
  controller,
  snapshot,
}: {
  controller: CreativeProjectController;
  snapshot: ProjectSnapshot;
}) {
  return (
    <>
      {snapshot.error && (
        <p className="detail-note" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.failure === "uncertain" && (
        <button
          type="button"
          className="button secondary"
          disabled={snapshot.saving}
          onClick={() => void controller.retry()}
        >
          重试原请求
        </button>
      )}
      {snapshot.failure === "conflict" && !snapshot.conflictRefreshed && (
        <button
          type="button"
          className="button secondary"
          disabled={snapshot.opening}
          onClick={() => void controller.refreshConflict()}
        >
          重新读取版本
        </button>
      )}
      {snapshot.failure === "conflict" && snapshot.conflictRefreshed && (
        <button
          type="button"
          className="button secondary"
          disabled={snapshot.saving}
          onClick={() =>
            void (snapshot.pendingKind === "brief"
              ? controller.saveBrief()
              : controller.setProjectState())
          }
        >
          按最新版本保存
        </button>
      )}
      {snapshot.notice && (
        <p className="detail-note" role="status">
          {snapshot.notice}
        </p>
      )}
    </>
  );
}

/** The original module layout with saved sources and read-only original task records. */
export function ShortDramaPersistentWorkbench({
  controller,
}: {
  controller: CreativeProjectController;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<"new" | "history" | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { details } = snapshot;
  const projectLocked = snapshot.saving || snapshot.pendingKind !== null;
  const locked = projectLocked || snapshot.conceptLocked;
  const archived = details?.project.state === "archived";
  const visibleProjects = snapshot.projects.filter(
    (project) =>
      project.state === snapshot.state && project.title.includes(search),
  );

  useEffect(() => {
    if (dialog) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [dialog]);
  useEffect(() => {
    const element = dialogRef.current;
    return () => {
      if (element?.open) element.close();
    };
  }, []);
  useEffect(() => {
    if (snapshot.notice === "项目已保存") {
      setDialog(null);
      setTitle("");
      setBrief("");
    }
  }, [snapshot.notice]);

  return (
    <section className="drama-workbench" aria-label="AI 短剧工作台">
      <div className="drama-main">
        <header className="drama-topbar">
          <nav className="breadcrumbs" aria-label="AI 短剧路径">
            <button disabled={locked} onClick={() => controller.closeProject()}>
              AI 短剧
            </button>
            <ChevronRight size={13} />
            <span>
              {details
                ? details.project.title
                : snapshot.state === "archived"
                  ? "已归档"
                  : "我的项目"}
            </span>
          </nav>
          <div className="topbar-actions">
            <span className="preview-tag">项目与需求</span>
          </div>
        </header>
        <div className="preview-strip">
          <span>项目与需求版本会保存，可在重新进入模块后读取</span>
          <span>
            {controller.concepts.submissions.hasHostContext
              ? "生成仅使用已保存的概念版本，实际准入由宿主核验"
              : "生图能力尚未接入，当前操作不创建生成任务"}
          </span>
        </div>
        <div className="drama-content">
          {!details &&
            controller.concepts.submissions.getSnapshot().request && (
              <ConceptGenerationActions
                controller={controller.concepts.submissions}
              />
            )}
          {!details && controller.concepts.queries.getSnapshot().request && (
            <ConceptQueryActions controller={controller.concepts.queries} />
          )}
          {snapshot.phase === "waiting" ? (
            <p className="detail-note" role="status">
              正在等待模块就绪…
            </p>
          ) : snapshot.phase === "unavailable" ? (
            <div className="empty-state">
              <FolderOpen />
              <h2>项目服务暂不可用</h2>
              <p role="alert">{snapshot.error}</p>
              <button
                className="button secondary"
                onClick={() => void controller.loadProjects()}
              >
                重新连接
              </button>
            </div>
          ) : snapshot.opening && !details ? (
            <p className="detail-note" role="status">
              正在读取项目…
            </p>
          ) : !details ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>短剧工作台</h1>
                  <p>从一个故事开始，逐步整理需求、画面与创作成果。</p>
                </div>
                <button
                  className="button primary"
                  disabled={locked || snapshot.phase !== "ready"}
                  onClick={() => setDialog("new")}
                >
                  <Plus size={16} />
                  新建项目
                </button>
              </div>
              <div className="section-row">
                <div className="filter-tabs">
                  <button
                    className={snapshot.state === "active" ? "active" : ""}
                    disabled={locked}
                    onClick={() => void controller.loadProjects("active")}
                  >
                    我的项目
                  </button>
                  <button
                    className={snapshot.state === "archived" ? "active" : ""}
                    disabled={locked}
                    onClick={() => void controller.loadProjects("archived")}
                  >
                    已归档
                  </button>
                </div>
                <label className="search-field">
                  <Search size={16} />
                  <input
                    aria-label="搜索已加载项目名称"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索已加载项目名称"
                  />
                </label>
              </div>
              <SaveFeedback controller={controller} snapshot={snapshot} />
              {snapshot.phase === "loading" && (
                <p className="detail-note" role="status">
                  正在读取项目列表…
                </p>
              )}
              <div className="project-grid">
                {visibleProjects.map((project, index) => (
                  <button
                    className="project-card"
                    key={project.projectId}
                    disabled={locked}
                    onClick={() =>
                      void controller.openProject(project.projectId)
                    }
                  >
                    <div
                      className={`project-card-photo project-tone-${index % 3}`}
                    >
                      <div className="project-art-placeholder">
                        <Film size={32} />
                        <span>故事正在开始</span>
                      </div>
                      <span className="cover-label">创作项目</span>
                    </div>
                    <div className="project-card-text">
                      <h2>{project.title}</h2>
                      <p>需求版本会保留每次确认的内容。</p>
                      <div className="project-card-meta">
                        <span>需求 v{project.latestBriefRevision}</span>
                        <span>
                          {project.state === "archived"
                            ? "已归档"
                            : "待完善画面"}
                        </span>
                      </div>
                      <small>
                        {new Date(project.updatedAt).toLocaleString("zh-CN")}
                      </small>
                    </div>
                  </button>
                ))}
              </div>
              {snapshot.phase === "ready" && visibleProjects.length === 0 && (
                <div className="empty-state">
                  <FolderOpen />
                  <h2>
                    {search ? "已加载项目中没有这个名称" : "这里还没有项目"}
                  </h2>
                  <p>
                    {search
                      ? "试试其他名称，或继续加载项目。"
                      : "先保存一个故事，再慢慢找到它的画面。"}
                  </p>
                </div>
              )}
              {snapshot.nextCursor && (
                <button
                  className="button secondary"
                  disabled={locked || snapshot.phase === "loading"}
                  onClick={() =>
                    void controller.loadProjects(snapshot.state, true)
                  }
                >
                  加载更多项目
                </button>
              )}
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <h1>{details.project.title}</h1>
                  <p>先确认故事，再保存每一次新的创作需求。</p>
                </div>
                <div className="heading-actions">
                  <span className="genre-label">创作项目</span>
                  <button
                    className="button secondary"
                    disabled={locked || snapshot.opening}
                    onClick={() => void controller.setProjectState()}
                  >
                    {archived ? "恢复项目" : "归档项目"}
                  </button>
                </div>
              </div>
              <SaveFeedback controller={controller} snapshot={snapshot} />
              {archived && (
                <p className="detail-note" role="status">
                  项目已归档。需求历史仍可查看，恢复项目后继续编辑。
                </p>
              )}
              <div className="stage-rail" aria-label="创作阶段">
                {[
                  "项目与概念图",
                  "大纲与剧本",
                  "角色与场景",
                  "分镜",
                  "视频与成片",
                ].map((stage, index) => (
                  <div
                    key={stage}
                    className={`stage-item ${index === 0 ? "active" : "later"}`}
                  >
                    <span className="stage-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span>
                      {stage}
                      <small>{index === 0 ? "当前阶段" : "后续开放"}</small>
                    </span>
                    {index < 4 && <ChevronRight size={13} />}
                  </div>
                ))}
              </div>
              <div className="concept-grid">
                <section className="brief-panel">
                  <div className="panel-heading">
                    <h2>
                      <Layers3 size={17} />
                      创作需求
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => {
                        setDialog("history");
                        void controller.loadBriefs();
                      }}
                    >
                      v{details.brief.briefRevision} · 查看历史
                    </button>
                  </div>
                  <label className="visually-hidden" htmlFor="creative-brief">
                    创作需求
                  </label>
                  <textarea
                    id="creative-brief"
                    className="description-input"
                    value={snapshot.draft}
                    disabled={archived || locked || snapshot.opening}
                    onChange={(event) =>
                      controller.setDraft(event.target.value)
                    }
                  />
                  <div className="brief-footer">
                    <span>
                      <Clock3 size={13} />
                      {briefBytes(snapshot.draft)} / 8,192 字节
                    </span>
                    <button
                      className="button secondary"
                      disabled={
                        archived ||
                        locked ||
                        snapshot.opening ||
                        !validBrief(snapshot.draft) ||
                        snapshot.draft === details.brief.text
                      }
                      onClick={() => void controller.saveBrief()}
                    >
                      {snapshot.saving ? "正在保存…" : "保存为新版本"}
                    </button>
                  </div>
                  {briefBytes(snapshot.draft) > 8192 && (
                    <p className="detail-note" role="alert">
                      需求超过 8,192 字节，请缩短后保存。
                    </p>
                  )}
                  <div className="brief-help">
                    需求改变会保存新版本，原始换行与空格会保留。
                  </div>
                </section>
                <ConceptWorkbench
                  controller={controller.concepts}
                  details={details}
                  blocked={projectLocked || snapshot.opening}
                />
              </div>
            </>
          )}
        </div>
      </div>
      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby="drama-persistent-modal-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!locked) setDialog(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !locked) setDialog(null);
        }}
      >
        <div className="modal-header">
          <h2 id="drama-persistent-modal-title">
            {dialog === "new" ? "新的创作项目" : "需求版本"}
          </h2>
          <button
            className="button icon"
            aria-label="关闭弹窗"
            disabled={locked}
            onClick={() => setDialog(null)}
          >
            <X size={18} />
          </button>
        </div>
        {dialog === "new" ? (
          <form
            className="modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              void controller.createProject(title, brief);
            }}
          >
            <p className="subtle">先留住故事，再慢慢找到它的画面。</p>
            <label className="form-field">
              项目名称
              <input
                autoFocus
                required
                value={title}
                disabled={locked}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="给这个故事起个名字"
              />
            </label>
            <label className="form-field">
              创作需求
              <textarea
                required
                value={brief}
                disabled={locked}
                onChange={(event) => setBrief(event.target.value)}
                placeholder="故事讲什么？想让观众感受到什么？"
              />
            </label>
            <p className="subtle">需求 {briefBytes(brief)} / 8,192 字节</p>
            {!validTitle(title) && Boolean(title.trim()) && (
              <p className="detail-note" role="alert">
                项目名称最多 160 个字符。
              </p>
            )}
            {briefBytes(brief) > 8192 && (
              <p className="detail-note" role="alert">
                需求超过 8,192 字节，请缩短后保存。
              </p>
            )}
            <SaveFeedback controller={controller} snapshot={snapshot} />
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={locked}
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={locked || !validTitle(title) || !validBrief(brief)}
              >
                {snapshot.saving ? "正在保存…" : "创建项目"}
              </button>
            </div>
          </form>
        ) : dialog === "history" ? (
          <div className="modal-form">
            {snapshot.loadingBriefs && (
              <p className="subtle" role="status">
                正在读取需求历史…
              </p>
            )}
            {snapshot.error && (
              <p className="detail-note" role="alert">
                {snapshot.error}
              </p>
            )}
            {snapshot.briefs.map((record) => (
              <div className="version-card" key={record.briefRevision}>
                <strong>
                  需求 v{record.briefRevision}
                  {record.briefRevision ===
                    details?.project.latestBriefRevision && (
                    <span>当前版本</span>
                  )}
                </strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{record.text}</p>
              </div>
            ))}
            {snapshot.nextBriefRevision !== null && (
              <button
                className="button secondary"
                disabled={snapshot.loadingBriefs}
                onClick={() => void controller.loadBriefs(true)}
              >
                加载更多需求版本
              </button>
            )}
            {!snapshot.loadingBriefs && snapshot.error && (
              <button
                className="button secondary"
                onClick={() => void controller.loadBriefs()}
              >
                重新读取需求历史
              </button>
            )}
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
