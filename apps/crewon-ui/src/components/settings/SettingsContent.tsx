import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import type { Locale } from "../../lib/i18n";

type SettingsContentProps = {
  disabled?: boolean;
  locale: Locale;
  panel: CapabilityPanel | null;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
};

export function SettingsContent({
  disabled = false,
  locale,
  panel,
  onPanelAction,
  onPanelFieldChange,
}: SettingsContentProps) {
  const copy =
    locale === "zh"
      ? {
          title: "设置",
          fallbackTitle: "账号",
          fallbackSubtitle: "账号、认证、用量、外观、集成与工作区设置",
          loading: "正在读取账号状态...",
        }
      : {
          title: "Settings",
          fallbackTitle: "Account",
          fallbackSubtitle:
            "Account, auth, usage, appearance, integrations, and workspace settings",
          loading: "Reading account status...",
        };
  const headingTitle = panel?.title ?? copy.fallbackTitle;
  const headingSubtitle = panel?.subtitle ?? copy.fallbackSubtitle;

  return (
    <section className="settings-page" aria-label={copy.title}>
      <main className="settings-content">
        <header className="settings-heading">
          <h1>{headingTitle}</h1>
          <p>{headingSubtitle}</p>
        </header>

        <section className="settings-card">
          {panel?.error ? (
            <p className="settings-error">{panel.error}</p>
          ) : null}
          {panel?.body ? <pre>{panel.body}</pre> : null}
          {panel?.fields ? (
            <div className="settings-field-list">
              {panel.fields.map((field) => (
                <label key={field.id}>
                  <span>{field.label}</span>
                  {field.options ? (
                    <select
                      value={field.value}
                      onChange={(event) =>
                        onPanelFieldChange(field.id, event.target.value)
                      }
                    >
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.secret ? "password" : "text"}
                      value={field.value}
                      placeholder={field.placeholder}
                      onChange={(event) =>
                        onPanelFieldChange(field.id, event.target.value)
                      }
                    />
                  )}
                </label>
              ))}
            </div>
          ) : null}
          {!panel?.body && !panel?.fields ? <pre>{copy.loading}</pre> : null}
          {panel?.actions ? (
            <div className="settings-actions">
              {panel.actions.map((action) => (
                <button
                  type="button"
                  data-tone={action.tone}
                  disabled={disabled}
                  key={action.id}
                  onClick={() => onPanelAction(action.id)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      </main>
    </section>
  );
}
