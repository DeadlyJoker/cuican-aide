import {
  AlertTriangle,
  CheckCircle2,
  Download,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useRef, useState } from "react";

import type { Locale } from "../../lib/i18n";
import {
  checkDesktopUpdate,
  IDLE_STATE,
  installUpdate,
  type ResolvedUpdate,
  type UpdateState,
  type UpdaterPortResolver,
} from "../../lib/update/desktopUpdate";
import { resolveUpdaterPort } from "../../lib/update/updaterPort";

type DesktopUpdateSettingsProps = {
  locale: Locale;
  resolvePort?: UpdaterPortResolver;
};

export function DesktopUpdateSettings({
  locale,
  resolvePort = resolveUpdaterPort,
}: DesktopUpdateSettingsProps) {
  const [state, setState] = useState<UpdateState>(IDLE_STATE);
  const [resolvedUpdate, setResolvedUpdate] = useState<ResolvedUpdate | null>(
    null,
  );
  const busyRef = useRef(false);

  const check = async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setResolvedUpdate(null);
    try {
      setResolvedUpdate(await checkDesktopUpdate(resolvePort, setState));
    } finally {
      busyRef.current = false;
    }
  };

  const install = async () => {
    if (busyRef.current || resolvedUpdate === null) {
      return;
    }
    busyRef.current = true;
    try {
      await installUpdate(resolvedUpdate.port, resolvedUpdate.handle, setState);
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <DesktopUpdateSettingsView
      locale={locale}
      state={state}
      onCheck={() => void check()}
      onInstall={() => void install()}
    />
  );
}

export function DesktopUpdateSettingsView({
  locale,
  state,
  onCheck,
  onInstall,
}: {
  locale: Locale;
  state: UpdateState;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const copy = desktopUpdateCopy(locale, state);
  const checking = state.phase === "checking";
  const downloading = state.phase === "downloading";
  const Icon =
    state.phase === "failed"
      ? AlertTriangle
      : state.phase === "current" || state.phase === "ready"
        ? CheckCircle2
        : checking
          ? LoaderCircle
          : state.phase === "available" || downloading
            ? Download
            : RefreshCw;

  return (
    <section className="settings-group" data-desktop-update={state.phase}>
      <h2>{copy.groupTitle}</h2>
      <div className="settings-card">
        <div className="settings-summary-sections">
          <section
            className="settings-summary-section settings-update-summary"
            role={state.phase === "failed" ? "alert" : "status"}
          >
            <Icon
              aria-hidden="true"
              className={checking ? "settings-loading-spinner" : undefined}
              size={17}
            />
            <span>
              <h3>{copy.title}</h3>
              <p>{copy.description}</p>
            </span>
            {state.notes ? (
              <p className="settings-update-notes">{state.notes}</p>
            ) : null}
            {downloading && state.progress !== undefined ? (
              <progress
                aria-label={copy.progressLabel}
                max={1}
                value={state.progress}
              />
            ) : null}
          </section>
        </div>
        {state.phase === "available" ? (
          <div className="settings-actions">
            <button data-tone="primary" type="button" onClick={onInstall}>
              {copy.install}
            </button>
          </div>
        ) : state.phase === "unsupported" ||
          state.phase === "downloading" ||
          state.phase === "ready" ? null : (
          <div className="settings-actions">
            <button type="button" disabled={checking} onClick={onCheck}>
              {checking ? copy.checking : copy.check}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function desktopUpdateCopy(locale: Locale, state: UpdateState) {
  const version = state.version ?? "";
  if (locale === "zh") {
    const stateCopy = {
      available: {
        title: `CrewON ${version} 可安装`,
        description: "安装会先下载并校验更新，成功后重新启动应用。",
      },
      checking: {
        title: "正在检查更新",
        description: "正在读取已签名的桌面更新清单…",
      },
      current: {
        title: "CrewON 已是最新版本",
        description: "当前没有可用的桌面更新。",
      },
      downloading: {
        title: `正在安装 CrewON ${version}`,
        description: "请保持应用打开；安装成功后才会重新启动。",
      },
      failed: {
        title: "更新未完成",
        description: state.error ?? "无法读取或安装桌面更新。",
      },
      idle: {
        title: "手动检查桌面更新",
        description: "仅在你点击检查时连接更新服务，不会定时检查或自动重启。",
      },
      ready: {
        title: `CrewON ${version} 已安装`,
        description: "正在重新启动应用…",
      },
      unsupported: {
        title: "此环境不支持桌面更新",
        description: "请在已安装的 CrewON 桌面应用中检查更新。",
      },
    }[state.phase];
    return {
      ...stateCopy,
      check: state.phase === "failed" ? "重新检查" : "检查更新",
      checking: "正在检查…",
      groupTitle: "应用更新",
      install: "安装并重启",
      progressLabel: "更新下载进度",
    };
  }

  const stateCopy = {
    available: {
      title: `CrewON ${version} is available`,
      description:
        "The update is downloaded and verified before the app restarts.",
    },
    checking: {
      title: "Checking for updates",
      description: "Reading the signed desktop update manifest…",
    },
    current: {
      title: "CrewON is up to date",
      description: "No desktop update is currently available.",
    },
    downloading: {
      title: `Installing CrewON ${version}`,
      description:
        "Keep the app open. It restarts only after installation succeeds.",
    },
    failed: {
      title: "Update did not complete",
      description:
        state.error ?? "The desktop update could not be checked or installed.",
    },
    idle: {
      title: "Check desktop updates manually",
      description:
        "CrewON contacts the update service only when you click check. It never checks on a timer or restarts automatically.",
    },
    ready: {
      title: `CrewON ${version} is installed`,
      description: "Restarting the app…",
    },
    unsupported: {
      title: "Desktop updates are unavailable here",
      description: "Check for updates from the installed CrewON desktop app.",
    },
  }[state.phase];
  return {
    ...stateCopy,
    check: state.phase === "failed" ? "Check again" : "Check for updates",
    checking: "Checking…",
    groupTitle: "App updates",
    install: "Install and restart",
    progressLabel: "Update download progress",
  };
}
