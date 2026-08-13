import type { ControlApiClient } from "@crewon/control-client";
import type {
  WorkspaceNativeReadonlyControlRequest,
  WorkspaceNativeReadonlyControlResponse,
} from "@crewon/contracts";
import {
  AlertTriangle,
  Braces,
  GitBranch,
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
  const requestGuardRef = useRef<WorkspaceReadonlyRequestGuard | null>(null);
  requestGuardRef.current ??= new WorkspaceReadonlyRequestGuard();
  const requestGuard = requestGuardRef.current;

  const refresh = useCallback(async () => {
    const request = requestGuard.begin();
    setState({ status: "loading" });
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
    return () => requestGuard.dispose();
  }, [requestGuard]);

  useEffect(() => {
    void refresh();
    return () => requestGuard.cancel();
  }, [refresh, requestGuard]);
  const result = state.status === "ready" ? state.result : null;
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
      <main className="command-readonly-results">
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
          <article
            className="command-git-entry"
            key={`${entry.index}${entry.worktree}:${entry.path}`}
          >
            <code>
              {entry.index}
              {entry.worktree}
            </code>
            <strong>{entry.path}</strong>
            <span>{statusLabel(entry.index, entry.worktree, locale)}</span>
          </article>
        ))}
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
