import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  GripVertical,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  SquarePen,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AgentPlatformAccount } from "../auth/AgentPlatformAuthGate";
import type { CommandLinkedThread } from "./CommandWorkspaceChrome";
import { classNames } from "./commandWorkspaceUtils";

export type CommandWorkspaceClient = {
  archiveThread(threadId: string): Promise<unknown>;
  createDirectory(path: string, recursive?: boolean): Promise<unknown>;
  forkThread(threadId: string): Promise<{ thread: { id: string } }>;
  readDirectory(path: string): Promise<{
    entries: Array<{ fileName: string; isDirectory: boolean; isFile: boolean }>;
  }>;
  renameThread(threadId: string, name: string): Promise<unknown>;
};

type ProjectOrganization = "list" | "project";
type ProjectSort = "manual" | "priority" | "recent";

type ProjectPreferences = {
  collapsedProjects: string[];
  manualOrder: string[];
  organization: ProjectOrganization;
  pinnedThreadIds: string[];
  sort: ProjectSort;
};

const defaultPreferences: ProjectPreferences = {
  collapsedProjects: [],
  manualOrder: [],
  organization: "project",
  pinnedThreadIds: [],
  sort: "priority",
};

function preferencesKey(account: AgentPlatformAccount | null): string {
  return `crewon:command-projects:${account?.user.id ?? "anonymous"}`;
}

function readPreferences(account: AgentPlatformAccount | null): ProjectPreferences {
  if (typeof localStorage === "undefined") return defaultPreferences;
  try {
    const value = localStorage.getItem(preferencesKey(account));
    return value
      ? { ...defaultPreferences, ...(JSON.parse(value) as Partial<ProjectPreferences>) }
      : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
}

function writePreferences(account: AgentPlatformAccount | null, value: ProjectPreferences) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(preferencesKey(account), JSON.stringify(value));
}

function pathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function trimPath(path: string): string {
  if (!path.trim()) return "";
  const separator = pathSeparator(path);
  const root = separator === "/" ? "/" : /^[A-Za-z]:\\?$/.test(path) ? path.slice(0, 2) + "\\" : "";
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed || root || separator;
}

function parentPath(path: string): string {
  const normalized = trimPath(path);
  const separator = pathSeparator(normalized);
  if (normalized === separator || /^[A-Za-z]:\\$/.test(normalized)) return normalized;
  const parts = normalized.split(/[\\/]/);
  parts.pop();
  if (separator === "/") return parts.join("/") || "/";
  return parts.join("\\") || normalized;
}

function joinPath(parent: string, child: string): string {
  const separator = pathSeparator(parent);
  return `${trimPath(parent)}${trimPath(parent).endsWith(separator) ? "" : separator}${child}`;
}

function workspaceName(path: string, fallback = "无工作空间"): string {
  const normalized = trimPath(path);
  return normalized.split(/[\\/]/).filter(Boolean).pop() || normalized || fallback;
}

function menuKeyboard(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Escape") {
    event.preventDefault();
    const details = event.currentTarget.closest("details");
    details?.removeAttribute("open");
    details?.querySelector("summary")?.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  if (buttons.length === 0) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const delta = event.key === "ArrowDown" ? 1 : -1;
  buttons[(current + delta + buttons.length) % buttons.length]?.focus();
}

function copyText(value: string) {
  void navigator.clipboard.writeText(value);
}

