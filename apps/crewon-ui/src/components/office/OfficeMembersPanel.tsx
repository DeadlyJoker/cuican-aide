import type {
  LibraryPanel,
  LibraryPanelAction,
  OfficeWorkspace,
} from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

export function OfficeMembersPanel({
  actions,
  workspace,
  locale,
  onPanelAction,
}: {
  actions: LibraryPanel["actions"];
  workspace: OfficeWorkspace;
  locale: Locale;
  onPanelAction: (action: LibraryPanelAction) => void;
}) {
  return (
    <aside
      className="office-members"
      aria-label={locale === "zh" ? "成员" : "Members"}
    >
      <div className="office-rail-head">
        <strong>{locale === "zh" ? "成员" : "Members"}</strong>
        <span>{workspace.members.length}</span>
      </div>
      {workspace.members.map((member) => (
        <div className="office-member" key={member.name}>
          <span
            className="office-avatar"
            data-accent={member.accent}
            aria-hidden="true"
          >
            {member.glyph}
            <i
              className="office-presence"
              data-online={member.online ?? true}
            />
          </span>
          <span className="office-member-text">
            <strong>{member.name}</strong>
            <span>{member.role}</span>
            <em>{member.status}</em>
          </span>
        </div>
      ))}
      {actions ? (
        <div className="office-rail-actions">
          {actions.map((action) => (
            <button
              type="button"
              data-tone={action.tone}
              key={action.id}
              onClick={() => onPanelAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
