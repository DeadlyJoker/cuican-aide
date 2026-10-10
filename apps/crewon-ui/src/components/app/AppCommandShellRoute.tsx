import { recordedTaskChanges } from "../../lib/task-detail/recordedTaskChanges";
import { PanelRight, SlidersHorizontal } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { AppConfirmDialog } from "./AppConfirmDialog";
import { CommandWorkspace } from "./CommandWorkspace";
import { CommandPanelHeading } from "./CommandPanelHeading";
import {
  CommandWorkspaceCapabilityDrawer,
  DEFAULT_COMMAND_WORKBENCH_ID,
  type CommandWorkspaceCapabilityDrawerProps,
} from "./CommandWorkspaceCapabilityDrawer";
import {
  DEFAULT_TASK_DETAIL_POPOVER_ID,
  TaskDetailPopover,
} from "../task-detail/TaskDetailPopover";
import {
  taskDetailPresentation,
  taskDetailProcessesPresentation,
} from "../../lib/task-detail/taskDetailPresentation";
import { projectTaskDetail } from "../../lib/task-detail/taskDetailProjection";
import {
  useTaskDetailProcesses,
  type TaskDetailProcessClient,
} from "../../lib/task-detail/useTaskDetailProcesses";
import {
  useTaskDetailWorkspaceGit,
  type TaskDetailWorkspaceGitClient,
} from "../../lib/task-detail/useTaskDetailWorkspaceGit";
import "./AppCommandShellRoute.css";

type AppCommandShellRouteProps = ComponentProps<typeof CommandWorkspace> & {
  capabilityDrawer: CommandWorkspaceCapabilityDrawerProps;
  confirmDialog: ComponentProps<typeof AppConfirmDialog>;
  taskDetailClient?: TaskDetailProcessClient | null;
  taskDetailWorkspaceGitClient?: TaskDetailWorkspaceGitClient | null;
};

type CommandShellOverlay = "task-detail" | "workbench" | null;

export function resolveCommandShellEscapeTarget({
  activeOverlay,
  taskDetailOpen,
  workbenchOpen,
}: {
  activeOverlay: CommandShellOverlay;
  taskDetailOpen: boolean;
  workbenchOpen: boolean;
}): CommandShellOverlay {
  if (activeOverlay === "task-detail" && taskDetailOpen) return "task-detail";
  if (activeOverlay === "workbench" && workbenchOpen) return "workbench";
  if (taskDetailOpen && !workbenchOpen) return "task-detail";
  if (workbenchOpen && !taskDetailOpen) return "workbench";
  return null;
}

export function alternateCommandShellOverlay(
  activeOverlay: CommandShellOverlay,
): Exclude<CommandShellOverlay, null> {
  return activeOverlay === "workbench" ? "task-detail" : "workbench";
}

export function shouldHandleCommandShellEscape({
  defaultPrevented,
  isComposing,
  key,
  keyCode,
  modalOpen,
}: {
  defaultPrevented: boolean;
  isComposing: boolean;
  key: string;
  keyCode: number;
  modalOpen: boolean;
}): boolean {
  return (
    key === "Escape" &&
    !defaultPrevented &&
    !isComposing &&
    keyCode !== 229 &&
    !modalOpen
  );
}

