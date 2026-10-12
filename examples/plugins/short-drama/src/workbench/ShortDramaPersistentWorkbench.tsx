import type { ProjectMediaOutputController } from "./ProjectMediaOutputController";
import { ProjectMediaOutputWorkbench } from "./ProjectMediaOutputWorkbench";
import type { ProjectMediaResultController } from "./ProjectMediaResultController";
import { ProjectMediaResultWorkbench } from "./ProjectMediaResultWorkbench";
import type { ProjectMediaGenerationController } from "./ProjectMediaGenerationController";
import { LegacyProjectDialog } from "./LegacyProjectDialog";
import { ProjectFoundationController } from "./ProjectFoundationController";
import { ProjectFoundationWorkbench } from "./ProjectFoundationWorkbench";
import {
  ProjectFoundationCreateDialog,
  emptyCreationDraft,
} from "./ProjectFoundationCreateDialog";
import type { ProjectSourceUploadUiPort } from "./ProjectSourceUploadUiPort";
import { ShortDramaProjectHome } from "./ShortDramaProjectHome";
import {
  ShortDramaProjectNavigation,
  projectPagesFor,
  type ShortDramaProjectPage,
} from "./ShortDramaProjectNavigation";
import { ProjectMediaInputController } from "./ProjectMediaInputController";
import { ProjectMediaInputWorkbench } from "./ProjectMediaInputWorkbench";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Clock3, FolderOpen, Layers3 } from "lucide-react";
import {
  CreativeProjectController,
  briefBytes,
  validBrief,
  type ProjectSnapshot,
} from "./creative-project-controller";
import { ConceptWorkbench } from "./ConceptWorkbench";
import { ProjectHomeRecovery } from "./ProjectHomeRecovery";
import { ConceptRecoveryActions } from "./ConceptRecoveryActions";
import { ProjectTextController } from "./ProjectTextController";
import { StoryScriptWorkbench } from "./StoryScriptWorkbench";
import { ProjectOutlineWorkbench } from "./ProjectOutlineWorkbench";
import type { ProjectOutlineController } from "./ProjectOutlineController";
import type { ProjectOutlineEditController } from "./ProjectOutlineEditController";
import { ProjectTextRecoveryActions } from "./ProjectTextRecoveryActions";
import { ProjectConversationController } from "./ProjectConversationController";
import { ProjectConversationActions } from "./ProjectConversationActions";
import { ProjectConversationAssociationActions } from "./ProjectConversationAssociationActions";
import type { ProjectConversationAssociationController } from "./ProjectConversationAssociationController";
import { ProjectTextPlanController } from "./ProjectTextPlanController";
import { ProjectPlanDisclosure } from "./ProjectPlanDisclosure";
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
  outlines,
  outlineEdits,
  conversations,
  plans,
  assets,
  mediaResults,
  mediaOutputs,
  mediaInputs,
  mediaGenerations,
  foundations,
  sourceUpload,
  planningDraft = null,
  association,
  associationReady = false,
  associationThreadId = null,
  hostSurface = "workbench",
  hostPageContext = null,
  onOpenHostPage,
}: {
  hostSurface?: "workbench" | "sidebar";
  hostPageContext?: Readonly<{
    projectId?: string;
    stage?: ShortDramaProjectPage;
  }> | null;
  onOpenHostPage?(
    input: Readonly<{
      key: string;
      title: string;
      context: { projectId?: string; stage?: ShortDramaProjectPage };
    }>,
  ): void;
  controller: CreativeProjectController;
  texts: ProjectTextController;
  outlines?: ProjectOutlineController;
  outlineEdits?: ProjectOutlineEditController;
  conversations: ProjectConversationController;
  plans: ProjectTextPlanController;
  assets?: ProjectAssetController;
  mediaResults?: ProjectMediaResultController;
  mediaOutputs?: ProjectMediaOutputController;
  mediaInputs?: ProjectMediaInputController;
  mediaGenerations?: ProjectMediaGenerationController;
  foundations?: ProjectFoundationController;
  sourceUpload?: ProjectSourceUploadUiPort;
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
    outlineEdits?.subscribe ?? emptySubscribe,
    outlineEdits?.getSnapshot ?? noAssetSnapshot,
    outlineEdits?.getSnapshot ?? noAssetSnapshot,
  );
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
  useSyncExternalStore(
    mediaOutputs?.subscribe ?? emptySubscribe,
    mediaOutputs?.getSnapshot ?? noAssetSnapshot,
    mediaOutputs?.getSnapshot ?? noAssetSnapshot,
  );
  const foundationSnapshot = useSyncExternalStore(
    foundations?.subscribe ?? emptySubscribe,
    foundations?.getSnapshot ?? noAssetSnapshot,
    foundations?.getSnapshot ?? noAssetSnapshot,
  );
  const [newOrigin, setNewOrigin] = useState<"creative" | "novel" | null>(null);
  const [creativeDraft, setCreativeDraft] = useState(() =>
    emptyCreationDraft("creative"),
  );
  const [novelDraft, setNovelDraft] = useState(() =>
    emptyCreationDraft("novel"),
  );
  const generationReceipt = mediaGenerations?.getSnapshot().receipt ?? null;
  const [page, setPage] = useState<ShortDramaProjectPage>("overview");
  const [search, setSearch] = useState("");
  const [homeIdea, setHomeIdea] = useState("");
  const [navigationExpanded, setNavigationExpanded] = useState(true);
  const [dialog, setDialog] = useState<"new" | "history" | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const submittedDraft = useRef<ProjectPlanningProposal | null>(null);
  const reviewedDraft = useRef<ProjectPlanningProposal | null>(null);
  const [projectDraft, setProjectDraft] = useState<Readonly<{
    projectId: string;
    proposal: ProjectPlanningProposal;
  }> | null>(null);
  const [showProject, setShowProject] = useState(false);
  const details = showProject ? snapshot.details : null;
  const origin =
    foundationSnapshot?.foundation?.projectId === details?.project.projectId
      ? (foundationSnapshot?.foundation?.origin ?? null)
      : null;
  const foundation = foundationSnapshot?.foundation;
  const downstreamBlocked =
    origin === "novel" && !foundation?.confirmedProposal;
  const foundationPending = Boolean(
    details &&
      foundationSnapshot?.available &&
      (foundationSnapshot.projectId !== details.project.projectId ||
        !foundationSnapshot.origins.has(details.project.projectId) ||
        (foundationSnapshot.origins.get(details.project.projectId) !== null &&
          !foundationSnapshot.foundation)),
  );
  const projectLocked =
    snapshot.saving ||
    snapshot.pendingKind !== null ||
    foundationPending ||
    foundations?.locked === true ||
    outlineEdits?.locked === true;
  const otherLocked =
    projectLocked ||
    snapshot.conceptLocked ||
    texts.locked ||
    conversations.locked ||
    plans.locked ||
    assets?.locked === true ||
    mediaInputs?.locked === true ||
    mediaGenerations?.locked === true ||
    mediaOutputs?.locked === true;
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
    foundations?.setProject(details);
    texts.setProject(details);
    conversations.setProject(details);
    plans.setProject(details);
    assets?.setProject(details);
    mediaResults?.setProject(details?.project.projectId ?? null);
    mediaInputs?.setProject(details);
    mediaGenerations?.setProject(details);
  }, [
    texts,
    conversations,
    plans,
    assets,
    mediaResults,
    mediaInputs,
    mediaGenerations,
    foundations,
    details,
  ]);
  useEffect(() => {
    mediaOutputs?.setSource(
      details?.project.projectId ?? null,
      generationReceipt,
    );
  }, [mediaOutputs, details?.project.projectId, generationReceipt]);
  useEffect(() => {
    if (foundationSnapshot?.available)
      void foundations?.readOrigins(snapshot.projects);
  }, [foundations, foundationSnapshot?.available, snapshot.projects]);
  useEffect(() => {
    if (origin === "creative" && page === "outline") setPage("script");
  }, [origin, page]);
  useEffect(() => {
    setPage("overview");
  }, [details?.project.projectId]);
  useEffect(() => {
    if (textSnapshot.recovery.intent) setPage(textSnapshot.target.kind);
  }, [textSnapshot.recovery.intent?.intentId, textSnapshot.target.kind]);

  useEffect(() => {
    if (snapshot.notice === "项目已保存") {
      setShowProject(true);
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

  useEffect(() => {
    const projectId = hostPageContext?.projectId;
    if (!projectId) return;
    setShowProject(true);
    if (
      snapshot.phase === "ready" &&
      snapshot.details?.project.projectId !== projectId &&
      !snapshot.opening
    )
      void controller.openProject(projectId);
  }, [controller, hostPageContext?.projectId, snapshot.phase]);
  useEffect(() => {
    if (
      hostPageContext?.stage &&
      details?.project.projectId === hostPageContext.projectId
    )
      setPage(hostPageContext.stage);
  }, [
    details?.project.projectId,
    hostPageContext?.stage,
    hostPageContext?.projectId,
  ]);
  if (hostSurface === "sidebar")
    return (
      <section
        className="drama-workbench drama-host-sidebar"
        aria-label="短剧项目导航"
      >
        <h2>AI 短剧</h2>
        <p className="detail-note">与 Agent 讨论，查看项目成果。</p>
        <button
          className="drama-sidebar-item"
          onClick={() =>
            onOpenHostPage?.({ key: "home", title: "我的项目", context: {} })
          }
        >
          <FolderOpen size={16} />
          我的项目
        </button>
        <div className="drama-sidebar-projects">
          {snapshot.projects.map((project) => (
            <div key={project.projectId}>
              <button
                className="drama-sidebar-item"
                onClick={() =>
                  onOpenHostPage?.({
                    key: `project:${project.projectId}`,
                    title: project.title,
                    context: {
                      projectId: project.projectId,
                      stage: "overview",
                    },
                  })
                }
              >
                <Layers3 size={16} />
                <span>{project.title}</span>
              </button>
              {hostPageContext?.projectId === project.projectId && (
                <nav aria-label="项目制作阶段">
                  {projectPagesFor(
                    foundationSnapshot?.origins.get(project.projectId) ?? null,
                  ).map((item) => (
                    <button
                      key={item.id}
                      className="drama-sidebar-item drama-sidebar-stage"
                      onClick={() =>
                        onOpenHostPage?.({
                          key: `${project.projectId}:${item.id}`,
                          title: item.title,
                          context: {
                            projectId: project.projectId,
                            stage: item.id,
                          },
                        })
                      }
                    >
                      {item.title}
                    </button>
                  ))}
                </nav>
              )}
            </div>
          ))}
        </div>
        {snapshot.phase === "waiting" && <p role="status">正在读取项目…</p>}
        {snapshot.phase === "unavailable" && (
          <button
            className="button secondary"
            onClick={() => void controller.loadProjects()}
          >
            重新读取项目
          </button>
        )}
      </section>
    );
  return (
    <section
      className="drama-workbench"
      data-host-layout={onOpenHostPage ? "integrated" : undefined}
      aria-label="AI 短剧工作台"
    >
      <div className="drama-main" inert={dialog !== null || newOrigin !== null}>
        <header className="drama-topbar" data-plugin-header-insets="inline">
          <nav className="breadcrumbs" aria-label="AI 短剧路径">
            <button
              disabled={locked}
              onClick={() => {
                setShowProject(false);
                controller.closeProject();
              }}
            >
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
        <div
          className={`drama-content ${details ? "drama-project-content" : ""}`}
        >
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
              creativeDraft={
                foundationSnapshot?.available ? creativeDraft : undefined
              }
              onCreativeDraftChange={
                foundationSnapshot?.available ? setCreativeDraft : undefined
              }
              onCreateNovel={
                foundations ? () => setNewOrigin("novel") : undefined
              }
              origins={foundationSnapshot?.origins}
              onIdeaChange={setHomeIdea}
              onSearchChange={setSearch}
              feedback={
                <SaveFeedback controller={controller} snapshot={snapshot} />
              }
              onLoadProjects={(state, more) =>
                void controller.loadProjects(state, more)
              }
              onOpenProject={(projectId) => {
                setShowProject(true);
                if (snapshot.details?.project.projectId !== projectId)
                  void controller.openProject(projectId);
              }}
              onReviewIdea={(value) => {
                if (foundationSnapshot?.available) {
                  setNewOrigin("creative");
                  return;
                }
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
            <div className="drama-project-focus">
              <div className="drama-project-heading">
                <h1>{details.project.title}</h1>
                <ProjectConversationActions controller={conversations} />
              </div>
              <div
                className="drama-project-layout"
                data-navigation-expanded={navigationExpanded}
              >
                <ShortDramaProjectNavigation
                  page={page}
                  origin={origin}
                  sourceAvailable={Boolean(foundation?.source)}
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
                  <div className="panel-heading">
                    <h2>
                      {
                        projectPagesFor(origin).find((item) => item.id === page)
                          ?.title
                      }
                    </h2>
                  </div>
                  <SaveFeedback controller={controller} snapshot={snapshot} />
                  {archived && (
                    <p className="detail-note" role="status">
                      项目已归档。需求历史仍可查看，恢复项目后继续编辑。
                    </p>
                  )}
                  {downstreamBlocked &&
                    page !== "overview" &&
                    page !== "source" && (
                      <p className="detail-note">
                        先在改编概览确认方案，再开展后续制作。已有成果仍可查看。
                      </p>
                    )}
                  {foundationPending ? (
                    <div className="detail-note" role="status">
                      {foundationSnapshot?.error ?? "正在读取项目创作资料…"}
                      {foundationSnapshot?.error && (
                        <button
                          className="button secondary"
                          type="button"
                          onClick={() => void foundations?.refresh()}
                        >
                          重新读取创作资料
                        </button>
                      )}
                    </div>
                  ) : foundations &&
                    origin &&
                    (page === "overview" || page === "source") ? (
                    <ProjectFoundationWorkbench
                      key={`${details.project.projectId}:${page}`}
                      controller={foundations}
                      details={details}
                      sourcePage={page === "source"}
                      onContinue={() =>
                        setPage(origin === "novel" ? "outline" : "script")
                      }
                    />
                  ) : page === "references" && mediaInputs ? (
                    <>
                      <ProjectMediaInputWorkbench
                        controller={mediaInputs}
                        generations={mediaGenerations}
                        blocked={
                          downstreamBlocked ||
                          mediaOutputs?.locked === true ||
                          projectLocked ||
                          snapshot.conceptLocked ||
                          texts.locked ||
                          conversations.locked ||
                          plans.locked ||
                          assets?.locked === true ||
                          association?.locked === true
                        }
                      />
                      {mediaOutputs && (
                        <ProjectMediaOutputWorkbench
                          controller={mediaOutputs}
                          results={mediaResults}
                          blocked={
                            downstreamBlocked ||
                            archived === true ||
                            projectLocked ||
                            snapshot.conceptLocked ||
                            texts.locked ||
                            conversations.locked ||
                            plans.locked ||
                            assets?.locked === true ||
                            association?.locked === true ||
                            mediaInputs.locked ||
                            mediaGenerations?.locked === true
                          }
                        />
                      )}
                      {mediaResults && (
                        <ProjectMediaResultWorkbench
                          controller={mediaResults}
                          assets={assets}
                          blocked={
                            downstreamBlocked || locked || archived === true
                          }
                          onAdopted={(projectId) => {
                            if (
                              controller.getSnapshot().details?.project
                                .projectId === projectId
                            )
                              void mediaInputs.refresh();
                          }}
                        />
                      )}
                    </>
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
                        downstreamBlocked ||
                        projectLocked ||
                        snapshot.conceptLocked ||
                        texts.locked ||
                        conversations.locked ||
                        plans.locked
                      }
                    />
                  ) : page === "outline" || page === "script" ? (
                    page === "outline" && origin === "novel" && outlines ? (
                      <ProjectOutlineWorkbench
                        controller={outlines}
                        projectId={details.project.projectId}
                        edits={outlineEdits}
                        details={details}
                        foundation={foundation}
                        sourceName={foundationSnapshot?.source?.fileName ?? ""}
                        blocked={downstreamBlocked || otherLocked || archived}
                        fallback={
                          <StoryScriptWorkbench
                            controller={texts}
                            page="outline"
                            onPageChange={setPage}
                            details={details}
                            blocked={
                              downstreamBlocked ||
                              projectLocked ||
                              snapshot.conceptLocked
                            }
                          />
                        }
                      />
                    ) : (
                      <StoryScriptWorkbench
                        controller={texts}
                        page={page === "script" ? "script" : "outline"}
                        onPageChange={setPage}
                        details={details}
                        blocked={
                          downstreamBlocked ||
                          projectLocked ||
                          snapshot.conceptLocked
                        }
                      />
                    )
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
                        <p className="drama-readable-text">
                          {details.brief.text}
                        </p>
                        <details className="drama-secondary-disclosure">
                          <summary>修改创作需求</summary>
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
                        </details>
                      </section>
                      <ConceptWorkbench
                        controller={controller.concepts}
                        details={details}
                        blocked={projectLocked || snapshot.opening}
                      />
                    </div>
                  )}
                  {page === "overview" && (
                    <details className="drama-secondary-disclosure">
                      <summary>关联已有对话</summary>
                      {association && (
                        <ProjectConversationAssociationActions
                          controller={association}
                          blocked={otherLocked}
                          onAttached={() => {
                            void conversations.refresh();
                          }}
                        />
                      )}
                    </details>
                  )}
                  {page === "overview" && origin === null && (
                    <ProjectPlanDisclosure
                      key={details.project.projectId}
                      controller={plans}
                      hasDraft={
                        projectDraft?.projectId === details.project.projectId
                      }
                    >
                      <ProjectTextPlanActions
                        initialDraft={
                          projectDraft &&
                          projectDraft.projectId === details.project.projectId
                            ? projectDraft.proposal
                            : null
                        }
                        controller={plans}
                        conversations={conversations}
                        texts={texts}
                        details={details}
                        openText={(step) => {
                          setPage(
                            step.kind === "script" ? "script" : "outline",
                          );
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
                    </ProjectPlanDisclosure>
                  )}
                </div>
              </div>
              <details className="drama-secondary-disclosure">
                <summary>项目管理与待处理记录</summary>
                <button
                  className="button secondary"
                  disabled={locked || snapshot.opening}
                  onClick={() => void controller.setProjectState()}
                >
                  {archived ? "恢复项目" : "归档项目"}
                </button>
                {details && assets && (
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
                {details && <ConceptRecoveryActions controller={controller} />}
                {details && (
                  <ProjectTextRecoveryActions
                    controller={texts}
                    snapshot={textSnapshot}
                  />
                )}
              </details>
            </div>
          )}
          {!details && (
            <ProjectHomeRecovery
              controller={controller}
              assets={assets}
              onShowProject={() => setShowProject(true)}
              onRestoreAsset={() => {
                setShowProject(true);
                setPage(
                  assets?.getSnapshot().draft?.kind === "scene" ||
                    assets?.getSnapshot().draft?.kind === "prop"
                    ? "art"
                    : "characters",
                );
              }}
            />
          )}
        </div>
      </div>
      {newOrigin && foundations && (
        <ProjectFoundationCreateDialog
          key={newOrigin}
          controller={foundations}
          origin={newOrigin}
          idea={newOrigin === "creative" ? homeIdea : ""}
          upload={sourceUpload}
          initialDraft={newOrigin === "creative" ? creativeDraft : novelDraft}
          onDraftChange={
            newOrigin === "creative" ? setCreativeDraft : setNovelDraft
          }
          onClose={() => setNewOrigin(null)}
          onCreated={() => {
            setNewOrigin(null);
            setShowProject(true);
            setPage("overview");
            setHomeIdea("");
            if (newOrigin === "creative")
              setCreativeDraft(emptyCreationDraft("creative"));
            else setNovelDraft(emptyCreationDraft("novel"));
          }}
        />
      )}

      <LegacyProjectDialog
        dialog={dialog}
        locked={locked}
        title={title}
        brief={brief}
        snapshot={snapshot}
        controller={controller}
        details={details}
        feedback={<SaveFeedback controller={controller} snapshot={snapshot} />}
        onClose={() => setDialog(null)}
        onTitleChange={setTitle}
        onBriefChange={setBrief}
        onCreate={() => {
          submittedDraft.current = reviewedDraft.current;
          void controller.createProject(title, brief);
        }}
      />
    </section>
  );
}
