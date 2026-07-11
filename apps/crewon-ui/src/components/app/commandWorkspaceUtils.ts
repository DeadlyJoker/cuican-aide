import type { ConnectionState } from "../../lib/shared/connectionState";

export function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function connectionLabel(connectionState: ConnectionState) {
  switch (connectionState) {
    case "connected":
      return "已连接：本地 app-server";
    case "connecting":
      return "连接中：正在连接本地 app-server";
    case "demo":
      return "已连接：演示模式";
    case "disconnected":
      return "未连接：请求暂不发送";
  }
}
