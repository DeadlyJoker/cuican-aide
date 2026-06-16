import { AppServerRpcError, type AppServerClient } from "./appServer";
import type { KnowledgeData } from "./crewonDomain";
import type { Locale } from "./i18n";
import { normalizeKnowledgeData } from "./libraryPanelFormatters";

export async function readKnowledgeData(
  client: AppServerClient,
  cwd: string,
  locale: Locale,
): Promise<KnowledgeData> {
  try {
    const response = await client.listKnowledge(cwd);
    return normalizeKnowledgeData(response.data);
  } catch (error) {
    if (isUnsupportedRpcError(error)) {
      throw new Error(
        locale === "zh"
          ? "当前 app-server 不支持 knowledge/list，请更新后端后再使用知识库。"
          : "The current app-server does not support knowledge/list. Update the backend before using Knowledge.",
      );
    }
    throw error;
  }
}

export async function writeKnowledgeMemory(
  client: AppServerClient,
  params: {
    cwd: string;
    locale: Locale;
    selectedThreadId?: string | null;
    selectedThreadTitle?: string | null;
  },
): Promise<string> {
  try {
    const response = await client.writeKnowledgeMemory({
      cwd: params.cwd,
      title: params.selectedThreadTitle ?? null,
      threadId: params.selectedThreadId ?? null,
      note:
        "Backend-connected knowledge memory can be reused by agents, offices, and automations.",
    });
    return response.filePath;
  } catch (error) {
    if (isUnsupportedRpcError(error)) {
      throw new Error(
        params.locale === "zh"
          ? "当前 app-server 不支持 knowledge/memory/write，请更新后端后再写入知识库。"
          : "The current app-server does not support knowledge/memory/write. Update the backend before writing knowledge.",
      );
    }
    throw error;
  }
}

function isUnsupportedRpcError(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.code === -32601;
}