export function CommandProjectTree({
  account,
  client,
  cwd,
  linkedThreads,
  selectedThreadId,
  onCreateWorkspace,
  onNewThread,
  onOpenThread,
}: {
  account: AgentPlatformAccount | null;
  client: CommandWorkspaceClient | null;
  cwd: string;
  linkedThreads: CommandLinkedThread[];
  selectedThreadId: string | null;
  onCreateWorkspace?: (cwd: string) => void;
  onNewThread: (workspaceCwd: string | null) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [preferences, setPreferences] = useState(() => readPreferences(account));
  const [directoryMode, setDirectoryMode] = useState<"create" | "existing" | null>(null);
  const [directoryPath, setDirectoryPath] = useState("");
  const [directories, setDirectories] = useState<string[]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const projectTreeRef = useRef<HTMLElement>(null);
  const preferencesAccountRef = useRef(account);

  useEffect(() => {
    preferencesAccountRef.current = account;
    setPreferences(readPreferences(account));
  }, [account?.user.id]);
  useEffect(
    () => writePreferences(preferencesAccountRef.current, preferences),
    [preferences],
  );
  useEffect(() => {
    function closeMenus(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      for (const menu of projectTreeRef.current?.querySelectorAll("details[open]") ?? []) {
        if (!menu.contains(event.target)) menu.removeAttribute("open");
      }
    }
    document.addEventListener("pointerdown", closeMenus);
    return () => document.removeEventListener("pointerdown", closeMenus);
  }, []);

  const pinned = useMemo(() => new Set(preferences.pinnedThreadIds), [preferences.pinnedThreadIds]);
  const manualRank = useMemo(
    () => new Map(preferences.manualOrder.map((id, index) => [id, index])),
    [preferences.manualOrder],
  );
  const sortedThreads = useMemo(() => {
    const threads = [...linkedThreads];
    return threads.sort((left, right) => {
      if (preferences.sort === "manual") {
        return (manualRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (manualRank.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      }
      if (preferences.sort === "priority") {
        const pinDifference = Number(pinned.has(right.id)) - Number(pinned.has(left.id));
        if (pinDifference) return pinDifference;
      }
      return right.updatedAt - left.updatedAt;
    });
  }, [linkedThreads, manualRank, pinned, preferences.sort]);

  const projects = useMemo(() => {
    if (preferences.organization === "list") {
      return [{ path: "", name: "全部任务", threads: sortedThreads }];
    }
    const groups = new Map<string, CommandLinkedThread[]>();
    if (cwd) groups.set(cwd, []);
    for (const thread of sortedThreads) {
      const path = thread.cwd ?? "";
      groups.set(path, [...(groups.get(path) ?? []), thread]);
    }
    return Array.from(groups, ([path, threads]) => ({ path, name: workspaceName(path), threads }));
  }, [cwd, preferences.organization, sortedThreads]);

  async function browse(path: string) {
    if (!client) {
      setDirectoryError("app-server 未连接，无法读取目录。");
      return;
    }
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      const response = await client.readDirectory(path);
      setDirectoryPath(trimPath(path));
      setDirectories(
        response.entries.filter((entry) => entry.isDirectory).map((entry) => entry.fileName).sort(),
      );
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "目录读取失败");
    } finally {
      setDirectoryLoading(false);
    }
  }

  function openDirectoryDialog(mode: "create" | "existing") {
    const start = parentPath(cwd || linkedThreads.find((thread) => thread.cwd)?.cwd || "/");
    setDirectoryMode(mode);
    setProjectName("");
    void browse(start);
  }

  function closeDirectoryDialog() {
    setDirectoryMode(null);
    setDirectoryError(null);
  }

  async function confirmDirectory() {
    if (directoryMode === "existing") {
      onCreateWorkspace?.(directoryPath);
      closeDirectoryDialog();
      return;
    }
    const name = projectName.trim();
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      setDirectoryError("项目名称不能为空，也不能包含路径分隔符。");
      return;
    }
    if (directories.includes(name)) {
      setDirectoryError("同名目录已经存在。");
      return;
    }
    try {
      const nextPath = joinPath(directoryPath, name);
      await client?.createDirectory(nextPath, false);
      onCreateWorkspace?.(nextPath);
      closeDirectoryDialog();
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "项目目录创建失败");
    }
  }

  function togglePinned(threadId: string) {
    setPreferences((current) => ({
      ...current,
      pinnedThreadIds: current.pinnedThreadIds.includes(threadId)
        ? current.pinnedThreadIds.filter((id) => id !== threadId)
        : [threadId, ...current.pinnedThreadIds],
    }));
  }

  function moveThread(threadId: string, delta: number) {
    const order = sortedThreads.map((thread) => thread.id);
    const index = order.indexOf(threadId);
    const nextIndex = Math.max(0, Math.min(order.length - 1, index + delta));
    if (index < 0 || index === nextIndex) return;
    order.splice(index, 1);
    order.splice(nextIndex, 0, threadId);
    setPreferences((current) => ({ ...current, manualOrder: order, sort: "manual" }));
  }

  async function renameThread(thread: CommandLinkedThread) {
    const nextName = window.prompt("重命名任务", thread.title)?.trim();
    if (nextName && nextName !== thread.title) await client?.renameThread(thread.id, nextName);
  }

  async function archiveThread(threadId: string) {
    await client?.archiveThread(threadId);
  }

  async function forkThread(threadId: string) {
    const response = await client?.forkThread(threadId);
    if (response?.thread.id) onOpenThread(response.thread.id);
  }

  function reorderByDrop(targetThreadId: string) {
    if (!draggedThreadId || draggedThreadId === targetThreadId) return;
    const order = sortedThreads.map((thread) => thread.id).filter((id) => id !== draggedThreadId);
    const targetIndex = order.indexOf(targetThreadId);
    order.splice(Math.max(0, targetIndex), 0, draggedThreadId);
    setPreferences((current) => ({ ...current, manualOrder: order, sort: "manual" }));
    setDraggedThreadId(null);
  }

  return (
    <section
      className="space-tree project-tree"
      aria-label="项目和任务"
      ref={projectTreeRef}
    >
      <div className="tree-head project-tree-head">
        <strong>项目</strong>
        <span>
          <details className="project-menu" onKeyDown={menuKeyboard}>
            <summary aria-label="整理项目"><MoreHorizontal aria-hidden="true" /></summary>
            <div className="project-menu-popover project-sort-menu" role="menu">
              <small>整理</small>
              <button type="button" onClick={() => setPreferences((value) => ({ ...value, organization: "project" }))}>
                {preferences.organization === "project" ? <Check /> : <span />}按项目
              </button>
              <button type="button" onClick={() => setPreferences((value) => ({ ...value, organization: "list" }))}>
                {preferences.organization === "list" ? <Check /> : <span />}在一个列表中
              </button>
              <hr />
              <small>排序方式</small>
              {([['priority', '优先级'], ['recent', '最近更新'], ['manual', '手动排序']] as const).map(([value, label]) => (
                <button key={value} type="button" onClick={() => setPreferences((current) => ({ ...current, sort: value }))}>
                  {preferences.sort === value ? <Check /> : <span />}{label}
                </button>
              ))}
            </div>
          </details>
          <details className="project-menu" onKeyDown={menuKeyboard}>
            <summary aria-label="添加项目"><Plus aria-hidden="true" /></summary>
            <div className="project-menu-popover project-add-menu" role="menu">
              <button type="button" onClick={() => openDirectoryDialog("create")}><Plus />新建空白项目</button>
              <button type="button" onClick={() => openDirectoryDialog("existing")}><Folder />使用现有文件夹</button>
            </div>
          </details>
        </span>
      </div>

      <div className="project-groups">
        {projects.map((project) => {
          const collapsed = preferences.collapsedProjects.includes(project.path);
          return (
            <section className="project-group" key={project.path || "all"}>
              {preferences.organization === "project" ? (
                <header className="project-row">
                  <button aria-label={`${collapsed ? "展开" : "折叠"}项目 ${project.name}`} type="button" className="project-row-main" onClick={() => setPreferences((current) => ({
                    ...current,
                    collapsedProjects: collapsed
                      ? current.collapsedProjects.filter((path) => path !== project.path)
                      : [...current.collapsedProjects, project.path],
                  }))}>
                    {collapsed ? <Folder /> : <FolderOpen />}<strong>{project.name}</strong>
                  </button>
                  <span className="project-row-actions">
                    <details className="project-menu project-row-menu" onKeyDown={menuKeyboard}>
                      <summary aria-label={`项目 ${project.name} 菜单`} title="项目菜单"><MoreHorizontal /></summary>
                      <div className="project-menu-popover project-row-menu-popover" role="menu">
                        <button type="button" disabled={!project.path} onClick={(event) => {
                          copyText(project.path);
                          event.currentTarget.closest("details")?.removeAttribute("open");
                        }}><Copy />复制项目路径</button>
                      </div>
                    </details>
                    <button aria-label={`在 ${project.name} 新建任务`} title="新建任务" type="button" onClick={() => onNewThread(project.path || null)}><SquarePen /></button>
                  </span>
                </header>
              ) : null}
              <div className="project-thread-list" hidden={collapsed}>
                {project.threads.map((thread) => (
                  <article
                    className={classNames("project-thread-row", selectedThreadId === thread.id && "active")}
                    data-linked-thread-id={thread.id}
                    draggable={preferences.sort === "manual"}
                    key={thread.id}
                    title={thread.preview}
                    onDragStart={() => setDraggedThreadId(thread.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => reorderByDrop(thread.id)}
                  >
                    {preferences.sort === "manual" ? <GripVertical className="project-drag-handle" aria-hidden="true" /> : null}
                    <button
                      className="project-thread-main"
                      type="button"
                      onClick={() => onOpenThread(thread.id)}
                      onKeyDown={(event) => {
                        if (event.altKey && event.key === "ArrowUp") moveThread(thread.id, -1);
                        if (event.altKey && event.key === "ArrowDown") moveThread(thread.id, 1);
                      }}
                    >
                      <span>{thread.title}</span><em>{thread.updatedLabel}</em>
                    </button>
                    <span className="project-thread-actions">
                      <button aria-label={pinned.has(thread.id) ? "取消置顶" : "置顶任务"} title={pinned.has(thread.id) ? "取消置顶" : "置顶任务"} type="button" onClick={() => togglePinned(thread.id)}><Pin fill={pinned.has(thread.id) ? "currentColor" : "none"} /></button>
                      <button aria-label="归档任务" title="归档任务" type="button" onClick={() => void archiveThread(thread.id)}><Archive /></button>
                      <details className="project-menu thread-menu" onKeyDown={menuKeyboard}>
                        <summary aria-label="任务菜单"><MoreHorizontal /></summary>
                        <div className="project-menu-popover thread-menu-popover" role="menu">
                          <button type="button" onClick={() => togglePinned(thread.id)}><Pin />{pinned.has(thread.id) ? "取消置顶" : "置顶任务"}</button>
                          <button type="button" onClick={() => void renameThread(thread)}><SquarePen />重命名任务</button>
                          <button type="button" onClick={() => void archiveThread(thread.id)}><Archive />归档任务</button>
                          <hr />
                          <button type="button" onClick={() => copyText(thread.cwd ?? "")}><Copy />复制工作目录</button>
                          <button type="button" onClick={() => copyText(thread.id)}><Copy />复制会话 ID</button>
                          <hr />
                          <button type="button" onClick={() => void forkThread(thread.id)}><Plus />在新任务中继续</button>
                        </div>
                      </details>
                    </span>
                  </article>
                ))}
                {project.threads.length === 0 ? <p className="sidebar-empty-hint">新建任务后会显示在这里。</p> : null}
              </div>
            </section>
          );
        })}
      </div>

      {directoryMode ? (
        <div className="project-directory-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDirectoryDialog();
        }}>
          <div className="project-directory-dialog" role="dialog" aria-modal="true" aria-label={directoryMode === "create" ? "新建空白项目" : "使用现有文件夹"} ref={dialogRef} onKeyDown={(event) => {
            if (event.key === "Escape") closeDirectoryDialog();
          }}>
            <header><strong>{directoryMode === "create" ? "新建空白项目" : "使用现有文件夹"}</strong><button aria-label="关闭" type="button" onClick={closeDirectoryDialog}><X /></button></header>
            <div className="project-directory-toolbar">
              <button aria-label="返回上一级" title="返回上一级" type="button" onClick={() => void browse(parentPath(directoryPath))}><ArrowLeft /></button>
              <code title={directoryPath}>{directoryPath}</code>
              <button aria-label="刷新目录" title="刷新目录" type="button" onClick={() => void browse(directoryPath)}><RefreshCw /></button>
            </div>
            <div className="project-directory-list" aria-busy={directoryLoading}>
              {directories.map((name) => <button key={name} type="button" onClick={() => void browse(joinPath(directoryPath, name))}><Folder /><span>{name}</span><ChevronRight /></button>)}
              {!directoryLoading && directories.length === 0 ? <p>当前目录没有子文件夹。</p> : null}
            </div>
            {directoryMode === "create" ? <label className="project-name-field"><span>项目名称</span><input autoFocus value={projectName} placeholder="例如：new-project" onChange={(event) => setProjectName(event.target.value)} /></label> : null}
            {directoryError ? <p className="project-directory-error" role="alert">{directoryError}</p> : null}
            <footer><button type="button" onClick={closeDirectoryDialog}>取消</button><button className="primary" disabled={!directoryPath || (directoryMode === "create" && !projectName.trim())} type="button" onClick={() => void confirmDirectory()}>{directoryMode === "create" ? "创建项目" : "使用此文件夹"}</button></footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
