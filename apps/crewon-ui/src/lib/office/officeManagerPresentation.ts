import type { OfficeWorkspace } from "../domain/crewonDomain";
import type { Locale } from "../i18n";

/** Presents the server-owned Office manager separately from recruited members. */
export function officeManagerPresentation(
  workspace: OfficeWorkspace,
  locale: Locale,
) {
  const ready = Boolean(workspace.threadId?.trim());
  const zh = locale === "zh";
  return {
    accent: "cyan" as const,
    glyph: zh ? "组" : "L",
    name: zh ? "办公室主控" : "Office manager",
    role: zh
      ? "Leader Agent · 接收目标、拆解任务与协调员工"
      : "Leader Agent · receives goals, plans work, and coordinates members",
    status: ready
      ? zh
        ? "独立主控线程已就绪"
        : "Dedicated manager thread ready"
      : zh
        ? "将在首次消息前创建主控线程"
        : "Manager thread will be created before the first message",
  };
}
