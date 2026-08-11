import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceOperationView } from "@crewon/contracts";

import type { ControlWorkspaceState } from "../../lib/control-runtime/controlWorkspaceRuntime";
import {
  CommandWorkspaceOperationsPanel,
  type CommandWorkspaceOperationsPanelProps,
  type WorkspaceMutationAuthority,
} from "./CommandWorkspaceOperationsPanel";

describe("CommandWorkspaceOperationsPanel", () => {
  it("snapshots the compact desktop live panel with all durable statuses", () => {
    const markup = renderPanel({
      state: state("live", [
        operation("workspace:pending", 1, "pending", null),
        operation("workspace:completed", 2, "completed", {
          status: "completed",
          entries: Array.from({ length: 14 }, (_, index) => ({
            name:
              index === 1 ? "中文" : `entry-${String(index).padStart(2, "0")}`,
            kind: index % 2 === 0 ? ("file" as const) : ("directory" as const),
          })),
          truncated: false,
        }),
        operation("workspace:failed", 2, "failed", {
          status: "failed",
          code: "device_unavailable",
          retryable: true,
        }),
        operation("workspace:canceled", 2, "canceled", null),
      ]),
      mutationAuthority: "desktop",
      nativeWorkspaceSelected: true,
    });

    expect(markup).toContain('data-mutation-authority="desktop"');
    expect(markup).toContain("当前线程 · 已选择工作空间");
    expect(markup).toContain("执行中");
    expect(markup).toContain("已完成");
    expect(markup).toContain("失败");
    expect(markup).toContain("已取消");
    expect(markup).toContain("另有 9 项未在紧凑视图中展开");
    expect(markup).toContain("中文");
    expect(markup).not.toContain("entry-12");
    expect(markup).not.toContain("entry-13");
    expect(markup).not.toMatch(
      /\/Users\/|tenant|device_unavailable|deviceBinding|actionDigest/u,
    );
    expect(markup).toMatchSnapshot();
  });

  it("snapshots Team read-only and unavailable boundaries", () => {
    const readOnly = renderPanel({
      locale: "en",
      state: state("live", [
        operation("workspace:pending", 1, "pending", null),
      ]),
      mutationAuthority: "readOnly",
      nativeWorkspaceSelected: true,
    });
    const unavailable = renderPanel({
      locale: "en",
      state: state("unavailable", []),
      mutationAuthority: "unavailable",
      nativeWorkspaceSelected: true,
    });

    expect(readOnly).toContain("Team environments are currently read-only");
    expect(unavailable).toContain(
      "CrewON will not fall back to the legacy file API",
    );
    expect({ readOnly, unavailable }).toMatchSnapshot();
  });

  it("snapshots unknownOutcome with explicit recovery controls", () => {
    const markup = renderPanel({
      state: state("live", [
        operation("workspace:unknown", 3, "unknownOutcome", null),
      ]),
      mutationAuthority: "desktop",
      nativeWorkspaceSelected: true,
    });

    expect(markup).toContain('data-workspace-operation="unknownOutcome"');
    expect(markup).toContain("结果待确认");
    expect(markup).toContain("重新确认");
    expect(markup).toContain("取消");
    expect(markup).toMatchSnapshot();
  });

  it("snapshots the redacted native Workspace selector without exposing a path", () => {
    const markup = renderPanel({
      state: state("live", []),
      mutationAuthority: "desktop",
      nativeWorkspaceSelected: true,
      nativeWorkspaceDisplayName: "cuican-aide",
      onSelectNativeWorkspace: () => undefined,
      onClearNativeWorkspace: () => undefined,
    });

    expect(markup).toContain('data-native-workspace-selector="available"');
    expect(markup).toContain("cuican-aide");
    expect(markup).toContain('data-workspace-action="select-native"');
    expect(markup).toContain('data-workspace-action="clear-native"');
    expect(markup).not.toMatch(/\/Users\/|file:|workspaceBinding/u);
    expect(markup).toMatchSnapshot();
  });

  it("binds no mutation callback for read-only or unavailable authority", () => {
    for (const authority of [
      "readOnly",
      "unavailable",
    ] satisfies WorkspaceMutationAuthority[]) {
      const callbacks = {
        onCreate: vi.fn(),
        onReconcile: vi.fn(),
        onCancel: vi.fn(),
        onSelectNativeWorkspace: vi.fn(),
        onClearNativeWorkspace: vi.fn(),
      };
      const tree = CommandWorkspaceOperationsPanel({
        locale: "zh",
        state: state("live", [
          operation("workspace:pending", 1, "pending", null),
          operation("workspace:unknown", 2, "unknownOutcome", null),
        ]),
        nativeWorkspaceSelected: true,
        mutationAuthority: authority,
        ...callbacks,
      });

      const actions = findActions(tree);
      expect(
        actions.map(({ action, disabled, onClick }) => ({
          action,
          disabled,
          hasHandler: onClick !== undefined,
        })),
      ).toEqual([
        { action: "create", disabled: true, hasHandler: false },
        { action: "cancel", disabled: true, hasHandler: false },
        { action: "reconcile", disabled: true, hasHandler: false },
        { action: "cancel", disabled: true, hasHandler: false },
      ]);
      for (const action of actions) action.onClick?.();
      expect(callbacks.onCreate).not.toHaveBeenCalled();
      expect(callbacks.onReconcile).not.toHaveBeenCalled();
      expect(callbacks.onCancel).not.toHaveBeenCalled();
      expect(callbacks.onSelectNativeWorkspace).not.toHaveBeenCalled();
      expect(callbacks.onClearNativeWorkspace).not.toHaveBeenCalled();
      expect(
        renderToStaticMarkup(
          CommandWorkspaceOperationsPanel({
            locale: "zh",
            state: state("live", []),
            nativeWorkspaceSelected: true,
            nativeWorkspaceDisplayName: "safe-name",
            mutationAuthority: authority,
            ...callbacks,
          }),
        ),
      ).not.toContain("data-native-workspace-selector");
    }
  });

  it("binds native select and clear only for safe desktop authority", () => {
    const onSelectNativeWorkspace = vi.fn();
    const onClearNativeWorkspace = vi.fn();
    const tree = CommandWorkspaceOperationsPanel({
      ...baseProps(),
      nativeWorkspaceDisplayName: "safe-name",
      onSelectNativeWorkspace,
      onClearNativeWorkspace,
    });

    findAction(tree, "select-native").onClick?.();
    findAction(tree, "clear-native").onClick?.();

    expect(onSelectNativeWorkspace).toHaveBeenCalledOnce();
    expect(onClearNativeWorkspace).toHaveBeenCalledOnce();

    const forged = renderToStaticMarkup(
      CommandWorkspaceOperationsPanel({
        ...baseProps(),
        nativeWorkspaceDisplayName: "/Users/private/project",
        onSelectNativeWorkspace,
        onClearNativeWorkspace,
      }),
    );
    expect(forged).not.toContain("/Users/private/project");
    expect(forged).not.toContain('data-workspace-action="clear-native"');
  });

  it("renders only bounded native authority warnings", () => {
    const activeAuthority = renderPanel({
      state: state("live", []),
      mutationAuthority: "desktop",
      nativeWorkspaceSelected: true,
      safeError: "nativeActiveAuthority",
    });
    const conflict = renderPanel({
      state: state("live", []),
      mutationAuthority: "desktop",
      nativeWorkspaceSelected: true,
      safeError: "nativeConflict",
    });
    const unknown = renderPanel({
      state: state("live", []),
      mutationAuthority: "desktop",
      nativeWorkspaceSelected: true,
      safeError: "nativeUnknown",
    });

    expect(activeAuthority).toContain(
      'data-workspace-safe-error="nativeActiveAuthority"',
    );
    expect(activeAuthority).toContain("请先结束活动任务或工作空间操作");
    expect(conflict).toContain('data-workspace-safe-error="nativeConflict"');
    expect(conflict).toContain("本机工作空间状态已变化");
    expect(unknown).toContain('data-workspace-safe-error="nativeUnknown"');
    expect(unknown).toContain("请勿重复提交");
    expect(`${activeAuthority}${conflict}${unknown}`).not.toMatch(
      /desktop_workspace_|raw|secret|stack|code=/iu,
    );
  });

  it("gates create on desktop, live Control Thread, and native Workspace authority", () => {
    const onCreate = vi.fn();
    const enabled = CommandWorkspaceOperationsPanel({
      ...baseProps(),
      onCreate,
    });
    const disabled = CommandWorkspaceOperationsPanel({
      ...baseProps(),
      nativeWorkspaceSelected: false,
      onCreate,
    });

    findAction(enabled, "create").onClick?.();
    findAction(disabled, "create").onClick?.();

    expect(onCreate).toHaveBeenCalledOnce();
    expect(findAction(disabled, "create")).toEqual(
      expect.objectContaining({ disabled: true, onClick: undefined }),
    );
  });

  it("derives inactive Thread gating only from the Control snapshot", () => {
    for (const threadStatus of ["archived", "deleted"] as const) {
      const onCreate = vi.fn();
      const tree = CommandWorkspaceOperationsPanel({
        ...baseProps(),
        state: { ...state("live", []), threadStatus },
        onCreate,
      });

      findAction(tree, "create").onClick?.();
      expect(findAction(tree, "create")).toEqual(
        expect.objectContaining({ disabled: true, onClick: undefined }),
      );
      expect(onCreate).not.toHaveBeenCalled();
      expect(renderToStaticMarkup(tree)).toContain("当前线程不是活动状态");
    }
  });

  it("announces conflict and error states without exposing remote error text", () => {
    const conflict = renderPanel({
      state: state("conflict", []),
      mutationAuthority: "desktop",
      nativeWorkspaceSelected: true,
    });
    const error = renderPanel({
      state: state("error", []),
      mutationAuthority: "desktop",
      nativeWorkspaceSelected: true,
    });

    expect(conflict).toContain('role="alert"');
    expect(conflict).toContain("状态已变化");
    expect(error).toContain('role="alert"');
    expect(error).toContain("同步失败");

    const recoverableConflict = CommandWorkspaceOperationsPanel({
      ...baseProps(),
      state: state("conflict", [
        operation("workspace:unknown", 3, "unknownOutcome", null),
      ]),
    });
    const blockedError = CommandWorkspaceOperationsPanel({
      ...baseProps(),
      state: state("error", [
        operation("workspace:unknown", 3, "unknownOutcome", null),
      ]),
    });
    expect(findAction(recoverableConflict, "reconcile").disabled).toBe(false);
    expect(findAction(blockedError, "reconcile").disabled).toBe(true);
  });
});

