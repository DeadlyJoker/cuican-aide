import { ProjectAssetRecoveryActions } from "./ProjectAssetRecoveryActions";
import { ProjectTextRecoveryActions } from "./ProjectTextRecoveryActions";
import { ConceptRecoveryActions } from "./ConceptRecoveryActions";
import { ProjectOperations } from "./ProjectOperations";
import { ProjectRecoveryRecords } from "./ProjectRecoveryRecords";
import type { OtherProjectRecovery } from "./ProjectRecoveryProjection";
import { ProjectDirectoryStatus } from "./ProjectDirectoryStatus";
import type { ProjectMediaOutputController } from "./ProjectMediaOutputController";
import { ProjectMediaOutputWorkbench } from "./ProjectMediaOutputWorkbench";
import type { ProjectMediaResultController } from "./ProjectMediaResultController";
import { ProjectMediaResultWorkbench } from "./ProjectMediaResultWorkbench";
import type { ProjectMediaGenerationController } from "./ProjectMediaGenerationController";
import { LegacyProjectDialog } from "./LegacyProjectDialog";
import { ProjectFoundationController } from "./ProjectFoundationController";
import { ProjectFoundationWorkbench } from "./ProjectFoundationWorkbench";
import { ProjectBriefRevisionEditor } from "./ProjectBriefRevisionEditor";
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
import {
  ChevronRight,
  Clock3,
  Film,
  FolderOpen,
  Layers3,
  MessageSquareText,
  Plus,
  Search,
} from "lucide-react";
import {
  CreativeProjectController,
  type ProjectSnapshot,
} from "./creative-project-controller";
import { ConceptWorkbench } from "./ConceptWorkbench";
import { ProjectHomeRecovery } from "./ProjectHomeRecovery";
import { ProjectTextController } from "./ProjectTextController";
import { StoryScriptWorkbench } from "./StoryScriptWorkbench";
import { ProjectOutlineWorkbench } from "./ProjectOutlineWorkbench";
import type { ProjectOutlineController } from "./ProjectOutlineController";
import type { ProjectOutlineEditController } from "./ProjectOutlineEditController";
import { ProjectConversationController } from "./ProjectConversationController";
import { ProjectConversationActions } from "./ProjectConversationActions";
import type { ProjectConversationAssociationController } from "./ProjectConversationAssociationController";
import { ProjectTextPlanController } from "./ProjectTextPlanController";
import { ProjectPlanDisclosure } from "./ProjectPlanDisclosure";
import { ProjectTextPlanActions } from "./ProjectTextPlanActions";
import { ProjectPlanningDraftReview } from "./ProjectPlanningDraftReview";
import type { ProjectPlanningProposal } from "../project-planning-service";
import { ProjectAssetController } from "./ProjectAssetController";
import { ProjectAssetWorkbench } from "./ProjectAssetWorkbench";
import { useProjectAssetInvalidation } from "./useProjectAssetInvalidation";
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
  hostSurface = "workbench",
  hostPageContext = null,
  onOpenHostPage,
  otherProjectRecovery = [],
  foundationChangeRevision = 0,
  textChangeRevision = 0,
  assetChangeRevision = 0,
}: {
  otherProjectRecovery?: readonly OtherProjectRecovery[];
  foundationChangeRevision?: number;
  textChangeRevision?: number;
  assetChangeRevision?: number;
  hostSurface?: "workbench" | "sidebar";
  hostPageContext?: Readonly<{
    projectId?: string;
    stage?: ShortDramaProjectPage;
    createOrigin?: "creative" | "novel";
  }> | null;
  onOpenHostPage?(
    input: Readonly<{
      key: string;
      title: string;
      context: {
        projectId?: string;
        stage?: ShortDramaProjectPage;
        createOrigin?: "creative" | "novel";
      };
    }>,
  ): void | Promise<boolean>;
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
  const assetSnapshot = useSyncExternalStore(
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
  useEffect(() => {
    if (
      hostSurface === "workbench" &&
      hostPageContext?.createOrigin &&
      (!onOpenHostPage || hostPageContext.createOrigin === "novel")
    )
      setNewOrigin(hostPageContext.createOrigin);
  }, [hostSurface, hostPageContext?.createOrigin, onOpenHostPage]);
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
  const details =
    showProject &&
    (!hostPageContext?.projectId ||
      snapshot.details?.project.projectId === hostPageContext.projectId)
      ? snapshot.details
      : null;
  const origin =
    foundationSnapshot?.foundation?.projectId === details?.project.projectId
      ? (foundationSnapshot?.foundation?.origin ?? null)
      : null;
  useProjectAssetInvalidation(
    assets,
    assetSnapshot,
    details?.project.projectId ?? null,
    assetChangeRevision,
  );
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
  const ownsCentralChat = hostSurface === "sidebar";
  const navigationSequence = useRef(0);
  const navigationFlight = useRef<Promise<void>>(Promise.resolve());
  const pendingStage = useRef<ShortDramaProjectPage | null>(null);
  const currentProject = useRef(details?.project.projectId);
  currentProject.current = details?.project.projectId;
  const confirmedStage = useRef(hostPageContext?.stage);
  confirmedStage.current = hostPageContext?.stage;
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const selectProjectPage = (next: ShortDramaProjectPage) => {
    const previous = page;
    const projectId = details?.project.projectId;
    const sequence = ++navigationSequence.current;
    pendingStage.current = next;
    setNavigationError(null);
    setPage(next);
    if (next === "characters" || next === "art") assets?.activate();
    if (next === "references") mediaInputs?.activate();
    if (onOpenHostPage && details) {
      navigationFlight.current = navigationFlight.current.then(async () => {
        if (
          sequence !== navigationSequence.current ||
          currentProject.current !== projectId
        )
          return;
        let accepted: boolean | void;
        try {
          accepted = await onOpenHostPage({
            key: `project:${details.project.projectId}`,
            title: details.project.title,
            context: { projectId: details.project.projectId, stage: next },
          });
        } catch {
          accepted = false;
        }
        if (
          sequence !== navigationSequence.current ||
          currentProject.current !== projectId
        )
          return;
        pendingStage.current = null;
        if (accepted === false) {
          setPage(confirmedStage.current ?? previous);
          setNavigationError("阶段同步未完成，请重新选择。");
        }
      });
    } else pendingStage.current = null;
  };
  useEffect(() => {
    ++navigationSequence.current;
    pendingStage.current = null;
    setNavigationError(null);
    return () => {
      ++navigationSequence.current;
      pendingStage.current = null;
    };
  }, [details?.project.projectId]);
  useEffect(() => {
    association?.setContext({
      ready: associationReady,
      // Project chat is owned by the project. Do not inspect a global chat on
      // entry; retain only recovery of a previously unconfirmed association.
      threadId: null,
      details,
    });
  }, [association, associationReady, details]);
  useEffect(() => {
    conversations.setAutomaticOpen(ownsCentralChat);
    return () => conversations.setAutomaticOpen(false);
  }, [conversations, ownsCentralChat]);
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
    const projectId = hostPageContext?.projectId;
    if (
      foundationChangeRevision > 0 &&
      projectId &&
      details?.project.projectId === projectId
    )
      foundations?.invalidate(projectId);
  }, [
    foundations,
    foundationChangeRevision,
    hostPageContext?.projectId,
    details?.project.projectId,
  ]);
  useEffect(() => {
    const projectId = hostPageContext?.projectId;
    if (
      textChangeRevision > 0 &&
      projectId &&
      details?.project.projectId === projectId
    ) {
      if (hostPageContext?.stage === "outline") {
        texts.invalidate(projectId);
        outlines?.invalidate(projectId);
      } else if (hostPageContext?.stage === "script")
        texts.invalidate(projectId);
    }
  }, [
    texts,
    outlines,
    textChangeRevision,
    hostPageContext?.projectId,
    hostPageContext?.stage,
    details?.project.projectId,
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
    setPage("overview");
  }, [details?.project.projectId]);
  useEffect(() => {
    // Background recovery restores content, not the host's selected stage.
    // The recovery action below explicitly navigates to its result on request.
    if (!onOpenHostPage && textSnapshot.recovery.intent)
      setPage(textSnapshot.target.kind);
  }, [
    onOpenHostPage,
    textSnapshot.recovery.intent?.intentId,
    textSnapshot.target.kind,
  ]);

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
  }, [
    controller,
    hostPageContext?.projectId,
    snapshot.phase,
    snapshot.conceptLocked,
  ]);
  useEffect(() => {
    if (
      hostPageContext?.stage &&
      details?.project.projectId === hostPageContext.projectId
    ) {
      if (
        pendingStage.current &&
        pendingStage.current !== hostPageContext.stage
      )
        return;
      setPage(hostPageContext.stage);
      if (hostSurface === "workbench") {
        if (
          hostPageContext.stage === "characters" ||
          hostPageContext.stage === "art"
        )
          assets?.activate();
        if (hostPageContext.stage === "references") mediaInputs?.activate();
      }
    }
  }, [
    assets,
    mediaInputs,
    hostSurface,
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
        <div className="drama-sidebar-brand">
          <span className="drama-sidebar-brand-icon" aria-hidden="true">
            <Film size={17} />
          </span>
          <span className="drama-sidebar-brand-copy">
            <strong>AI 短剧</strong>
            <small>项目与创作会话</small>
          </span>
          <button
            type="button"
            className="drama-sidebar-icon-button"
            aria-label="搜索短剧项目"
            title="搜索短剧项目"
            onClick={() =>
              onOpenHostPage?.({ key: "home", title: "我的项目", context: {} })
            }
          >
            <Search size={16} />
          </button>
        </div>
        <div className="drama-sidebar-heading">
          <strong>项目</strong>
          <button
            type="button"
            aria-label="新建项目"
            title="新建项目"
            onClick={() =>
              onOpenHostPage?.({
                key: "new-project",
                title: "新建项目",
                context: {},
              })
            }
          >
            <Plus size={16} />
          </button>
        </div>
        <button
          className="drama-sidebar-item drama-sidebar-home"
          onClick={() =>
            onOpenHostPage?.({ key: "home", title: "我的项目", context: {} })
          }
        >
          <FolderOpen size={16} />
          <span>
            <strong>我的项目</strong>
            <small>查看全部进行中的创作</small>
          </span>
        </button>
        <div className="drama-sidebar-projects">
          <ProjectDirectoryStatus
            snapshot={snapshot}
            onRetry={() => void controller.loadProjects(snapshot.state)}
          />
          <div className="filter-tabs" aria-label="项目状态">
            <button
              type="button"
              aria-pressed={snapshot.state === "active"}
              onClick={() => void controller.loadProjects("active")}
            >
              进行中
            </button>
            <button
              type="button"
              aria-pressed={snapshot.state === "archived"}
              onClick={() => void controller.loadProjects("archived")}
            >
              已归档
            </button>
          </div>
          {snapshot.projects.map((project) => (
            <div className="drama-sidebar-project-row" key={project.projectId}>
              <button
                className={
                  "drama-sidebar-item drama-sidebar-project" +
                  (hostPageContext?.projectId === project.projectId
                    ? " active"
                    : "")
                }
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
              <small className="drama-sidebar-project-meta">
                需求 v{project.latestBriefRevision} ·{" "}
                {new Date(project.updatedAt).toLocaleDateString("zh-CN")}
              </small>
              {hostPageContext?.projectId === project.projectId && (
                <div className="drama-sidebar-project-details">
                  <div className="drama-sidebar-current-label">
                    <MessageSquareText size={13} />
                    <span>当前项目会话</span>
                  </div>
                  <ProjectConversationActions
                    controller={conversations}
                    presentation="automatic"
                  />
                  <div className="drama-sidebar-current-label drama-sidebar-stage-label">
                    <Clock3 size={13} />
                    <span>从右侧项目页继续分阶段制作</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    );
  return (
    <section
      className="drama-workbench"
      data-host-layout={onOpenHostPage ? "integrated" : undefined}
      aria-label="AI 短剧工作台"
    >
      <div className="drama-main" inert={dialog !== null || newOrigin !== null}>
        {!onOpenHostPage && (
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
        )}
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
          ) : !details &&
            hostPageContext?.projectId &&
            snapshot.details &&
            controller.concepts.localMutationPending ? (
            <section className="detail-panel" aria-label="原项目保存尚未确认">
              <p className="detail-note" role="status">
                原项目的保存结果尚未确认。确认后继续读取所选项目。
              </p>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  const project = snapshot.details!.project;
                  void onOpenHostPage?.({
                    key: `project:${project.projectId}`,
                    title: project.title,
                    context: {
                      projectId: project.projectId,
                      stage: "overview",
                    },
                  });
                }}
              >
                返回原项目查看保存结果
              </button>
            </section>
          ) : !details ? (
            <ShortDramaProjectHome
              integrated={Boolean(onOpenHostPage)}
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
              <div className="drama-stage-toolbar">
                {onOpenHostPage && (
                  <nav className="drama-stage-tabs" aria-label="项目制作阶段">
                    {projectPagesFor(origin).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-current={page === item.id ? "page" : undefined}
                        onClick={() => selectProjectPage(item.id)}
                      >
                        {item.title}
                      </button>
                    ))}
                  </nav>
                )}

                {onOpenHostPage && (
                  <ProjectOperations
                    archived={Boolean(archived)}
                    disabled={locked || snapshot.opening}
                    onArchive={() => void controller.setProjectState()}
                  >
                    <ProjectRecoveryRecords
                      projects={controller}
                      assets={assets}
                      texts={texts}
                      textSnapshot={textSnapshot}
                      otherProjects={otherProjectRecovery}
                      onOpenProject={(projectId) => {
                        const project = snapshot.projects.find(
                          (project) => project.projectId === projectId,
                        );
                        void onOpenHostPage({
                          key: `project:${projectId}`,
                          title: project?.title ?? "待处理项目",
                          context: { projectId, stage: "overview" },
                        });
                      }}
                      onRestoreAsset={() =>
                        selectProjectPage(
                          assets?.getSnapshot().draft?.kind === "scene" ||
                            assets?.getSnapshot().draft?.kind === "prop"
                            ? "art"
                            : "characters",
                        )
                      }
                      onRestoreText={() =>
                        selectProjectPage(texts.getSnapshot().target.kind)
                      }
                    />
                  </ProjectOperations>
                )}
              </div>
              {navigationError && (
                <p className="detail-note drama-navigation-error" role="alert">
                  {navigationError}
                </p>
              )}
              {!onOpenHostPage && (
                <div className="drama-project-heading">
                  <h1>{details.project.title}</h1>
                  <ProjectConversationActions controller={conversations} />
                </div>
              )}
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
                  onSelect={selectProjectPage}
                />
                <div className="drama-project-editor">
                  {page !== "characters" && page !== "art" && (
                    <div className="panel-heading">
                      <h2>
                        {
                          projectPagesFor(origin).find(
                            (item) => item.id === page,
                          )?.title
                        }
                      </h2>
                    </div>
                  )}
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
                      briefEditor={
                        <>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              setDialog("history");
                              void controller.loadBriefs();
                            }}
                          >
                            v{details.brief.briefRevision} · 查看历史
                          </button>
                          <ProjectBriefRevisionEditor
                            controller={controller}
                            snapshot={snapshot}
                            details={details}
                            blocked={locked}
                          />
                        </>
                      }
                      onContinue={() =>
                        selectProjectPage(
                          origin === "novel" ? "outline" : "script",
                        )
                      }
                    />
                  ) : page === "concepts" ? (
                    <ConceptWorkbench
                      controller={controller.concepts}
                      details={details}
                      blocked={
                        downstreamBlocked || projectLocked || snapshot.opening
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
                      onPageChange={selectProjectPage}
                      images={controller.concepts.images}
                      concepts={controller.concepts}
                      details={details}
                      onOpenConcept={() =>
                        selectProjectPage(origin ? "concepts" : "overview")
                      }
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
                            onPageChange={selectProjectPage}
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
                        onPageChange={selectProjectPage}
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
                        <ProjectBriefRevisionEditor
                          controller={controller}
                          snapshot={snapshot}
                          details={details}
                          blocked={locked}
                        />
                      </section>
                      <ConceptWorkbench
                        controller={controller.concepts}
                        details={details}
                        blocked={projectLocked || snapshot.opening}
                      />
                    </div>
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
                          selectProjectPage(
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
              {!onOpenHostPage && (
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
                        selectProjectPage(
                          assets?.getSnapshot().draft?.kind === "scene" ||
                            assets?.getSnapshot().draft?.kind === "prop"
                            ? "art"
                            : "characters",
                        )
                      }
                    />
                  )}
                  {details && (
                    <ConceptRecoveryActions controller={controller} />
                  )}
                  {details && (
                    <ProjectTextRecoveryActions
                      controller={texts}
                      snapshot={textSnapshot}
                    />
                  )}
                </details>
              )}
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
            const project = controller.getSnapshot().details?.project;
            if (project)
              onOpenHostPage?.({
                key: `project:${project.projectId}`,
                title: project.title,
                context: { projectId: project.projectId, stage: "overview" },
              });
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
