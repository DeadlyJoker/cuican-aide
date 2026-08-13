import type { AppServerClient } from "../app-server/appServer";
import { withBackendWorkspace } from "../backend/backendWorkspace";
import type { KnowledgeData } from "./crewonDomain";
import { normalizeKnowledgeData } from "./domainKnowledgeData";
import type { Locale } from "../i18n";
import { isUnsupportedRpcError } from "../shared/rpcErrors";

const EMPTY_KNOWLEDGE_DATA: KnowledgeData = { memories: [], sources: [] };

export function knowledgeReadUnavailableMessage(locale: Locale): string {
  return locale === "zh"
    ? "未连接本地 app-server，无法读取知识库。"
    : "Local app-server is not connected; unable to read knowledge.";
}

export async function readBackendKnowledgeData(params: {
  client: AppServerClient | null | undefined;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
}): Promise<KnowledgeData> {
  if (!params.client) {
    throw new Error(knowledgeReadUnavailableMessage(params.locale));
  }

  return withBackendWorkspace({
    client: params.client,
    fallback: EMPTY_KNOWLEDGE_DATA,
    resolveBackendCwd: params.resolveBackendCwd,
    run: ({ client, cwd }) => readKnowledgeData(client, cwd, params.locale),
  });
}

export async function writeBackendKnowledgeMemory(params: {
  client: AppServerClient | null | undefined;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
  selectedThreadId?: string | null;
  selectedThreadTitle?: string | null;
}): Promise<string | null> {
  return withBackendWorkspace({
    client: params.client,
    fallback: null,
    resolveBackendCwd: params.resolveBackendCwd,
    run: ({ client, cwd }) =>
      writeKnowledgeMemory(client, {
        cwd,
        locale: params.locale,
        selectedThreadId: params.selectedThreadId,
        selectedThreadTitle: params.selectedThreadTitle,
      }),
  });
}

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
      note: "Backend-connected knowledge memory can be reused by agents, offices, and automations.",
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
