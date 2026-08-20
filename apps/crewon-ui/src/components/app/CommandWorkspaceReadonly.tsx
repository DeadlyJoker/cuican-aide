import type { ControlApiClient } from "@crewon/control-client";
import type {
  WorkspaceNativeReadonlyControlRequest,
  WorkspaceNativeReadonlyControlResponse,
} from "@crewon/contracts";
import {
  AlertTriangle,
  Braces,
  ChevronRight,
  Copy,
  File,
  Folder,
  GitBranch,
  Home,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { Locale } from "../../lib/i18n";

type ReadonlyClient = Pick<ControlApiClient, "executeWorkspaceReadonly">;
type SearchResponse = Extract<
  WorkspaceNativeReadonlyControlResponse,
  { operation: "contentSearch" }
>;
type StatusResponse = Extract<
  WorkspaceNativeReadonlyControlResponse,
  { operation: "gitStatus" }
>;
type DirectoryResponse = Extract<
  WorkspaceNativeReadonlyControlResponse,
  { operation: "listDirectory" }
>;
type FileResponse = Extract<
  WorkspaceNativeReadonlyControlResponse,
  { operation: "readTextFile" }
>;
type DiffResponse = Extract<
  WorkspaceNativeReadonlyControlResponse,
  { operation: "gitDiff" }
>;

export type WorkspaceReadonlyState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: T }
  | { status: "error"; message: string };

export type WorkspaceReadonlyRequest = Readonly<{
  controller: AbortController;
  identity: number;
}>;

export class WorkspaceReadonlyRequestGuard {
  #current: WorkspaceReadonlyRequest | null = null;
  #identity = 0;
  #mounted = true;

  begin(): WorkspaceReadonlyRequest {
    this.cancel();
    const request = {
      controller: new AbortController(),
      identity: ++this.#identity,
    };
    this.#current = request;
    return request;
  }

  cancel(): void {
    this.#current?.controller.abort();
    this.#current = null;
    this.#identity += 1;
  }

  isCurrent(request: WorkspaceReadonlyRequest): boolean {
    return (
      this.#mounted &&
      !request.controller.signal.aborted &&
      this.#current === request &&
      this.#identity === request.identity
    );
  }

  mount(): void {
    this.#mounted = true;
  }

  dispose(): void {
    this.#mounted = false;
    this.cancel();
  }
}

function safeError(locale: Locale): string {
  return locale === "zh"
    ? "无法读取当前工作区，请稍后重试。"
    : "The current workspace could not be read. Try again.";
}

export async function executeWorkspaceReadonly<
  T extends WorkspaceNativeReadonlyControlResponse,
>(
  client: ReadonlyClient | null,
  threadId: string | null,
  request: WorkspaceNativeReadonlyControlRequest,
  locale: Locale,
  signal?: AbortSignal,
): Promise<WorkspaceReadonlyState<T>> {
  if (!client || !threadId) {
    return { status: "error", message: safeError(locale) };
  }
  try {
    const result = await client.executeWorkspaceReadonly(threadId, request, {
      signal,
    });
    if (result.operation !== request.operation) {
      return { status: "error", message: safeError(locale) };
    }
    return { status: "ready", result: result as T };
  } catch {
    return { status: "error", message: safeError(locale) };
  }
}

function StateMessage({
  state,
  loading,
  idle,
}: {
  state: WorkspaceReadonlyState<unknown>;
  loading: string;
  idle: string;
}) {
  if (state.status === "loading") {
    return (
      <div className="command-readonly-state" role="status">
        {loading}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="command-readonly-state is-error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <span>{state.message}</span>
      </div>
    );
  }
  if (state.status === "idle") {
    return (
      <div className="command-readonly-state" role="status">
        {idle}
      </div>
    );
  }
  return null;
}

