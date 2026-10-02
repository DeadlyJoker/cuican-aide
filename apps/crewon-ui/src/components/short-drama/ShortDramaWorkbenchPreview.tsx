import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Film,
  FolderOpen,
  Image,
  MoreHorizontal,
  Plus,
  Settings2,
  Sparkles,
} from "lucide-react";
import {
  initialDramaProjects,
  type ConceptPreview,
  type DramaProjectPreview,
} from "./short-drama-preview-data";
import { ShortDramaProjectList } from "./ShortDramaProjectList";
import { ShortDramaCreativeBrief } from "./ShortDramaCreativeBrief";
import {
  ShortDramaPreviewDialogs,
  type ShortDramaPreviewDialog,
} from "./ShortDramaPreviewDialogs";
import {
  ArrowUpRight,
  Status,
  stateName,
} from "./ShortDramaPreviewPresentation";
import "./ShortDramaWorkbenchPreview.css";

type Page = "projects" | "overview" | "concept";

/** Isolated visual preview. State is in memory; no API, credentials, or execution is used. */
export function ShortDramaWorkbenchPreview({
  referenceImage,
}: {
  referenceImage: string;
}) {
  const [projects, setProjects] = useState(initialDramaProjects);
  const [projectId, setProjectId] = useState("window-letter");
  const [page, setPage] = useState<Page>("overview");
  const [dialog, setDialog] = useState<ShortDramaPreviewDialog>(null);
  const [version, setVersion] = useState(2);
  const [briefDraft, setBriefDraft] = useState(projects[0]!.briefs.at(-1)!);
  const [promptDraft, setPromptDraft] = useState(
    projects[0]!.concepts[1]!.prompt,
  );
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBrief, setNewBrief] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const project = projects.find((item) => item.id === projectId)!;
  const concept =
    project.concepts.find((item) => item.version === version) ?? null;
  const selected =
    project.concepts.find((item) => item.version === project.selectedVersion) ??
    project.concepts.at(-1) ??
    null;
  const currentBrief = project.briefs.at(-1)!;

  useEffect(() => {
    if (dialog) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [dialog]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const updateProject = (
    update: (value: DramaProjectPreview) => DramaProjectPreview,
  ) =>
    setProjects((all) =>
      all.map((item) => (item.id === projectId ? update(item) : item)),
    );
  function openProject(item: DramaProjectPreview) {
    setProjectId(item.id);
    setBriefDraft(item.briefs.at(-1)!);
    setVersion(item.selectedVersion ?? item.concepts.at(-1)?.version ?? 1);
    setPromptDraft(item.concepts.at(-1)?.prompt ?? "");
    setPage("overview");
  }
  function openConcept(item: ConceptPreview) {
    setVersion(item.version);
    setPromptDraft(item.prompt);
    setPage("concept");
  }
  function newConcept() {
    if (project.archived) return;
    const nextVersion = (project.concepts.at(-1)?.version ?? 0) + 1;
    const prompt =
      (page === "concept" ? concept : selected)?.prompt ?? currentBrief;
    updateProject((item) => ({
      ...item,
      concepts: [
        ...item.concepts,
        {
          version: nextVersion,
          briefVersion: item.briefs.length,
          prompt,
          state: "draft",
        },
      ],
    }));
    setVersion(nextVersion);
    setPromptDraft(prompt);
    setPage("concept");
    setNotice(`已创建概念图 v${nextVersion} 草稿`);
  }
  function saveBrief() {
    const trimmed = briefDraft.trim();
    if (project.archived || !trimmed || trimmed === currentBrief) return;
    updateProject((item) => ({
      ...item,
      briefs: [...item.briefs, trimmed],
      updated: "刚刚编辑",
    }));
    setBriefDraft(trimmed);
    setNotice("已保存新的需求版本，原概念图继续保留");
  }
  function changeConcept(state: ConceptPreview["state"]) {
    if (
      !concept ||
      (project.archived &&
        !(concept.state === "queued" && state === "succeeded"))
    )
      return;
    updateProject((item) => ({
      ...item,
      concepts: item.concepts.map((image) =>
        image.version === version
          ? { ...image, prompt: promptDraft.trim(), state }
          : image,
      ),
    }));
    setNotice(
      state === "queued"
        ? "演示任务已提交，图片尚未完成"
        : project.archived
          ? "演示查询完成，恢复项目后可以选用画面"
          : "演示查询完成，可以查看并选用画面",
    );
  }
  function selectConcept() {
    if (project.archived) return;
    updateProject((item) => ({ ...item, selectedVersion: version }));
    setNotice(`已将概念图 v${version} 设为选用`);
  }
  function createProject() {
    if (!newTitle.trim() || !newBrief.trim()) return;
    const item: DramaProjectPreview = {
      id: crypto.randomUUID(),
      name: newTitle.trim(),
      summary: newBrief.trim().slice(0, 48),
      genre: "创作项目",
      updated: "刚刚创建",
      briefs: [newBrief.trim()],
      concepts: [],
      selectedVersion: null,
      archived: false,
    };
    setProjects((all) => [...all, item]);
    setDialog(null);
    setNewTitle("");
    setNewBrief("");
    openProject(item);
    setNotice("演示项目已创建");
  }
  function archiveProject() {
    updateProject((item) => ({ ...item, archived: !item.archived }));
    setPage("projects");
    setNotice(project.archived ? "项目已恢复" : "项目已归档，版本记录继续保留");
  }
  const stages = [
    "项目与概念图",
    "大纲与剧本",
    "角色与场景",
    "分镜",
    "视频与成片",
  ];
  const imageLabel = "画面示意 · 已有 Krea2 测试样例";

  return (
    <div className="drama-workbench">
      <aside className="drama-sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <strong>CrewON</strong>
          <button
            className="button icon"
            aria-label="查看预览说明"
            onClick={() =>
              setNotice("这是独立的页面预览，不改变现有聊天与团队入口")
            }
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
        <div className="workspace-switch">
          <span className="workspace-mark">W</span>
          <span>
            个人工作空间<small>创作与灵感</small>
          </span>
          <ChevronDown size={14} />
        </div>
        <button
          className="nav-link"
          onClick={() => {
            setPage("projects");
            setShowArchived(false);
          }}
        >
          <FolderOpen size={17} />
          项目总览
        </button>
        <button
          className="nav-link active"
          onClick={() => {
            setPage("overview");
          }}
        >
          <Clapperboard size={17} />
          短剧工作台
          <span className="nav-dot" />
        </button>
        <div className="side-section">
          <span>创作项目</span>
          <button
            className="button icon"
            aria-label="新建创作项目"
            onClick={() => setDialog("new")}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav aria-label="创作项目" className="project-nav">
          {projects
            .filter((item) => !item.archived)
            .map((item) => (
              <button
                key={item.id}
                className={
                  projectId === item.id && page !== "projects" ? "active" : ""
                }
                onClick={() => openProject(item)}
              >
                <span
                  className={`project-dot ${item.id === "window-letter" ? "olive" : ""}`}
                />
                {item.name}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="film-note">
            <Film size={19} />
            <strong>从故事，到画面</strong>
            <span>保留每一次创作的来处。</span>
          </div>
          <button className="nav-link" onClick={() => setDialog("settings")}>
            <Settings2 size={16} />
            生成服务设置
          </button>
          <div className="account">
            <span className="avatar">W</span>
            <span>
              我的工作空间<small>个人创作</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="drama-main">
        <header className="drama-topbar">
          <div className="breadcrumbs">
            <button onClick={() => setPage("projects")}>资源库</button>
            <ChevronRight size={13} />
            <button onClick={() => setPage("projects")}>短剧工作台</button>
            {page !== "projects" && (
              <>
                <ChevronRight size={13} />
                <span>{project.name}</span>
              </>
            )}
          </div>
          <div className="topbar-actions">
            <span className="preview-tag">
              <span />
              页面预览
            </span>
            <button
              className="button icon"
              aria-label="生成服务设置"
              onClick={() => setDialog("settings")}
            >
              <Settings2 size={17} />
            </button>
          </div>
        </header>
        <div className="preview-strip">
          <span>演示数据 · 操作只预览页面变化，不调用生图服务</span>
          <span>本次编辑仅在当前页面保留</span>
        </div>
        <div className="drama-content">
          {page === "projects" ? (
            <ShortDramaProjectList
              projects={projects}
              referenceImage={referenceImage}
              search={search}
              showArchived={showArchived}
              onSearchChange={setSearch}
              onShowArchivedChange={setShowArchived}
              onNewProject={() => setDialog("new")}
              onOpenProject={openProject}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {page === "concept"
                      ? "CONCEPT / VISUAL DEVELOPMENT"
                      : "PROJECT / VISUAL DEVELOPMENT"}
                  </span>
                  <h1>{page === "concept" ? "概念图" : project.name}</h1>
                  <p>
                    {page === "concept"
                      ? "一张画面，一版明确的创作意图。"
                      : project.summary}
                  </p>
                </div>
                <div className="heading-actions">
                  {page === "concept" ? (
                    <button
                      className="button secondary"
                      onClick={() => setPage("overview")}
                    >
                      <ArrowLeft size={15} />
                      返回项目
                    </button>
                  ) : (
                    <>
                      <span className="genre-label">{project.genre}</span>
                      <button
                        className="button secondary"
                        onClick={archiveProject}
                      >
                        {project.archived ? "恢复项目" : "归档项目"}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {project.archived && (
                <p className="detail-note" role="status">
                  项目已归档。历史与已提交任务仍可查看和查询，恢复项目后继续创作。
                </p>
              )}
              {page === "overview" ? (
                <>
                  <div className="stage-rail" aria-label="创作阶段">
                    {stages.map((title, index) => (
                      <div
                        key={title}
                        className={`stage-item ${index === 0 ? "active" : "later"}`}
                      >
                        <span className="stage-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span>
                          {title}
                          <small>{index === 0 ? "当前阶段" : "后续开放"}</small>
                        </span>
                        {index < stages.length - 1 && (
                          <ChevronRight size={13} />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="concept-grid">
                    <ShortDramaCreativeBrief
                      project={project}
                      draft={briefDraft}
                      currentBrief={currentBrief}
                      onDraftChange={(value) => {
                        if (!project.archived) setBriefDraft(value);
                      }}
                      onSave={saveBrief}
                      onOpenHistory={() => setDialog("brief-history")}
                    />
                    <section className="concept-panel">
                      <div className="panel-heading">
                        <h2>
                          <Image size={17} />
                          概念图
                        </h2>
                        <button
                          className="text-button"
                          disabled={project.archived}
                          onClick={newConcept}
                        >
                          <Plus size={14} />
                          生成新版本
                        </button>
                      </div>
                      {selected ? (
                        <button
                          className="concept-art"
                          onClick={() => openConcept(selected)}
                        >
                          {selected.state === "succeeded" ? (
                            <img
                              src={referenceImage}
                              alt="概念图画面示意，使用已生成的 Krea2 测试样例"
                            />
                          ) : (
                            <div className="art-placeholder">
                              <Image size={32} />
                              <span>
                                {selected.state === "draft"
                                  ? "确认描述，开始一张新画面"
                                  : "任务已提交，画面等待生成"}
                              </span>
                            </div>
                          )}
                          <div className="art-overlay">
                            <span className="version-chip">
                              v{selected.version}
                              {project.selectedVersion === selected.version && (
                                <>
                                  <Check size={12} />
                                  当前选用
                                </>
                              )}
                            </span>
                            <span>
                              查看概念图 <ArrowRight size={16} />
                            </span>
                          </div>
                        </button>
                      ) : (
                        <div className="empty-state">
                          <Image size={29} />
                          <h3>给故事找到第一张画面</h3>
                          <p>从你确认的描述开始。</p>
                          <button
                            className="button primary"
                            disabled={project.archived}
                            onClick={newConcept}
                          >
                            <Sparkles size={16} />
                            创建概念图
                          </button>
                        </div>
                      )}
                      <div className="image-caption">
                        <span>
                          {selected?.state === "succeeded"
                            ? imageLabel
                            : "生成状态仅供交互演示"}
                        </span>
                        <span>
                          {selected ? `基于需求 v${selected.briefVersion}` : ""}
                        </span>
                      </div>
                    </section>
                  </div>
                  <div className="section-row versions-heading">
                    <div>
                      <h2>概念图版本</h2>
                      <p>每次重做保留原画面和输入，选用不会覆盖历史。</p>
                    </div>
                    <span className="subtle">
                      {project.concepts.length} 个版本
                    </span>
                  </div>
                  <div className="revision-list">
                    {[...project.concepts].reverse().map((item) => (
                      <button
                        className={`revision-item ${item.version === project.selectedVersion ? "active" : ""}`}
                        key={item.version}
                        onClick={() => openConcept(item)}
                      >
                        <div className="revision-thumb">
                          {item.state === "succeeded" ? (
                            <img src={referenceImage} alt="画面示意缩略图" />
                          ) : (
                            <Image size={20} />
                          )}
                        </div>
                        <span>
                          <strong>概念图 v{item.version}</strong>
                          <small>
                            需求 v{item.briefVersion}
                            {item.briefVersion < project.briefs.length
                              ? " · 来自旧版需求"
                              : " · 当前需求"}
                          </small>
                        </span>
                        <span className="revision-status">
                          {item.version === project.selectedVersion ? (
                            <>
                              <Check size={12} />
                              已选用
                            </>
                          ) : (
                            stateName(item.state)
                          )}
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                </>
              ) : concept ? (
                <>
                  <div className="concept-version-bar">
                    <label>
                      概念图版本
                      <select
                        value={version}
                        onChange={(event) => {
                          const item = project.concepts.find(
                            (image) =>
                              image.version === Number(event.target.value),
                          )!;
                          openConcept(item);
                        }}
                      >
                        {[...project.concepts].reverse().map((item) => (
                          <option key={item.version} value={item.version}>
                            v{item.version}
                            {item.version === project.selectedVersion
                              ? " · 当前选用"
                              : ""}{" "}
                            · {stateName(item.state)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="subtle">
                      基于需求 v{concept.briefVersion}
                      {concept.briefVersion < project.briefs.length
                        ? " · 来自旧版需求"
                        : ""}
                    </span>
                  </div>
                  <div className="detail-layout">
                    <section className="detail-art">
                      {concept.state === "succeeded" ? (
                        <img
                          src={referenceImage}
                          alt="概念图结果示意，使用已有 Krea2 测试样例"
                        />
                      ) : (
                        <div className="art-placeholder">
                          <Image size={42} />
                          <h2>
                            {concept.state === "queued"
                              ? "让画面慢慢出现"
                              : "下一张画面，从这里开始"}
                          </h2>
                          <p>
                            {concept.state === "queued"
                              ? "调用已结束，外部生成仍在排队。"
                              : "确认右侧描述，再开始生成。"}
                          </p>
                        </div>
                      )}
                      <div className="image-caption">
                        {concept.state === "succeeded"
                          ? imageLabel
                          : "页面演示 · 未调用外部服务"}
                      </div>
                    </section>
                    <section className="detail-panel">
                      <div className="panel-heading">
                        <h2>生成描述</h2>
                        <span className="version-chip">v{concept.version}</span>
                      </div>
                      <label
                        className="visually-hidden"
                        htmlFor="concept-prompt"
                      >
                        生成描述
                      </label>
                      <textarea
                        id="concept-prompt"
                        className="description-input"
                        value={promptDraft}
                        disabled={project.archived || concept.state !== "draft"}
                        maxLength={2000}
                        onChange={(event) => {
                          if (!project.archived)
                            setPromptDraft(event.target.value);
                        }}
                      />
                      <div className="prompt-length">
                        {promptDraft.length} / 2,000
                      </div>
                      <div className="status-stack">
                        <Status
                          label="创作选择"
                          value={
                            project.selectedVersion === version
                              ? "当前选用"
                              : "未选用"
                          }
                          positive={project.selectedVersion === version}
                        />
                        <Status
                          label="CrewON 调用"
                          value={
                            concept.state === "draft" ? "未开始" : "已结束"
                          }
                        />
                        <Status
                          label="外部生成"
                          value={
                            concept.state === "draft"
                              ? "未提交"
                              : concept.state === "queued"
                                ? "排队中"
                                : "已完成"
                          }
                          positive={concept.state === "succeeded"}
                        />
                      </div>
                      <div className="detail-actions">
                        {concept.state === "draft" ? (
                          <button
                            className="button primary"
                            disabled={project.archived || !promptDraft.trim()}
                            onClick={() => changeConcept("queued")}
                          >
                            <Sparkles size={16} />
                            开始生成
                          </button>
                        ) : concept.state === "queued" ? (
                          <button
                            className="button primary"
                            onClick={() => changeConcept("succeeded")}
                          >
                            查询原任务
                            <ArrowRight size={15} />
                          </button>
                        ) : (
                          <button
                            className="button primary"
                            disabled={
                              project.archived ||
                              project.selectedVersion === version
                            }
                            onClick={selectConcept}
                          >
                            <Check size={16} />
                            {project.selectedVersion === version
                              ? "已设为选用"
                              : "设为选用"}
                          </button>
                        )}
                        <button
                          className="button secondary"
                          disabled={project.archived}
                          onClick={newConcept}
                        >
                          <Plus size={15} />
                          生成新版本
                        </button>
                      </div>
                      {concept.state !== "draft" && (
                        <button
                          className="text-button record-button"
                          onClick={() => setDialog("record")}
                        >
                          查看生成记录
                          <ArrowUpRight />
                        </button>
                      )}
                      <p className="detail-note">
                        {concept.state === "queued"
                          ? "继续查询已有任务，无需再次提交。这里仅演示页面状态变化。"
                          : "编辑描述请创建新版本，已生成的版本保留原始输入。"}
                      </p>
                    </section>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <Image />
                  <h2>还没有概念图</h2>
                  <button
                    className="button primary"
                    disabled={project.archived}
                    onClick={newConcept}
                  >
                    创建概念图
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      <ShortDramaPreviewDialogs
        dialog={dialog}
        dialogRef={dialogRef}
        project={project}
        concept={concept}
        newTitle={newTitle}
        newBrief={newBrief}
        onTitleChange={setNewTitle}
        onBriefChange={setNewBrief}
        onCreate={createProject}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
