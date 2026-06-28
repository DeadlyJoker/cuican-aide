import type { AppServerNotification } from "../app-server/appServer";
import type { LibraryPanel, OfficeConfig } from "../domain/crewonDomain";

type StateSetter<T> = (updater: (current: T) => T) => void;
type OfficeRunList = NonNullable<
  NonNullable<OfficeConfig["workspace"]["activity"]>["runs"]
>;

export type OfficeRunUpdatedNotificationHandlerParams = {
  notification: AppServerNotification;
  setLibraryPanel: StateSetter<LibraryPanel | null>;
};

export function handleOfficeRunUpdatedAppNotification({
  notification,
  setLibraryPanel,
}: OfficeRunUpdatedNotificationHandlerParams): boolean {
  if (notification.method !== "office/run/updated") {
    return false;
  }

  const config = parseOfficeConfig(notification.params.config);
  if (!config) {
    return true;
  }
  const updatedConfig = addOfficeRunNotificationMetadata(config, {
    reason: notification.params.reason,
    sourceThreadId: notification.params.sourceThreadId,
    sourceTurnId: notification.params.sourceTurnId,
  });

  setLibraryPanel((panel) => {
    if (!panel || panel.kind !== "office" || !panel.workspace) {
      return panel;
    }
    if (
      !officeRunUpdateMatchesPanel(
        panel,
        updatedConfig,
        notification.params.filePath,
      )
    ) {
      return panel;
    }
    return {
      ...panel,
      configPath: notification.params.filePath ?? panel.configPath,
      title: updatedConfig.title,
      subtitle: updatedConfig.subtitle,
      workspace: {
        ...updatedConfig.workspace,
        backendStatus: "connected",
      },
    };
  });

  return true;
}

function parseOfficeConfig(value: unknown): OfficeConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<OfficeConfig>;
  if (
    typeof record.title !== "string" ||
    typeof record.subtitle !== "string" ||
    !record.workspace ||
    typeof record.workspace !== "object"
  ) {
    return null;
  }
  return record as OfficeConfig;
}

function addOfficeRunNotificationMetadata(
  config: OfficeConfig,
  metadata: {
    reason: string;
    sourceThreadId: string | null;
    sourceTurnId: string | null;
  },
): OfficeConfig {
  const activity = config.workspace.activity;
  const runs = activity?.runs;
  if (!activity || !runs?.length) {
    return config;
  }
  const latestRunIndex = latestOfficeRunIndex(runs);
  return {
    ...config,
    workspace: {
      ...config.workspace,
      activity: {
        ...activity,
        runs: runs.map((run, index) =>
          index === latestRunIndex
            ? {
                ...run,
                lastNotificationReason: metadata.reason,
                lastNotificationSourceThreadId:
                  metadata.sourceThreadId ?? undefined,
                lastNotificationSourceTurnId:
                  metadata.sourceTurnId ?? undefined,
              }
            : run,
        ),
      },
    },
  };
}

function latestOfficeRunIndex(runs: OfficeRunList) {
  return runs.reduce(
    (latestIndex, run, index) => {
      const timestamp = officeRunTimestamp(run);
      if (!timestamp) {
        return latestIndex;
      }
      const latestTimestamp = officeRunTimestamp(runs[latestIndex]);
      return timestamp.localeCompare(latestTimestamp) > 0 ? index : latestIndex;
    },
    0,
  );
}

function officeRunTimestamp(run: OfficeRunList[number]) {
  return run.updatedAt ?? run.completedAt ?? run.createdAt ?? "";
}

function officeRunUpdateMatchesPanel(
  panel: LibraryPanel,
  config: OfficeConfig,
  filePath?: string | null,
) {
  if (panel.configPath && filePath) {
    return panel.configPath === filePath;
  }
  const panelThreadId = panel.workspace?.threadId;
  const configThreadId = config.workspace.threadId;
  if (panelThreadId && configThreadId) {
    return panelThreadId === configThreadId;
  }
  return panel.title === config.title && panel.subtitle === config.subtitle;
}