export function CommandWorkspaceSearch({
  client,
  locale,
  threadId,
}: {
  client: ReadonlyClient | null;
  locale: Locale;
  threadId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<WorkspaceReadonlyState<SearchResponse>>(
    client && threadId
      ? { status: "idle" }
      : { status: "error", message: safeError(locale) },
  );
  const requestGuardRef = useRef<WorkspaceReadonlyRequestGuard | null>(null);
  requestGuardRef.current ??= new WorkspaceReadonlyRequestGuard();
  const requestGuard = requestGuardRef.current;

  useEffect(() => {
    requestGuard.mount();
    return () => requestGuard.dispose();
  }, [requestGuard]);

  useEffect(() => {
    requestGuard.cancel();
    setState(
      client && threadId
        ? { status: "idle" }
        : { status: "error", message: safeError(locale) },
    );
  }, [client, locale, requestGuard, threadId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextQuery = query.trim();
    if (!nextQuery || state.status === "loading") return;
    const request = requestGuard.begin();
    setState({ status: "loading" });
    const nextState = await executeWorkspaceReadonly<SearchResponse>(
      client,
      threadId,
      {
        schemaVersion: "crewon.workspace-native-readonly-request.v0",
        operation: "contentSearch",
        query: nextQuery,
        pathSegments: [],
        maxMatches: 100,
      },
      locale,
      request.controller.signal,
    );
    if (requestGuard.isCurrent(request)) setState(nextState);
  }

  const result = state.status === "ready" ? state.result : null;
  return (
    <div className="command-readonly-workbench">
      <form className="command-readonly-toolbar" onSubmit={submit}>
        <Search aria-hidden="true" />
        <input
          aria-label={
            locale === "zh" ? "搜索工作区内容" : "Search workspace content"
          }
          disabled={!client || !threadId}
          placeholder={
            locale === "zh" ? "搜索代码和文本…" : "Search code and text…"
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          disabled={
            !query.trim() || !client || !threadId || state.status === "loading"
          }
          type="submit"
        >
          {locale === "zh" ? "搜索" : "Search"}
        </button>
      </form>
      <main className="command-readonly-results">
        <StateMessage
          idle={
            locale === "zh"
              ? "输入关键词搜索当前工作区"
              : "Search the current workspace"
          }
          state={state}
          loading={
            locale === "zh"
              ? "正在搜索当前工作区…"
              : "Searching the current workspace…"
          }
        />
        {result && result.matches.length === 0 ? (
          <div className="command-readonly-state" role="status">
            {locale === "zh" ? "没有匹配结果" : "No matches"}
          </div>
        ) : null}
        {result?.matches.map((match) => (
          <article
            className="command-search-match"
            key={`${match.path}:${match.line}:${match.preview}`}
          >
            <strong>
              {match.path}
              <span>:{match.line}</span>
            </strong>
            <code>{match.preview}</code>
          </article>
        ))}
      </main>
      {result ? (
        <footer className="command-readonly-summary">
          <span>
            {locale === "zh"
              ? `已扫描 ${result.scannedFiles} 个文件`
              : `${result.scannedFiles} files scanned`}
          </span>
          {result.truncated ? (
            <strong>
              <AlertTriangle aria-hidden="true" />
              {locale === "zh" ? "结果已截断" : "Results truncated"}
            </strong>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

export function CommandWorkspaceFiles({
  client,
  locale,
  threadId,
}: {
  client: ReadonlyClient | null;
  locale: Locale;
  threadId: string | null;
}) {
  const [pathSegments, setPathSegments] = useState<string[]>([]);
  const [directory, setDirectory] = useState<
    WorkspaceReadonlyState<DirectoryResponse>
  >(
    client && threadId
      ? { status: "loading" }
      : { status: "error", message: safeError(locale) },
  );
  const [preview, setPreview] = useState<WorkspaceReadonlyState<FileResponse>>({
    status: "idle",
  });
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const requestGuardRef = useRef<WorkspaceReadonlyRequestGuard | null>(null);
  requestGuardRef.current ??= new WorkspaceReadonlyRequestGuard();
  const requestGuard = requestGuardRef.current;
  const previewGuardRef = useRef<WorkspaceReadonlyRequestGuard | null>(null);
  previewGuardRef.current ??= new WorkspaceReadonlyRequestGuard();
  const previewGuard = previewGuardRef.current;
  const pathKey = pathSegments.join("\0");

  const refresh = useCallback(async () => {
    const request = requestGuard.begin();
    setDirectory({ status: "loading" });
    setPreview({ status: "idle" });
    const nextState = await executeWorkspaceReadonly<DirectoryResponse>(
      client,
      threadId,
      {
        schemaVersion: "crewon.workspace-native-readonly-request.v0",
        operation: "listDirectory",
        pathSegments,
      },
      locale,
      request.controller.signal,
    );
    if (requestGuard.isCurrent(request)) setDirectory(nextState);
  }, [client, locale, pathKey, requestGuard, threadId]);

  useEffect(() => {
    requestGuard.mount();
    previewGuard.mount();
    return () => {
      requestGuard.dispose();
      previewGuard.dispose();
    };
  }, [previewGuard, requestGuard]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGuard.cancel();
      previewGuard.cancel();
    };
  }, [previewGuard, refresh, requestGuard]);

  async function openFile(name: string) {
    const request = previewGuard.begin();
    setPreview({ status: "loading" });
    const nextState = await executeWorkspaceReadonly<FileResponse>(
      client,
      threadId,
      {
        schemaVersion: "crewon.workspace-native-readonly-request.v0",
        operation: "readTextFile",
        pathSegments: [...pathSegments, name],
      },
      locale,
      request.controller.signal,
    );
    if (previewGuard.isCurrent(request)) setPreview(nextState);
  }

  const result = directory.status === "ready" ? directory.result : null;
  const file = preview.status === "ready" ? preview.result : null;
  return (
    <div className="command-file-browser">
      <header className="command-file-breadcrumbs">
        <button
          aria-label={locale === "zh" ? "工作区根目录" : "Workspace root"}
          type="button"
          onClick={() => setPathSegments([])}
        >
          <Home aria-hidden="true" />
        </button>
        {pathSegments.map((segment, index) => (
          <span key={`${segment}:${index}`}>
            <ChevronRight aria-hidden="true" />
            <button
              type="button"
              onClick={() => setPathSegments(pathSegments.slice(0, index + 1))}
            >
              {segment}
            </button>
          </span>
        ))}
        <button
          aria-label={locale === "zh" ? "刷新文件" : "Refresh files"}
          disabled={!client || !threadId || directory.status === "loading"}
          type="button"
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </header>
      <div className="command-file-browser-body">
        <main className="command-file-list">
          <StateMessage
            idle={locale === "zh" ? "选择一个目录" : "Choose a directory"}
            loading={locale === "zh" ? "正在读取文件…" : "Reading files…"}
            state={directory}
          />
          {result?.entries.map((entry) => (
            <button
              className="command-file-entry"
              key={`${entry.kind}:${entry.name}`}
              type="button"
              onClick={() =>
                entry.kind === "directory"
                  ? setPathSegments([...pathSegments, entry.name])
                  : void openFile(entry.name)
              }
            >
              {entry.kind === "directory" ? (
                <Folder aria-hidden="true" />
              ) : (
                <File aria-hidden="true" />
              )}
              <span>{entry.name}</span>
              {entry.kind === "directory" ? (
                <ChevronRight aria-hidden="true" />
              ) : null}
            </button>
          ))}
          {result?.entries.length === 0 ? (
            <div className="command-readonly-state" role="status">
              {locale === "zh" ? "目录为空" : "Empty directory"}
            </div>
          ) : null}
          {result?.truncated ? (
            <div className="command-file-truncated" role="status">
              <AlertTriangle aria-hidden="true" />
              {locale === "zh" ? "文件列表已截断" : "File list truncated"}
            </div>
          ) : null}
        </main>
        <aside className="command-file-preview">
          <StateMessage
            idle={
              locale === "zh"
                ? "选择文本文件进行预览"
                : "Choose a text file to preview"
            }
            loading={locale === "zh" ? "正在读取文件内容…" : "Reading file…"}
            state={preview}
          />
          {file ? (
            <>
              <header>
                <strong>{file.path}</strong>
                <button
                  aria-label={locale === "zh" ? "复制路径" : "Copy path"}
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(file.path).then(
                      () => setCopiedPath(file.path),
                      () => setCopiedPath(null),
                    );
                  }}
                >
                  <Copy aria-hidden="true" />
                  {copiedPath === file.path
                    ? locale === "zh"
                      ? "已复制"
                      : "Copied"
                    : locale === "zh"
                      ? "复制路径"
                      : "Copy path"}
                </button>
              </header>
              <pre>
                <code>{file.content}</code>
              </pre>
              <footer>
                {file.size} {locale === "zh" ? "字节" : "bytes"}
                {file.truncated
                  ? locale === "zh"
                    ? " · 预览已截断"
                    : " · preview truncated"
                  : ""}
              </footer>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

export function CommandWorkspaceFilesAndSearch({
  client,
  locale,
  threadId,
}: {
  client: ReadonlyClient | null;
  locale: Locale;
  threadId: string | null;
}) {
  const [mode, setMode] = useState<"files" | "search">("files");
  return (
    <div className="command-files-search-tool">
      <div className="command-files-search-tabs" role="tablist">
        <button
          aria-selected={mode === "files"}
          className={mode === "files" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => setMode("files")}
        >
          <Folder aria-hidden="true" />
          {locale === "zh" ? "文件" : "Files"}
        </button>
        <button
          aria-selected={mode === "search"}
          className={mode === "search" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => setMode("search")}
        >
          <Search aria-hidden="true" />
          {locale === "zh" ? "搜索" : "Search"}
        </button>
      </div>
      {mode === "files" ? (
        <CommandWorkspaceFiles
          client={client}
          locale={locale}
          threadId={threadId}
        />
      ) : (
        <CommandWorkspaceSearch
          client={client}
          locale={locale}
          threadId={threadId}
        />
      )}
    </div>
  );
}

function statusLabel(index: string, worktree: string, locale: Locale): string {
  if (index === "?" && worktree === "?")
    return locale === "zh" ? "未跟踪" : "Untracked";
  if (index !== " " && worktree !== " ")
    return locale === "zh" ? "已暂存 · 工作区" : "Staged · worktree";
  return index !== " "
    ? locale === "zh"
      ? "已暂存"
      : "Staged"
    : locale === "zh"
      ? "工作区"
      : "Worktree";
}

export function CommandWorkspaceGitStatus({
  client,
  locale,
  threadId,
}: {
  client: ReadonlyClient | null;
  locale: Locale;
  threadId: string | null;
}) {
  const [state, setState] = useState<WorkspaceReadonlyState<StatusResponse>>(
    client && threadId
      ? { status: "loading" }
      : { status: "error", message: safeError(locale) },
  );
  const [diff, setDiff] = useState<WorkspaceReadonlyState<DiffResponse>>({
    status: "idle",
  });
  const requestGuardRef = useRef<WorkspaceReadonlyRequestGuard | null>(null);
  requestGuardRef.current ??= new WorkspaceReadonlyRequestGuard();
  const requestGuard = requestGuardRef.current;
  const diffGuardRef = useRef<WorkspaceReadonlyRequestGuard | null>(null);
  diffGuardRef.current ??= new WorkspaceReadonlyRequestGuard();
  const diffGuard = diffGuardRef.current;

  const refresh = useCallback(async () => {
    const request = requestGuard.begin();
    setState({ status: "loading" });
    setDiff({ status: "idle" });
    const nextState = await executeWorkspaceReadonly<StatusResponse>(
      client,
      threadId,
      {
        schemaVersion: "crewon.workspace-native-readonly-request.v0",
        operation: "gitStatus",
      },
      locale,
      request.controller.signal,
    );
    if (requestGuard.isCurrent(request)) setState(nextState);
  }, [client, locale, requestGuard, threadId]);

  useEffect(() => {
    requestGuard.mount();
    diffGuard.mount();
    return () => {
      requestGuard.dispose();
      diffGuard.dispose();
    };
  }, [diffGuard, requestGuard]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGuard.cancel();
      diffGuard.cancel();
    };
  }, [diffGuard, refresh, requestGuard]);

  async function openDiff(path: string) {
    const request = diffGuard.begin();
    setDiff({ status: "loading" });
    const nextState = await executeWorkspaceReadonly<DiffResponse>(
      client,
      threadId,
      {
        schemaVersion: "crewon.workspace-native-readonly-request.v0",
        operation: "gitDiff",
        pathSegments: path.split("/"),
      },
      locale,
      request.controller.signal,
    );
    if (diffGuard.isCurrent(request)) setDiff(nextState);
  }
  const result = state.status === "ready" ? state.result : null;
  const selectedDiff = diff.status === "ready" ? diff.result : null;
  return (
    <div className="command-readonly-workbench">
      <header className="command-readonly-toolbar command-git-toolbar">
        <GitBranch aria-hidden="true" />
        <strong>
          {result?.branch ?? (locale === "zh" ? "Git 状态" : "Git status")}
        </strong>
        {result?.head ? <code>{result.head.slice(0, 8)}</code> : null}
        <button
          disabled={!client || !threadId || state.status === "loading"}
          type="button"
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden="true" />
          {locale === "zh" ? "刷新" : "Refresh"}
        </button>
      </header>
      <main className="command-git-review">
        <section className="command-readonly-results">
          <StateMessage
            idle={
              locale === "zh" ? "Git 状态尚未加载" : "Git status is not loaded"
            }
            state={state}
            loading={
              locale === "zh" ? "正在读取 Git 状态…" : "Reading Git status…"
            }
          />
          {result && result.entries.length === 0 ? (
            <div className="command-readonly-state" role="status">
              <Braces aria-hidden="true" />
              <strong>
                {locale === "zh" ? "工作区干净" : "Working tree clean"}
              </strong>
            </div>
          ) : null}
          {result?.entries.map((entry) => (
            <button
              className="command-git-entry"
              key={`${entry.index}${entry.worktree}:${entry.path}`}
              type="button"
              onClick={() => void openDiff(entry.path)}
            >
              <code>
                {entry.index}
                {entry.worktree}
              </code>
              <strong>{entry.path}</strong>
              <span>{statusLabel(entry.index, entry.worktree, locale)}</span>
            </button>
          ))}
        </section>
        <aside className="command-git-diff-preview">
          <StateMessage
            idle={
              locale === "zh"
                ? "选择文件查看真实 Git diff"
                : "Choose a file to review its Git diff"
            }
            state={diff}
            loading={locale === "zh" ? "正在读取 diff…" : "Reading diff…"}
          />
          {selectedDiff ? (
            <>
              <header>
                <strong>{selectedDiff.path}</strong>
              </header>
              {selectedDiff.patch ? (
                <pre>
                  <code>{selectedDiff.patch}</code>
                </pre>
              ) : (
                <div className="command-readonly-state" role="status">
                  {locale === "zh"
                    ? "该文件暂无可显示的已跟踪 diff"
                    : "No tracked diff is available for this file"}
                </div>
              )}
            </>
          ) : null}
        </aside>
      </main>
      {result?.truncated ? (
        <footer className="command-readonly-summary">
          <strong>
            <AlertTriangle aria-hidden="true" />
            {locale === "zh" ? "状态列表已截断" : "Status list truncated"}
          </strong>
        </footer>
      ) : null}
    </div>
  );
}
