import {
  AppServerRpcError,
  type AppServerClient,
  type AutomationRunRecord,
  type DomainConfigListResponse,
} from "./appServer";
import type { AutomationConfig, LibraryItem } from "./crewonDomain";
import { automationConfigRecordToLibraryItem } from "./domainLibraryItems";
import type { Locale } from "./i18n";

type AutomationConfigRecord = Pick<
  DomainConfigListResponse<AutomationConfig>["data"][number],
  "filePath" | "savedAt" | "config"
>;

export type AutomationRunWriteResult = {
  record: { runId: string; filePath: string } | null;
  warning: string | null;
};

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
  const runs = records.slice(0, 6).map(({ filePath, savedAt, run }): LibraryItem => {
    const status = automationRunStatusDisplay(run.status, locale);
    return {
      title: run.automationTitle,
      meta: [
        status.label,
        formatUnixSeconds(run.completedAt ?? run.startedAt ?? savedAt, locale),
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
    const response = await client.runAutomationConfig(cwd, config, note, turnId);
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

function formatUnixSeconds(epochSeconds: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(epochSeconds * 1000));
}

function isUnsupportedRpcError(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.code === -32601;
}
