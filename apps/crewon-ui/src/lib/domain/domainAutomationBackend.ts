import {
  type AppServerClient,
  type AutomationRunRecord,
  type DomainConfigListResponse,
} from "../app-server/appServer";
import { withBackendWorkspace } from "../backend/backendWorkspace";
import type { AutomationConfig, LibraryItem } from "./crewonDomain";
import { automationConfigRecordToLibraryItem } from "./domainLibraryItems";
import { writeAutomationConfigFile as writeStoredAutomationConfigFile } from "./domainPersistence";
import type { Locale } from "../i18n";
import { formatThreadTimestamp } from "../shared/text";
import { isUnsupportedRpcError } from "../shared/rpcErrors";

type AutomationConfigRecord = Pick<
  DomainConfigListResponse<AutomationConfig>["data"][number],
  "filePath" | "savedAt" | "config"
>;

export type AutomationRunWriteResult = {
  record: { runId: string; filePath: string } | null;
  warning: string | null;
};

export async function writeAppAutomationConfig(params: {
  client: AppServerClient | null;
  config: AutomationConfig;
  resolveBackendCwd: () => Promise<string>;
}): Promise<string | null> {
  const { client, config, resolveBackendCwd } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      writeStoredAutomationConfigFile(client, cwd, config),
  });
}

export function emptyAutomationRunItems(locale: Locale): LibraryItem[] {
  return [
    {
      title: locale === "zh" ? "暂无运行记录" : "No run history",
      meta: locale === "zh" ? "等待首次运行" : "Waiting for first run",
      description:
        locale === "zh"
          ? "点击立即运行后，会把请求和结果写入后端执行线程。"
          : "Run it once to write the request and result into the backend execution thread.",
      glyph: "◷",
      accent: "slate",
    },
  ];
}

export function automationRunRecordItems(
  records: Array<{
    filePath: string;
    savedAt: number;
    run: AutomationRunRecord;
  }>,
  locale: Locale,
): LibraryItem[] {
  const runs = records
    .slice(0, 6)
    .map(({ filePath, savedAt, run }): LibraryItem => {
      const status = automationRunStatusDisplay(run.status, locale);
      return {
        title: run.automationTitle,
        meta: [
          status.label,
          formatThreadTimestamp(
            run.completedAt ?? run.startedAt ?? savedAt,
            locale,
          ),
          run.runId,
        ]
          .filter(Boolean)
          .join(" · "),
        description: [
          run.note,
          run.threadId
            ? locale === "zh"
              ? `线程：${run.threadId}`
              : `Thread: ${run.threadId}`
            : null,
          run.turnId
            ? locale === "zh"
              ? `轮次：${run.turnId}`
              : `Turn: ${run.turnId}`
            : null,
          locale === "zh" ? `文件：${filePath}` : `File: ${filePath}`,
        ]
          .filter(Boolean)
          .join("\n"),
        glyph: status.glyph,
        accent: status.accent,
      };
    });

  if (runs.length === 0) {
    return emptyAutomationRunItems(locale);
  }

  return [
    {
      title: locale === "zh" ? "后端运行记录" : "Backend run history",
      meta:
        locale === "zh"
          ? `${records.length} 条记录`
          : `${records.length} records`,
      description:
        locale === "zh"
          ? "来自 app-server automation/runs/list 的最近运行记录。"
          : "Recent runs loaded from app-server automation/runs/list.",
      section: true,
    },
    ...runs,
  ];
}

function automationRunStatusDisplay(
  status: string,
  locale: Locale,
): Pick<LibraryItem, "accent" | "glyph"> & { label: string } {
  switch (status) {
    case "completed":
      return {
        label: locale === "zh" ? "完成" : "Completed",
        glyph: "✓",
        accent: "green",
      };
    case "inProgress":
    case "running":
      return {
        label: locale === "zh" ? "运行中" : "Running",
        glyph: "◷",
        accent: "blue",
      };
    case "failed":
      return {
        label: locale === "zh" ? "失败" : "Failed",
        glyph: "!",
        accent: "rose",
      };
    case "interrupted":
      return {
        label: locale === "zh" ? "已中断" : "Interrupted",
        glyph: "!",
        accent: "amber",
      };
    case "queued":
      return {
        label: locale === "zh" ? "排队中" : "Queued",
        glyph: "•",
        accent: "slate",
      };
    default:
      return {
        label: status,
        glyph: "•",
        accent: "slate",
      };
  }
}

