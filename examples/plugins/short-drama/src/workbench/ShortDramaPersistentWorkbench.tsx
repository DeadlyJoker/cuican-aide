import type { ProjectMediaGenerationController } from "./ProjectMediaGenerationController";
import { usePluginDialog } from "./usePluginDialog";
import { ShortDramaProjectHome } from "./ShortDramaProjectHome";
import {
  ShortDramaProjectNavigation,
  projectPages,
  type ShortDramaProjectPage,
} from "./ShortDramaProjectNavigation";
import { ProjectMediaInputController } from "./ProjectMediaInputController";
import { ProjectMediaInputWorkbench } from "./ProjectMediaInputWorkbench";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Clock3, FolderOpen, Layers3, X } from "lucide-react";
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
import { ConceptImageSelectionActions } from "./ConceptImageSelectionActions";
import { ConceptRecoveryActions } from "./ConceptRecoveryActions";
import { ProjectTextController } from "./ProjectTextController";
import { StoryScriptWorkbench } from "./StoryScriptWorkbench";
import { ProjectTextRecoveryActions } from "./ProjectTextRecoveryActions";
import { ProjectConversationController } from "./ProjectConversationController";
import { ProjectConversationActions } from "./ProjectConversationActions";
import { ProjectConversationAssociationActions } from "./ProjectConversationAssociationActions";
import type { ProjectConversationAssociationController } from "./ProjectConversationAssociationController";
import { ProjectTextPlanController } from "./ProjectTextPlanController";
import { ProjectTextPlanActions } from "./ProjectTextPlanActions";
import { ProjectPlanningDraftReview } from "./ProjectPlanningDraftReview";
import type { ProjectPlanningProposal } from "../project-planning-service";
import { ProjectAssetController } from "./ProjectAssetController";
import { ProjectAssetWorkbench } from "./ProjectAssetWorkbench";
import { ProjectAssetRecoveryActions } from "./ProjectAssetRecoveryActions";
const emptySubscribe = () => () => undefined;
const noAssetSnapshot = () => null;

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
  texts,
  conversations,
  plans,
  assets,
  mediaInputs,
  mediaGenerations,
  planningDraft = null,
  association,
  associationReady = false,
  associationThreadId = null,
}: {
  controller: CreativeProjectController;
  texts: ProjectTextController;
  conversations: ProjectConversationController;
  plans: ProjectTextPlanController;
  assets?: ProjectAssetController;
  mediaInputs?: ProjectMediaInputController;
  mediaGenerations?: ProjectMediaGenerationController;
  planningDraft?: ProjectPlanningProposal | null;
  association?: ProjectConversationAssociationController;
  associationReady?: boolean;
  associationThreadId?: string | null;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const textSnapshot = useSyncExternalStore(
    texts.subscribe,
    texts.getSnapshot,
    texts.getSnapshot,
  );
  useSyncExternalStore(
    conversations.subscribe,
    conversations.getSnapshot,
    conversations.getSnapshot,
  );
  useSyncExternalStore(plans.subscribe, plans.getSnapshot, plans.getSnapshot);
  useSyncExternalStore(
    association?.subscribe ?? emptySubscribe,
    association?.getSnapshot ?? noAssetSnapshot,
    association?.getSnapshot ?? noAssetSnapshot,
  );
  useSyncExternalStore(
    assets?.subscribe ?? emptySubscribe,
    assets?.getSnapshot ?? noAssetSnapshot,
    assets?.getSnapshot ?? noAssetSnapshot,
  );
  useSyncExternalStore(
    mediaInputs?.subscribe ?? emptySubscribe,
    mediaInputs?.getSnapshot ?? noAssetSnapshot,
    mediaInputs?.getSnapshot ?? noAssetSnapshot,
  );
  useSyncExternalStore(
    mediaGenerations?.subscribe ?? emptySubscribe,
    mediaGenerations?.getSnapshot ?? noAssetSnapshot,
    mediaGenerations?.getSnapshot ?? noAssetSnapshot,
  );
  const [page, setPage] = useState<ShortDramaProjectPage>("overview");
  const [search, setSearch] = useState("");
  const [homeIdea, setHomeIdea] = useState("");
  const [navigationExpanded, setNavigationExpanded] = useState(true);
  const [dialog, setDialog] = useState<"new" | "history" | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittedDraft = useRef<ProjectPlanningProposal | null>(null);
  const reviewedDraft = useRef<ProjectPlanningProposal | null>(null);
  const [projectDraft, setProjectDraft] = useState<Readonly<{
    projectId: string;
    proposal: ProjectPlanningProposal;
  }> | null>(null);
  const { details } = snapshot;
  const projectLocked = snapshot.saving || snapshot.pendingKind !== null;
  const otherLocked =
    projectLocked ||
    snapshot.conceptLocked ||
    texts.locked ||
    conversations.locked ||
    plans.locked ||
    assets?.locked === true ||
    mediaInputs?.locked === true ||
    mediaGenerations?.locked === true;
  const locked = otherLocked || association?.locked === true;
  const archived = details?.project.state === "archived";
  useEffect(() => {
    association?.setContext({
      ready: associationReady,
      threadId: associationThreadId,
      details,
    });
  }, [association, associationReady, associationThreadId, details]);
  useEffect(() => {
    texts.setProject(details);
    conversations.setProject(details);
    plans.setProject(details);
    assets?.setProject(details);
    mediaInputs?.setProject(details);
    mediaGenerations?.setProject(details);
  }, [
    texts,
    conversations,
    plans,
    assets,
    mediaInputs,
    mediaGenerations,
    details,
  ]);
  useEffect(() => {
    setPage("overview");
  }, [details?.project.projectId]);
  useEffect(() => {
    if (textSnapshot.recovery.intent) setPage(textSnapshot.target.kind);
  }, [textSnapshot.recovery.intent?.intentId, textSnapshot.target.kind]);

  usePluginDialog(dialogRef, dialog !== null);
  useEffect(() => {
    if (snapshot.notice === "项目已保存") {
      if (submittedDraft.current && snapshot.details)
        setProjectDraft({
          projectId: snapshot.details.project.projectId,
          proposal: submittedDraft.current,
        });
      submittedDraft.current = null;
      setDialog(null);
      setTitle("");
      setBrief("");
      setHomeIdea("");
    }
  }, [snapshot.notice, snapshot.details]);

  return (
    <section className="drama-workbench" aria-label="AI 短剧工作台">
      <div className="drama-main" inert={dialog !== null}>
        {planningDraft && (
          <ProjectPlanningDraftReview
            proposal={planningDraft}
            disabled={locked || dialog !== null}
            onReview={() => {
              reviewedDraft.current = planningDraft;
              setTitle(planningDraft.input.title);
              setBrief(planningDraft.input.briefText);
              setDialog("new");
            }}
          />
        )}
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
            <span className="preview-tag">创作工作台</span>
          </div>
        </header>
        <div
          className={`drama-content ${details ? "drama-project-content" : ""}`}
        >
          {assets && assets.activated && (
            <ProjectAssetRecoveryActions
              assets={assets}
              projects={controller}
              onRestore={() =>
                setPage(
                  assets?.getSnapshot().draft?.kind === "scene" ||
                    assets?.getSnapshot().draft?.kind === "prop"
                    ? "art"
                    : "characters",
                )
              }
            />
          )}
          <ConceptRecoveryActions controller={controller} />
          {details && (
            <ProjectTextRecoveryActions
              controller={texts}
              snapshot={textSnapshot}
            />
          )}
          {!details &&
            controller.concepts.submissions.getSnapshot().request && (
              <ConceptGenerationActions
                controller={controller.concepts.submissions}
              />
            )}
          {!details && controller.concepts.queries.getSnapshot().request && (
            <ConceptQueryActions controller={controller.concepts.queries} />
          )}
          {!details &&
            controller.concepts.historicalQueries.getSnapshot().request && (
              <ConceptQueryActions
                controller={controller.concepts.historicalQueries}
              />
            )}
          {!details && controller.concepts.images.getSnapshot().request && (
            <ConceptImageSelectionActions
              controller={controller.concepts.images}
            />
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
            <ShortDramaProjectHome
              snapshot={snapshot}
              locked={locked || dialog !== null}
              idea={homeIdea}
              search={search}
              onIdeaChange={setHomeIdea}
              onSearchChange={setSearch}
              feedback={
                <SaveFeedback controller={controller} snapshot={snapshot} />
              }
              onLoadProjects={(state, more) =>
                void controller.loadProjects(state, more)
              }
              onOpenProject={(projectId) =>
                void controller.openProject(projectId)
              }
              onReviewIdea={(value) => {
                reviewedDraft.current = null;
                setTitle(
                  Array.from(value.trim().split(/\r?\n/u)[0] ?? "")
                    .slice(0, 60)
                    .join(""),
                );
                setBrief(value);
                setDialog("new");
              }}
            />
          ) : (
            <div
              className="drama-project-layout"
              data-navigation-expanded={navigationExpanded}
            >
              <ShortDramaProjectNavigation
                page={page}
                assetsAvailable={Boolean(assets)}
                referencesAvailable={Boolean(mediaInputs)}
                locked={locked}
                expanded={navigationExpanded}
                onExpandedChange={setNavigationExpanded}
                onSelect={(next) => {
                  if (next === "characters" || next === "art")
                    assets?.activate();
                  if (next === "references") mediaInputs?.activate();
                  setPage(next);
                }}
              />
              <div className="drama-project-editor">
                <div className="page-heading">
                  <div>
                    <h1>{details.project.title}</h1>
                    <p>
                      {
                        projectPages.find((item) => item.id === page)
                          ?.description
                      }
                    </p>
                  </div>
                  <div className="heading-actions">
                    <span className="genre-label">创作项目</span>
                    {(page === "outline" || page === "script") && (
                      <button
                        className="button secondary"
                        disabled={locked}
                        onClick={() => setPage("overview")}
                      >
                        项目对话
                      </button>
                    )}
                    <button
                      className="button secondary"
                      disabled={locked || snapshot.opening}
                      onClick={() => void controller.setProjectState()}
                    >
                      {archived ? "恢复项目" : "归档项目"}
                    </button>
                  </div>
                </div>
                {page === "overview" && (
                  <>
                    <ProjectConversationActions controller={conversations} />
                    {association && (
                      <ProjectConversationAssociationActions
                        controller={association}
                        blocked={otherLocked}
                        onAttached={() => {
                          void conversations.refresh();
                        }}
                      />
                    )}
                  </>
                )}
                {page === "overview" && (
                  <ProjectTextPlanActions
                    initialDraft={
                      projectDraft?.projectId === details.project.projectId
                        ? projectDraft.proposal
                        : null
                    }
                    controller={plans}
                    conversations={conversations}
                    texts={texts}
                    details={details}
                    openText={(step) => {
                      setPage(step.kind === "script" ? "script" : "outline");
                      void texts.open(
                        step.kind === "script" && step.episodeId !== null
                          ? {
                              kind: "script",
                              episodeId: step.episodeId,
                              title: "分集剧本",
                            }
                          : { kind: "outline" },
                      );
                    }}
                  />
                )}
                <SaveFeedback controller={controller} snapshot={snapshot} />
                {archived && (
                  <p className="detail-note" role="status">
                    项目已归档。需求历史仍可查看，恢复项目后继续编辑。
                  </p>
                )}
                {page === "references" && mediaInputs ? (
                  <ProjectMediaInputWorkbench
                    controller={mediaInputs}
                    generations={mediaGenerations}
                    blocked={
                      projectLocked ||
                      snapshot.conceptLocked ||
                      texts.locked ||
                      conversations.locked ||
                      plans.locked ||
                      assets?.locked === true ||
                      association?.locked === true
                    }
                  />
                ) : (page === "characters" || page === "art") && assets ? (
                  <ProjectAssetWorkbench
                    controller={assets}
                    page={page === "art" ? "art" : "characters"}
                    onPageChange={setPage}
                    images={controller.concepts.images}
                    concepts={controller.concepts}
                    details={details}
                    onOpenConcept={() => setPage("overview")}
                    blocked={
                      projectLocked ||
                      snapshot.conceptLocked ||
                      texts.locked ||
                      conversations.locked ||
                      plans.locked
                    }
                  />
                ) : page === "outline" || page === "script" ? (
                  <StoryScriptWorkbench
                    controller={texts}
                    page={page === "script" ? "script" : "outline"}
                    onPageChange={setPage}
                    details={details}
                    blocked={projectLocked || snapshot.conceptLocked}
                  />
                ) : (
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
                      <label
                        className="visually-hidden"
                        htmlFor="creative-brief"
                      >
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
                )}
              </div>
            </div>
          )}
          {assets && !assets.activated && (
            <ProjectAssetRecoveryActions
              assets={assets}
              projects={controller}
              onRestore={() =>
                setPage(
                  assets?.getSnapshot().draft?.kind === "scene" ||
                    assets?.getSnapshot().draft?.kind === "prop"
                    ? "art"
                    : "characters",
                )
              }
            />
          )}
        </div>
      </div>
      <div className="drama-dialog-layer" hidden={dialog === null}>
        <dialog
          ref={dialogRef}
          className="modal"
          aria-labelledby="drama-persistent-modal-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!locked) setDialog(null);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget && !locked)
              setDialog(null);
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
                submittedDraft.current = reviewedDraft.current;
                void controller.createProject(title, brief);
              }}
            >
              <p className="subtle">先留住故事，再慢慢找到它的画面。</p>
              <label className="form-field">
                项目名称
                <input
                  data-dialog-autofocus
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
      </div>
    </section>
  );
}