function baseProps(): CommandWorkspaceOperationsPanelProps {
  return {
    locale: "zh",
    state: state("live", []),
    nativeWorkspaceSelected: true,
    mutationAuthority: "desktop",
    onCreate: () => undefined,
    onReconcile: () => undefined,
    onCancel: () => undefined,
  };
}

function renderPanel(
  input: Pick<
    CommandWorkspaceOperationsPanelProps,
    "mutationAuthority" | "nativeWorkspaceSelected" | "state"
  > &
    Partial<
      Pick<
        CommandWorkspaceOperationsPanelProps,
        | "locale"
        | "nativeWorkspaceDisplayName"
        | "nativeWorkspaceBusy"
        | "safeError"
        | "onSelectNativeWorkspace"
        | "onClearNativeWorkspace"
      >
    >,
): string {
  const { locale = "zh", ...props } = input;
  return renderToStaticMarkup(
    <CommandWorkspaceOperationsPanel
      {...props}
      locale={locale}
      onCreate={() => undefined}
      onReconcile={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

function state(
  status: ControlWorkspaceState["status"],
  operations: readonly WorkspaceOperationView[],
): ControlWorkspaceState {
  return {
    status,
    threadId: status === "unavailable" ? null : "thread-1",
    threadRevision: status === "unavailable" ? null : 4,
    threadStatus: status === "unavailable" ? null : "active",
    operations,
    eventSequences: Object.fromEntries(
      operations.map((operation) => [
        operation.executionId,
        operation.revision,
      ]),
    ),
  };
}

function operation(
  executionId: string,
  revision: number,
  status: WorkspaceOperationView["status"],
  result: WorkspaceOperationView["result"],
): WorkspaceOperationView {
  return {
    threadId: "thread-1",
    executionId,
    revision,
    status,
    result,
  } as WorkspaceOperationView;
}

type Action = Readonly<{
  action: string;
  disabled: boolean;
  onClick: (() => void) | undefined;
}>;

function findAction(node: ReactNode, action: string): Action {
  const match = findActions(node).find(
    (candidate) => candidate.action === action,
  );
  if (match === undefined) throw new Error(`missing action ${action}`);
  return match;
}

function findActions(node: ReactNode): Action[] {
  if (Array.isArray(node)) return node.flatMap(findActions);
  if (!isValidElement(node)) return [];
  const props = node.props as {
    "children"?: ReactNode;
    "data-workspace-action"?: string;
    "disabled"?: boolean;
    "onClick"?: () => void;
  };
  if (typeof node.type === "function") {
    return findActions(
      (node.type as (input: typeof props) => ReactNode)(props),
    );
  }
  const nested = findActions(props.children);
  return props["data-workspace-action"] === undefined
    ? nested
    : [
        {
          action: props["data-workspace-action"],
          disabled: props.disabled === true,
          onClick: props.onClick,
        },
        ...nested,
      ];
}
