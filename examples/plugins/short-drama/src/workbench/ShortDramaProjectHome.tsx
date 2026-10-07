import type { ReactNode } from "react";
import { ArrowRight, Film, FolderOpen, Plus, Search } from "lucide-react";
import {
  briefBytes,
  validBrief,
  type ProjectSnapshot,
} from "./creative-project-controller";

/** Presentation only: all records and writes still belong to the project controller. */
export function ShortDramaProjectHome({
  snapshot,
  locked,
  idea,
  search,
  feedback,
  onIdeaChange,
  onSearchChange,
  onReviewIdea,
  onLoadProjects,
  onOpenProject,
}: {
  snapshot: ProjectSnapshot;
  locked: boolean;
  idea: string;
  search: string;
  feedback: ReactNode;
  onIdeaChange(value: string): void;
  onSearchChange(value: string): void;
  onReviewIdea(value: string): void;
  onLoadProjects(state: "active" | "archived", more?: boolean): void;
  onOpenProject(projectId: string): void;
}) {
  const visibleProjects = snapshot.projects.filter(
    (project) =>
      project.state === snapshot.state && project.title.includes(search),
  );
  const canCreate = !locked && snapshot.phase === "ready";
  const canReview = canCreate && validBrief(idea);
  return (
    <div className="drama-project-home">
      <section className="drama-home-hero" aria-label="开始新的短剧">
        <span className="drama-home-eyebrow">
          <Film size={17} /> AI 短剧工作台
        </span>
        <h1>从一个想法，开始你的短剧</h1>
        <p>告诉 Agent 你想拍什么。一起完成创作，随时查看各阶段产物。</p>
        <form
          className="drama-idea-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (canReview) onReviewIdea(idea);
          }}
        >
          <label className="visually-hidden" htmlFor="drama-project-idea">
            描述你的创作想法
          </label>
          <textarea
            id="drama-project-idea"
            value={idea}
            disabled={!canCreate}
            onChange={(event) => onIdeaChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (canReview) onReviewIdea(idea);
              }
            }}
            placeholder="例如：一名修复师收到一封来自未来的信。做成三集悬疑短剧，先帮我梳理人物和故事。"
            aria-describedby="drama-idea-help"
          />
          <div className="drama-idea-actions">
            <span id="drama-idea-help">先确认需求，再开始制作</span>
            <button
              type="submit"
              className="button primary"
              disabled={!canReview}
            >
              确认创作需求 <ArrowRight size={16} />
            </button>
          </div>
        </form>
        {briefBytes(idea) > 8192 && (
          <p className="detail-note" role="alert">
            需求超过 8,192 字节，请缩短后继续。
          </p>
        )}
      </section>
      <section className="drama-home-projects" aria-label="项目列表">
        <div className="section-row">
          <h2>{snapshot.state === "archived" ? "已归档项目" : "继续创作"}</h2>
          <button
            type="button"
            className="button secondary"
            disabled={!canCreate}
            onClick={() => onReviewIdea("")}
          >
            <Plus size={16} /> 新建项目
          </button>
        </div>
        <div className="section-row">
          <div className="filter-tabs" aria-label="项目状态">
            <button
              type="button"
              className={snapshot.state === "active" ? "active" : ""}
              aria-pressed={snapshot.state === "active"}
              disabled={locked}
              onClick={() => onLoadProjects("active")}
            >
              我的项目
            </button>
            <button
              type="button"
              className={snapshot.state === "archived" ? "active" : ""}
              aria-pressed={snapshot.state === "archived"}
              disabled={locked}
              onClick={() => onLoadProjects("archived")}
            >
              已归档
            </button>
          </div>
          <label className="search-field">
            <Search size={16} />
            <input
              aria-label="搜索已加载项目名称"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索已加载项目名称"
            />
          </label>
        </div>
        {feedback}
        {snapshot.phase === "loading" && (
          <p className="detail-note" role="status">
            正在读取项目列表…
          </p>
        )}
        <div className="project-grid drama-recent-projects">
          {visibleProjects.map((project) => (
            <button
              type="button"
              className="project-card"
              key={project.projectId}
              disabled={locked}
              onClick={() => onOpenProject(project.projectId)}
            >
              <div className="drama-project-card-heading">
                <Film size={20} />
                <span>创作项目</span>
                <ArrowRight size={16} />
              </div>
              <div className="project-card-text">
                <h2>{project.title}</h2>
                <div className="project-card-meta">
                  <span>需求 v{project.latestBriefRevision}</span>
                  <span>
                    {project.state === "archived" ? "已归档" : "继续项目"}
                  </span>
                </div>
                <small>
                  更新于 {new Date(project.updatedAt).toLocaleString("zh-CN")}
                </small>
              </div>
            </button>
          ))}
        </div>
        {snapshot.phase === "ready" && visibleProjects.length === 0 && (
          <div className="empty-state">
            <FolderOpen />
            <h2>{search ? "已加载项目中没有这个名称" : "这里还没有项目"}</h2>
            <p>
              {search
                ? "试试其他名称，或继续加载项目。"
                : snapshot.state === "archived"
                  ? "归档的项目会保留需求和历史。"
                  : "从上面的一个想法开始，也可以新建项目逐步完善。"}
            </p>
          </div>
        )}
        {snapshot.nextCursor && (
          <button
            type="button"
            className="button secondary"
            disabled={locked || snapshot.phase === "loading"}
            onClick={() => onLoadProjects(snapshot.state, true)}
          >
            加载更多项目
          </button>
        )}
      </section>
    </div>
  );
}
