import type { LibraryPanel, OfficeWorkspace } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

function backendStatusLabel(
  status: OfficeWorkspace["backendStatus"],
  locale: Locale,
) {
  if (locale === "zh") {
    return status === "connected"
      ? "后端线程已连接"
      : status === "binding"
        ? "正在绑定后端线程"
        : status === "error"
          ? "后端连接异常"
          : "本地演示";
  }
  return status === "connected"
    ? "Backend thread connected"
    : status === "binding"
      ? "Binding backend thread"
      : status === "error"
        ? "Backend connection error"
        : "Local demo";
}

export function OfficeWorkspaceHeader({
  panel,
  workspace,
  locale,
  onBack,
}: {
  panel: LibraryPanel;
  workspace: OfficeWorkspace;
  locale: Locale;
  onBack: () => void;
}) {
  return (
    <header className="office-top">
      <button type="button" className="office-back" onClick={onBack}>
        {locale === "zh" ? "返回办公室" : "Back to offices"}
      </button>
      <div className="office-top-main">
        <div className="office-top-title">
          <span className="office-top-glyph" aria-hidden="true">
            ⌗
          </span>
          <div>
            <h1>{panel.title}</h1>
            <p>{panel.subtitle}</p>
          </div>
        </div>
        <div className="office-avatars" aria-hidden="true">
          {workspace.members.map((member) => (
            <span
              className="office-avatar"
              data-accent={member.accent}
              key={member.name}
              title={member.name}
            >
              {member.glyph}
            </span>
          ))}
        </div>
      </div>
      <div className="office-goal">
        <span>{locale === "zh" ? "办公室目标" : "Office goal"}</span>
        <strong>{workspace.goal}</strong>
        <em data-status={workspace.backendStatus ?? "local"}>
          {backendStatusLabel(workspace.backendStatus, locale)}
        </em>
      </div>
    </header>
  );
}
