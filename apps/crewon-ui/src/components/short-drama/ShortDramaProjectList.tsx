import { Film, FolderOpen, Plus, Search } from "lucide-react";
import type { DramaProjectPreview } from "./short-drama-preview-data";
import {
  ArrowUpRight,
  ShortDramaAccessNotice,
  stateName,
} from "./ShortDramaPreviewPresentation";

/** Project-list presentation for the isolated in-memory preview. */
export function ShortDramaProjectList({
  projects,
  referenceImage,
  search,
  showArchived,
  onSearchChange,
  onShowArchivedChange,
  onNewProject,
  onOpenProject,
}: {
  projects: readonly DramaProjectPreview[];
  referenceImage: string;
  search: string;
  showArchived: boolean;
  onSearchChange(value: string): void;
  onShowArchivedChange(archived: boolean): void;
  onNewProject(): void;
  onOpenProject(project: DramaProjectPreview): void;
}) {
  const visibleProjects = projects.filter(
    (item) => item.archived === showArchived && item.name.includes(search),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>短剧工作台</h1>
          <p>从一个故事开始，逐步整理需求、画面与创作成果。</p>
        </div>
        <button className="button primary" onClick={() => onNewProject()}>
          <Plus size={16} />
          新建项目
        </button>
      </div>
      <ShortDramaAccessNotice />
      <div className="section-row">
        <div className="filter-tabs">
          <button
            className={!showArchived ? "active" : ""}
            onClick={() => onShowArchivedChange(false)}
          >
            我的项目{" "}
            <small>{projects.filter((item) => !item.archived).length}</small>
          </button>
          <button
            className={showArchived ? "active" : ""}
            onClick={() => onShowArchivedChange(true)}
          >
            已归档
          </button>
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索项目名称"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索项目名称"
          />
        </label>
      </div>
      <div className="project-grid">
        {visibleProjects.map((item, index) => (
          <button
            key={item.id}
            className="project-card"
            onClick={() => onOpenProject(item)}
          >
            <div className={`project-card-photo project-tone-${index}`}>
              {item.id === "window-letter" ? (
                <img src={referenceImage} alt="窗边茶壶的 Krea2 测试样例" />
              ) : (
                <div className="project-art-placeholder">
                  <Film size={32} />
                  <span>
                    {item.concepts.length ? "概念图待查看" : "故事正在开始"}
                  </span>
                </div>
              )}
              <span className="cover-label">{item.genre}</span>
            </div>
            <div className="project-card-text">
              <h2>
                {item.name}
                <ArrowUpRight />
              </h2>
              <p>{item.summary}</p>
              <div className="project-card-meta">
                <span>需求 v{item.briefs.length}</span>
                <span>
                  {item.selectedVersion
                    ? `概念图 v${item.selectedVersion} 已选用`
                    : item.concepts.length
                      ? `概念图 v${item.concepts.at(-1)!.version} · ${stateName(item.concepts.at(-1)!.state)}`
                      : "待完善画面"}
                </span>
              </div>
              <small>{item.updated}</small>
            </div>
          </button>
        ))}
      </div>
      {visibleProjects.length === 0 && (
        <div className="empty-state">
          <FolderOpen />
          <h2>{search ? "没有找到这个项目" : "这里还没有项目"}</h2>
          <p>
            {search ? "试试其他名称。" : "先保存一个故事，再慢慢找到它的画面。"}
          </p>
        </div>
      )}
    </>
  );
}