export function AppCommandShellRoute({
  capabilityDrawer,
  confirmDialog,
  taskDetailClient = null,
  taskDetailWorkspaceGitClient = null,
  ...commandWorkspaceProps
}: AppCommandShellRouteProps) {
  const [recordedReview, setRecordedReview] = useState<{
    sequence: number;
    threadId: string;
  } | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<CommandShellOverlay>(
    capabilityDrawer.open ? "workbench" : null,
  );
  const [narrowOverlayMode, setNarrowOverlayMode] = useState(false);
  const [stoppingTurnKeys, setStoppingTurnKeys] = useState<string[]>([]);
  const capabilityOpenRef = useRef(capabilityDrawer.open);
  const taskDetailLastFocusRef = useRef<HTMLElement | null>(null);
  const workbenchLastFocusRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousCapabilityOpenRef = useRef(capabilityDrawer.open);
  const stoppingTurnKeysRef = useRef(new Set<string>());
  const taskDetailAvailabilityCallbackRef = useRef(
    commandWorkspaceProps.onTaskDetailAvailabilityChange,
  );
  capabilityOpenRef.current = capabilityDrawer.open;
  taskDetailAvailabilityCallbackRef.current =
    commandWorkspaceProps.onTaskDetailAvailabilityChange;
  const selectedThread = commandWorkspaceProps.selectedThread ?? null;
  const [panelHeaderTarget, setPanelHeaderTarget] =
    useState<HTMLElement | null>(null);
  const linkedThreads = commandWorkspaceProps.linkedThreads ?? [];
  const locale = commandWorkspaceProps.locale ?? "zh";
  const authority = commandWorkspaceProps.workspaceAuthority ?? "legacy";
  const processAuthorityAvailable =
    authority === "legacy" &&
    commandWorkspaceProps.connectionState === "connected" &&
    taskDetailClient !== null;
  const workspaceGitAuthorityAvailable =
    authority === "control" &&
    commandWorkspaceProps.connectionState === "connected" &&
    commandWorkspaceProps.controlWorkspaceNav?.busy !== true &&
    taskDetailWorkspaceGitClient !== null;
  const latestTurn = selectedThread?.turns.at(-1) ?? null;
  const latestTurnItem = latestTurn?.items.at(-1) ?? null;
  const latestTurnItemStatus =
    latestTurnItem !== null && "status" in latestTurnItem
      ? JSON.stringify(latestTurnItem.status)
      : "";
  const workspaceGitScopeKey = [
    commandWorkspaceProps.controlWorkspaceNav?.name ?? "",
    commandWorkspaceProps.controlWorkspaceNav?.revisionKey ?? "unversioned",
  ].join(":");
  const workspaceGitRefreshKey = [
    latestTurn
      ? `${latestTurn.id}:${latestTurn.status}:${latestTurn.items.length}:${latestTurnItem?.type ?? "none"}:${latestTurnItem?.id ?? "none"}:${latestTurnItemStatus}`
      : selectedThread?.status.type,
  ].join(":");
  const workspaceGit = useTaskDetailWorkspaceGit({
    client: taskDetailWorkspaceGitClient,
    enabled: workspaceGitAuthorityAvailable,
    open: taskDetailOpen,
    refreshKey: workspaceGitRefreshKey,
    workspaceScopeKey: workspaceGitScopeKey,
  });

  const projection = useMemo(
    () =>
      selectedThread
        ? projectTaskDetail({
            linkedThreads,
            locale,
            sourceLimit: 3,
            thread: selectedThread,
          })
        : null,
    [linkedThreads, locale, selectedThread],
  );
  const changeDetails = useMemo(
    () =>
      selectedThread &&
      projection?.changes.complete &&
      projection.changes.fileCount > 0
        ? recordedTaskChanges(selectedThread, projection.changes)
        : null,
    [selectedThread, projection],
  );
  const presentation = useMemo(
    () =>
      projection
        ? taskDetailPresentation({
            authority,
            connectionState: commandWorkspaceProps.connectionState,
            locale,
            projection,
            workspaceGit: authority === "control" ? workspaceGit : null,
          })
        : null,
    [
      authority,
      commandWorkspaceProps.connectionState,
      locale,
      projection,
      workspaceGit,
    ],
  );
  const processRuntime = useTaskDetailProcesses({
    client: taskDetailClient,
    enabled: processAuthorityAvailable,
    open: taskDetailOpen,
    threadId: selectedThread?.id ?? null,
  });
  const processPresentation = useMemo(
    () =>
      taskDetailProcessesPresentation(
        processRuntime.state,
        locale,
        processAuthorityAvailable,
      ),
    [locale, processAuthorityAvailable, processRuntime.state],
  );

  const focusOverlay = useCallback(
    (overlay: Exclude<CommandShellOverlay, null>) => {
      const saved =
        overlay === "task-detail"
          ? taskDetailLastFocusRef.current
          : workbenchLastFocusRef.current;
      const root = document.getElementById(
        overlay === "task-detail"
          ? DEFAULT_TASK_DETAIL_POPOVER_ID
          : DEFAULT_COMMAND_WORKBENCH_ID,
      );
      const savedIsAvailable =
        saved?.isConnected === true &&
        !saved.closest('[hidden], [inert], [aria-hidden="true"]');
      const preferred = root?.querySelector<HTMLElement>(
        overlay === "task-detail"
          ? ".task-detail-popover__close:not(:disabled)"
          : ".command-workbench-close:not(:disabled)",
      );
      const fallback = root?.querySelector<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex="0"]',
      );
      (savedIsAvailable ? saved : (preferred ?? fallback))?.focus({
        preventScroll: true,
      });
    },
    [],
  );

  const closeTaskDetail = useCallback(
    ({ restoreFocus = false }: { restoreFocus?: boolean }) => {
      setTaskDetailOpen(false);
      setActiveOverlay(capabilityOpenRef.current ? "workbench" : null);
      if (restoreFocus) {
        window.requestAnimationFrame(() => {
          if (capabilityOpenRef.current) {
            focusOverlay("workbench");
          } else {
            triggerRef.current?.focus();
          }
        });
      }
    },
    [focusOverlay],
  );
  const handleTaskDetailAvailabilityChange = useCallback(
    (available: boolean) => {
      taskDetailAvailabilityCallbackRef.current?.(available);
      if (!available) {
        setTaskDetailOpen(false);
        setActiveOverlay(capabilityOpenRef.current ? "workbench" : null);
      }
    },
    [],
  );
  const openCapability = useCallback(() => {
    setActiveOverlay("workbench");
    capabilityDrawer.onOpen();
    window.requestAnimationFrame(() => focusOverlay("workbench"));
  }, [capabilityDrawer.onOpen, focusOverlay]);
  const closeCapability = useCallback(() => {
    setActiveOverlay(taskDetailOpen ? "task-detail" : null);
    capabilityDrawer.onClose();
  }, [capabilityDrawer.onClose, taskDetailOpen]);
  const closeCapabilityAndRestoreFocus = useCallback(() => {
    closeCapability();
    window.requestAnimationFrame(() => {
      if (taskDetailOpen) {
        focusOverlay("task-detail");
      } else {
        document
          .querySelector<HTMLButtonElement>(".command-workbench-trigger")
          ?.focus();
      }
    });
  }, [closeCapability, focusOverlay, taskDetailOpen]);
  const openReview = useCallback(() => {
    if (capabilityDrawer.disabled) return;
    openCapability();
    capabilityDrawer.onReview();
  }, [capabilityDrawer.disabled, capabilityDrawer.onReview, openCapability]);
  const openTerminal = useCallback(() => {
    if (capabilityDrawer.disabled) return;
    openCapability();
    capabilityDrawer.onTerminal();
  }, [capabilityDrawer.disabled, capabilityDrawer.onTerminal, openCapability]);
  const toggleTaskDetail = useCallback(() => {
    const nextOpen = !taskDetailOpen;
    setTaskDetailOpen(nextOpen);
    setActiveOverlay(
      nextOpen ? "task-detail" : capabilityDrawer.open ? "workbench" : null,
    );
  }, [capabilityDrawer.open, taskDetailOpen]);
  const activateOverlayFromTarget = useCallback(
    (target: EventTarget | null) => {
      if (!(target instanceof Element)) return;
      if (target.closest(".task-detail-popover")) {
        if (target instanceof HTMLElement) {
          taskDetailLastFocusRef.current = target;
        }
        setActiveOverlay("task-detail");
      } else if (target.closest(".command-workbench")) {
        if (target instanceof HTMLElement) {
          workbenchLastFocusRef.current = target;
        }
        setActiveOverlay("workbench");
      }
    },
    [],
  );

  const activeTurnKey =
    selectedThread && commandWorkspaceProps.activeTurnId
      ? `${selectedThread.id}\0${commandWorkspaceProps.activeTurnId}`
      : null;
  const stopTaskPending =
    activeTurnKey !== null && stoppingTurnKeys.includes(activeTurnKey);
  const stopCurrentTask = useCallback(() => {
    if (
      !activeTurnKey ||
      !commandWorkspaceProps.onStop ||
      stoppingTurnKeysRef.current.has(activeTurnKey)
    ) {
      return;
    }
    stoppingTurnKeysRef.current.add(activeTurnKey);
    setStoppingTurnKeys((current) => [...new Set([...current, activeTurnKey])]);
    void (async () => {
      try {
        await commandWorkspaceProps.onStop?.();
      } catch {
        // The command runtime owns the user-facing failure notice. This guard
        // only guarantees that the local pending state can recover.
      } finally {
        stoppingTurnKeysRef.current.delete(activeTurnKey);
        setStoppingTurnKeys((current) =>
          current.filter((key) => key !== activeTurnKey),
        );
      }
    })();
  }, [activeTurnKey, commandWorkspaceProps.onStop]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 880px)");
    const sync = () => setNarrowOverlayMode(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!selectedThread) {
      setTaskDetailOpen(false);
      setActiveOverlay(capabilityDrawer.open ? "workbench" : null);
    }
  }, [capabilityDrawer.open, selectedThread]);

  useEffect(() => {
    if (previousCapabilityOpenRef.current === capabilityDrawer.open) return;
    previousCapabilityOpenRef.current = capabilityDrawer.open;
    setActiveOverlay(
      capabilityDrawer.open
        ? "workbench"
        : taskDetailOpen
          ? "task-detail"
          : null,
    );
  }, [capabilityDrawer.open, taskDetailOpen]);

  const handleEscape = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        !shouldHandleCommandShellEscape({
          defaultPrevented: event.defaultPrevented,
          isComposing: event.nativeEvent.isComposing,
          key: event.key,
          keyCode: event.nativeEvent.keyCode,
          modalOpen: document.querySelector('[aria-modal="true"]') !== null,
        })
      ) {
        return;
      }
      const target = resolveCommandShellEscapeTarget({
        activeOverlay,
        taskDetailOpen,
        workbenchOpen: capabilityDrawer.open,
      });
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      if (target === "task-detail") {
        closeTaskDetail({ restoreFocus: true });
      } else {
        closeCapabilityAndRestoreFocus();
      }
    },
    [
      activeOverlay,
      capabilityDrawer.open,
      closeCapabilityAndRestoreFocus,
      closeTaskDetail,
      taskDetailOpen,
    ],
  );

  const taskDetailInactive =
    narrowOverlayMode &&
    taskDetailOpen &&
    capabilityDrawer.open &&
    activeOverlay === "workbench";
  const workbenchInactive =
    narrowOverlayMode &&
    taskDetailOpen &&
    capabilityDrawer.open &&
    activeOverlay === "task-detail";
  const switchOverlay = useCallback(() => {
    const next = alternateCommandShellOverlay(activeOverlay);
    setActiveOverlay(next);
    window.requestAnimationFrame(() => focusOverlay(next));
  }, [activeOverlay, focusOverlay]);

  const taskDetailTrigger = selectedThread ? (
    <button
      ref={triggerRef}
      aria-controls={DEFAULT_TASK_DETAIL_POPOVER_ID}
      aria-expanded={taskDetailOpen}
      aria-haspopup="dialog"
      aria-label={locale === "zh" ? "任务详细信息" : "Task details"}
      className="command-task-detail-trigger"
      data-active={taskDetailOpen ? "true" : "false"}
      type="button"
      onClick={toggleTaskDetail}
    >
      <SlidersHorizontal aria-hidden="true" />
    </button>
  ) : null;

  return (
    <div
      className="command-shell-route"
      data-active-overlay={activeOverlay ?? "none"}
      data-capability-sidebar-open={capabilityDrawer.open ? "true" : "false"}
      data-task-detail-open={taskDetailOpen ? "true" : "false"}
      onFocusCapture={(event) => activateOverlayFromTarget(event.target)}
      onKeyDown={handleEscape}
      onPointerDownCapture={(event) => activateOverlayFromTarget(event.target)}
    >
      <header
        ref={setPanelHeaderTarget}
        aria-label={locale === "zh" ? "面板标题栏" : "Panel title bar"}
        className="command-panel-header"
        data-desktop-drag-region=""
      >
        {!panelHeaderTarget ? (
          <CommandPanelHeading
            title={
              selectedThread?.name?.trim() ||
              selectedThread?.preview?.trim() ||
              (locale === "zh" ? "新建任务" : "New task")
            }
            actions={taskDetailTrigger}
          />
        ) : null}
      </header>
      <CommandWorkspace
        {...commandWorkspaceProps}
        panelHeaderTarget={panelHeaderTarget}
        panelHeaderActions={taskDetailTrigger}
        onTaskDetailAvailabilityChange={handleTaskDetailAvailabilityChange}
        taskChanges={
          projection?.changes.complete && projection.changes.fileCount > 0
            ? {
                additions: projection.changes.recordedAdditions,
                deletions: projection.changes.recordedDeletions,
                files: projection.changes.fileCount,
              }
            : null
        }
        taskChangeDetails={changeDetails}
        onOpenTaskChanges={() => {
          if (!selectedThread || !changeDetails) return;
          setRecordedReview((current) => ({
            sequence: (current?.sequence ?? 0) + 1,
            threadId: selectedThread.id,
          }));
          openCapability();
        }}
        taskDetailTrigger={null}
      />
      {presentation ? (
        <TaskDetailPopover
          escapeOwner="route"
          interactionInactive={taskDetailInactive}
          locale={locale}
          open={taskDetailOpen}
          presentation={presentation}
          processes={processPresentation}
          onClose={closeTaskDetail}
          onOpenReview={capabilityDrawer.disabled ? undefined : openReview}
          onOpenTerminal={capabilityDrawer.disabled ? undefined : openTerminal}
          onStopTask={
            commandWorkspaceProps.activeTurnId &&
            commandWorkspaceProps.connectionState === "connected" &&
            commandWorkspaceProps.onStop
              ? stopCurrentTask
              : undefined
          }
          stopTaskPending={stopTaskPending}
          onTerminateProcess={
            processAuthorityAvailable
              ? (processId) => void processRuntime.terminate(processId)
              : undefined
          }
        />
      ) : null}
      {taskDetailOpen && capabilityDrawer.open ? (
        <button
          aria-label={
            activeOverlay === "workbench"
              ? locale === "zh"
                ? "显示任务详细信息"
                : "Show task details"
              : locale === "zh"
                ? "显示工作台"
                : "Show workbench"
          }
          aria-controls={
            activeOverlay === "workbench"
              ? DEFAULT_TASK_DETAIL_POPOVER_ID
              : DEFAULT_COMMAND_WORKBENCH_ID
          }
          className="command-shell-overlay-switch"
          type="button"
          onClick={switchOverlay}
        >
          {activeOverlay === "workbench" ? (
            <SlidersHorizontal aria-hidden="true" />
          ) : (
            <PanelRight aria-hidden="true" />
          )}
        </button>
      ) : null}
      <CommandWorkspaceCapabilityDrawer
        {...capabilityDrawer}
        interactionInactive={workbenchInactive}
        recordedReviewRequest={
          recordedReview &&
          recordedReview.threadId === selectedThread?.id &&
          changeDetails
            ? { sequence: recordedReview.sequence, details: changeDetails }
            : null
        }
        onClose={closeCapabilityAndRestoreFocus}
        onOpen={openCapability}
      />
      <AppConfirmDialog {...confirmDialog} />
    </div>
  );
}
