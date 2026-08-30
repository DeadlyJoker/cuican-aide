import type { ConnectionState } from "../../lib/shared/connectionState";

export function classNames(
  ...values: Array<string | false | null | undefined>
) {
  return values.filter(Boolean).join(" ");
}

export function connectionLabel(connectionState: ConnectionState) {
  switch (connectionState) {
    case "connected":
      return "本地能力已就绪";
    case "connecting":
      return "正在准备本地能力";
    case "demo":
      return "已连接：演示模式";
    case "disconnected":
      return "暂时无法连接，请稍后重试";
  }
}

/** Last path segment of a workspace directory, for display. */
export function workspaceName(path: string, emptyLabel = "无工作空间"): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return (
    normalized.split("/").filter(Boolean).pop() || normalized || emptyLabel
  );
}
