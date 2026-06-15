import {
  AppWindow,
  ArrowLeft,
  Bot,
  Cable,
  GitBranch,
  Globe,
  Keyboard,
  Palette,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CapabilityPanel } from "./CapabilityDock";
import type { Locale } from "../lib/i18n";
import {
  settingsCatalog,
  settingsSidebarCopy,
  type SettingsIconKey,
  type SettingsSection,
} from "../lib/settingsCatalog";

export type { SettingsSection } from "../lib/settingsCatalog";

type SettingsViewProps = {
  disabled?: boolean;
  locale: Locale;
  panel: CapabilityPanel | null;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
};

type SettingsSidebarProps = {
  activeSection: SettingsSection;
  locale: Locale;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
};

const settingsIcons: Record<SettingsIconKey, LucideIcon> = {
  "app-window": AppWindow,
  "bot": Bot,
  "cable": Cable,
  "git-branch": GitBranch,
  "globe": Globe,
  "keyboard": Keyboard,
  "palette": Palette,
  "shield-check": ShieldCheck,
  "sliders-horizontal": SlidersHorizontal,
  "sparkles": Sparkles,
  "terminal-square": TerminalSquare,
};

export function SettingsSidebar({
  activeSection,
  locale,
  onBack,
  onSectionChange,
}: SettingsSidebarProps) {
  const copy = settingsSidebarCopy(locale);

  return (
    <aside className="settings-sidebar" aria-label={copy.title}>
      <button className="settings-back-button" type="button" onClick={onBack}>
        <ArrowLeft size={14} />
        {copy.back}
      </button>
      <label className="settings-search">
        <Search size={13} />
        <input
          type="search"
          placeholder={copy.search}
          aria-label={copy.search}
        />
      </label>
      <div className="settings-nav-groups">
        {settingsCatalog.map((group) => (
          <div className="settings-nav-group" key={group.id}>
            <span>{copy[group.labelKey]}</span>
            {group.items.map((item) => {
              const Icon = settingsIcons[item.icon];
              return (
                <button
                  type="button"
                  data-active={item.id === activeSection}
                  key={item.id}
                  onClick={() => onSectionChange(item.id)}
                >
                  <Icon size={14} />
                  {copy[item.labelKey]}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

export function SettingsView({
  disabled = false,
  locale,
  panel,
  onPanelAction,
  onPanelFieldChange,
}: SettingsViewProps) {
  const copy =
    locale === "zh"
      ? {
          title: "设置",
          fallbackTitle: "常规",
          fallbackSubtitle: "认证、模型、权限、配置与用量",
          loading: "正在读取账号状态...",
        }
      : {
          title: "Settings",
          fallbackTitle: "General",
          fallbackSubtitle: "Auth, models, permissions, config, and usage",
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
