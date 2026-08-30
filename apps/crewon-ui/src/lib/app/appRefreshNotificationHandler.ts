import type { AppServerNotification } from "../app-server/appServer";
import {
  accountLoginNotice,
  accountRateLimitNotice,
  configWarningNotice,
  mcpOauthNotice,
  mcpStartupNotice,
} from "./appNotificationPresentation";
import type { NoticeState } from "./appRuntimeState";
import type { LibraryKind } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import type { SettingsSection } from "../settings/settingsCatalog";

export type RefreshNotificationHandlerParams = {
  locale: Locale;
  notification: AppServerNotification;
  refreshAccount: () => void;
  refreshComposerSlashCommands: () => void;
  refreshVisibleLibrary: (kind: LibraryKind) => void;
  refreshVisibleSettings: (sections: SettingsSection[]) => void;
  setNotice: (notice: NoticeState | null) => void;
};

export function handleRefreshAppNotification({
  locale,
  notification,
  refreshAccount,
  refreshComposerSlashCommands,
  refreshVisibleLibrary,
  refreshVisibleSettings,
  setNotice,
}: RefreshNotificationHandlerParams): boolean {
  switch (notification.method) {
    case "account/login/completed": {
      const { success, error } = notification.params;
      refreshAccount();
      setNotice(accountLoginNotice(success, error, locale));
      return true;
    }
    case "account/rateLimits/updated": {
      setNotice(accountRateLimitNotice(notification.params.rateLimits, locale));
      return true;
    }
    case "account/updated": {
      refreshAccount();
      return true;
    }
    case "app/list/updated": {
      refreshComposerSlashCommands();
      refreshVisibleSettings(["browser", "connections"]);
      return true;
    }
    case "configWarning": {
      const { summary, details, path } = notification.params;
      setNotice(configWarningNotice(summary, details, path));
      return true;
    }
    case "externalAgentConfig/import/completed": {
      refreshVisibleLibrary("agents");
      return true;
    }
    case "mcpServer/oauthLogin/completed": {
      const { name, success, error } = notification.params;
      refreshComposerSlashCommands();
      setNotice(mcpOauthNotice(name, success, error, locale));
      return true;
    }
    case "mcpServer/startupStatus/updated": {
      const { name, status, error } = notification.params;
      refreshComposerSlashCommands();
      setNotice(mcpStartupNotice(name, status, error));
      return true;
    }
    case "remoteControl/status/changed": {
      refreshVisibleSettings(["computer-control"]);
      return true;
    }
    case "skills/changed": {
      refreshComposerSlashCommands();
      refreshVisibleLibrary("tools");
      refreshVisibleSettings(["mcp-servers"]);
      return true;
    }
    default:
      return false;
  }
}
