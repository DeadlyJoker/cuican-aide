import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  workbenchWebUrl,
  type TaskWorkbenchSnapshot,
  type WorkbenchDocument,
} from "../../lib/workbench/taskWorkbenchProjection";

export type WorkbenchOpenRequest =
  | Readonly<{
      sequence: number;
      scopeId: string;
      kind: "document";
      document: WorkbenchDocument;
    }>
  | Readonly<{
      sequence: number;
      scopeId: string;
      kind: "browser";
      url: string;
      source: string;
    }>;
type WorkbenchActions = {
  publish: (owner: symbol, snapshot: TaskWorkbenchSnapshot | null) => void;
  reveal: (
    snapshot: TaskWorkbenchSnapshot,
    document: WorkbenchDocument,
  ) => void;
  browse: (
    snapshot: TaskWorkbenchSnapshot,
    url: string,
    source: string,
  ) => boolean;
};
export const TaskWorkbenchActionsContext =
  createContext<WorkbenchActions | null>(null);
const TaskWorkbenchSourceContext = createContext<TaskWorkbenchSnapshot | null>(
  null,
);
export const WorkbenchVisibilityContext = createContext(true);

type WorkbenchPublication = {
  owner: symbol;
  snapshot: TaskWorkbenchSnapshot;
} | null;
export function updateWorkbenchPublication(
  current: WorkbenchPublication,
  owner: symbol,
  snapshot: TaskWorkbenchSnapshot | null,
): WorkbenchPublication {
  if (!snapshot) return current?.owner === owner ? null : current;
  return current?.owner === owner && current.snapshot === snapshot
    ? current
    : { owner, snapshot };
}

export function useHasTaskWorkbench() {
  const actions = useContext(TaskWorkbenchActionsContext);
  const source = useContext(TaskWorkbenchSourceContext);
  return Boolean(actions && source);
}

export function WorkbenchSourceAnchor({
  originId,
  children,
}: {
  originId?: string;
  children: ReactNode;
}) {
  const hasWorkbench = useHasTaskWorkbench();
  return hasWorkbench && originId ? (
    <div data-workbench-origin={originId} tabIndex={-1}>
      {children}
    </div>
  ) : (
    <>{children}</>
  );
}

export function useTaskWorkbench(onOpen: () => void) {
  const [published, setPublished] = useState<{
    owner: symbol;
    snapshot: TaskWorkbenchSnapshot;
  } | null>(null);
  const [request, setRequest] = useState<WorkbenchOpenRequest | null>(null);
  useEffect(() => {
    setRequest((current) =>
      current?.scopeId === published?.snapshot.scopeId ? current : null,
    );
  }, [published?.snapshot.scopeId]);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const sequence = useRef(0);
  const publish = useCallback(
    (owner: symbol, snapshot: TaskWorkbenchSnapshot | null) => {
      setPublished((current) =>
        updateWorkbenchPublication(current, owner, snapshot),
      );
    },
    [],
  );
  const actions = useMemo<WorkbenchActions>(
    () => ({
      publish,
      reveal: (snapshot, document) => {
        setRequest({
          sequence: ++sequence.current,
          scopeId: snapshot.scopeId,
          kind: "document",
          document,
        });
        onOpenRef.current();
      },
      browse: (snapshot, value, source) => {
        const url = workbenchWebUrl(value);
        if (!url) return false;
        setRequest({
          sequence: ++sequence.current,
          scopeId: snapshot.scopeId,
          kind: "browser",
          url,
          source,
        });
        onOpenRef.current();
        return true;
      },
    }),
    [publish],
  );
  return {
    actions,
    snapshot: published?.snapshot ?? null,
    request: request?.scopeId === published?.snapshot.scopeId ? request : null,
  };
}

/** Mounted on the visible source only; late cleanup cannot clear a newer source. */
export function TaskWorkbenchScope({
  snapshot,
  active = true,
  children,
}: {
  snapshot: TaskWorkbenchSnapshot | null;
  active?: boolean;
  children?: ReactNode;
}) {
  const actions = useContext(TaskWorkbenchActionsContext);
  const parentVisible = useContext(WorkbenchVisibilityContext);
  const owner = useRef(Symbol("workbench-source"));
  const visible = active && parentVisible;
  useEffect(() => {
    if (!visible || !snapshot) return;
    actions?.publish(owner.current, snapshot);
  }, [actions, snapshot, visible]);
  useEffect(() => {
    if (!visible || !snapshot) return;
    const id = owner.current;
    return () => actions?.publish(id, null);
  }, [actions, snapshot?.scopeId, visible]);
  return (
    <TaskWorkbenchSourceContext.Provider value={visible ? snapshot : null}>
      {children}
    </TaskWorkbenchSourceContext.Provider>
  );
}

export function WorkbenchPreviewSource({
  snapshot,
  children,
}: {
  snapshot: TaskWorkbenchSnapshot;
  children: ReactNode;
}) {
  return (
    <TaskWorkbenchSourceContext.Provider value={snapshot}>
      {children}
    </TaskWorkbenchSourceContext.Provider>
  );
}

export function WorkbenchMarkdownLink({
  href,
  children,
  ...props
}: React.ComponentProps<"a">) {
  const source = useContext(TaskWorkbenchSourceContext);
  const actions = useContext(TaskWorkbenchActionsContext);
  const canPreview = Boolean(
    source && actions && href && workbenchWebUrl(href),
  );
  return (
    <a
      {...props}
      href={href}
      rel="noreferrer"
      target="_blank"
      title={canPreview ? "在工作台打开 · Open in workbench" : props.title}
      onClick={(event) => {
        props.onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey ||
          !source ||
          !actions ||
          !href
        )
          return;
        if (actions.browse(source, href, source.title)) event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}