export async function runAutomationConfig(
  client: AppServerClient,
  cwd: string,
  config: AutomationConfig,
  note: string | null,
  turnId: string | null,
  locale: Locale,
): Promise<AutomationRunWriteResult> {
  try {
    const response = await client.runAutomationConfig(
      cwd,
      config,
      note,
      turnId,
    );
    return {
      record: {
        runId: response.run.runId,
        filePath: response.filePath,
      },
      warning: null,
    };
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return {
      record: null,
      warning:
        locale === "zh"
          ? "自动化运行已继续，但当前 app-server 不支持 automation/run，运行历史不会被记录。"
          : "The automation run continued, but this app-server does not support automation/run, so run history was not recorded.",
    };
  }
}

export async function runAppAutomationConfig(params: {
  client: AppServerClient | null;
  config: AutomationConfig;
  note: string | null;
  turnId: string | null;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AutomationRunWriteResult> {
  const { client, config, note, turnId, locale, resolveBackendCwd } = params;
  return withBackendWorkspace({
    client,
    fallback: {
      record: null,
      warning:
        locale === "zh"
          ? "自动化运行已继续，但当前没有可用的后端工作区，运行历史不会被记录。"
          : "The automation run continued, but no backend workspace is available, so run history was not recorded.",
    },
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      runAutomationConfig(client, cwd, config, note, turnId, locale),
  });
}

export async function updateAutomationRun(
  client: AppServerClient,
  cwd: string,
  filePath: string,
  status: string,
  completedAt: number | null,
): Promise<void> {
  try {
    await client.updateAutomationRun(cwd, filePath, status, completedAt);
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
  }
}

export async function updateAppAutomationRun(params: {
  client: AppServerClient | null;
  filePath: string;
  status: string;
  completedAt: number | null;
  resolveBackendCwd: () => Promise<string>;
}): Promise<void> {
  const { client, filePath, status, completedAt, resolveBackendCwd } = params;
  await withBackendWorkspace({
    client,
    fallback: undefined,
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      updateAutomationRun(client, cwd, filePath, status, completedAt),
  });
}

export async function readAutomationRunItems(
  client: AppServerClient,
  cwd: string,
  threadId: string | null | undefined,
  locale: Locale,
): Promise<LibraryItem[]> {
  if (!threadId) {
    return emptyAutomationRunItems(locale);
  }
  try {
    const response = await client.listAutomationRuns(cwd, threadId);
    return automationRunRecordItems(response.data, locale);
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return emptyAutomationRunItems(locale);
  }
}

export async function readAppAutomationRunItems(params: {
  client: AppServerClient | null;
  threadId: string | null | undefined;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
}): Promise<LibraryItem[]> {
  const { client, threadId, locale, resolveBackendCwd } = params;
  if (!threadId) {
    return emptyAutomationRunItems(locale);
  }
  return withBackendWorkspace({
    client,
    fallback: emptyAutomationRunItems(locale),
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      readAutomationRunItems(client, cwd, threadId, locale),
  });
}

export async function automationConfigRecordsToLibraryItems(
  client: AppServerClient,
  cwd: string,
  records: Array<AutomationConfigRecord>,
  locale: Locale,
): Promise<LibraryItem[]> {
  const runItemsByThreadId = new Map<string, LibraryItem[]>();
  await Promise.all(
    records.map(async ({ config }) => {
      if (!config.threadId || runItemsByThreadId.has(config.threadId)) {
        return;
      }
      runItemsByThreadId.set(
        config.threadId,
        await readAutomationRunItems(client, cwd, config.threadId, locale),
      );
    }),
  );
  return records.map((record) =>
    automationConfigRecordToLibraryItem(
      record,
      locale,
      record.config.threadId
        ? (runItemsByThreadId.get(record.config.threadId) ??
            emptyAutomationRunItems(locale))
        : emptyAutomationRunItems(locale),
    ),
  );
}

export async function appAutomationConfigRecordsToLibraryItems(params: {
  client: AppServerClient | null;
  records: Array<AutomationConfigRecord>;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
}): Promise<LibraryItem[]> {
  const { client, records, locale, resolveBackendCwd } = params;
  return withBackendWorkspace({
    client,
    fallback: records.map((record) =>
      automationConfigRecordToLibraryItem(
        record,
        locale,
        emptyAutomationRunItems(locale),
      ),
    ),
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      automationConfigRecordsToLibraryItems(client, cwd, records, locale),
  });
}
