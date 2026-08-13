import type { ConnectionState } from "../../lib/shared/connectionState";

export function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function connectionLabel(connectionState: ConnectionState) {
  switch (connectionState) {
    case "connected":
      return "已连接：CrewON Control";
    case "connecting":
      return "连接中：正在连接 CrewON Control";
    case "demo":
      return "已连接：演示模式";
    case "disconnected":
      return "未连接：请求暂不发送";
  }
}

/** Last path segment of a workspace directory, for display. */
export function workspaceName(path: string, emptyLabel = "无工作空间"): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return (
    normalized.split("/").filter(Boolean).pop() || normalized || emptyLabel
  );
}
