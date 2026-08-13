import { AlertTriangle, CloudOff, LoaderCircle } from "lucide-react";

import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import type { Locale } from "../../lib/i18n";
import {
  settingsSectionLabel,
  type SettingsSection,
} from "../../lib/settings/settingsCatalog";
import { SettingsFieldControl } from "./SettingsFieldControl";

export type SettingsDataMode = "demo" | "disconnected" | "live";

type SettingsContentProps = {
  activeSection: SettingsSection;
  dataMode?: SettingsDataMode;
  disabled?: boolean;
  locale: Locale;
  panel: CapabilityPanel | null;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelFieldCommit?: (fieldId: string, value: string) => void;
};

type SettingsSummarySection = {
  bullets: string[];
  notes: string[];
  rows: Array<{ label: string; value: string }>;
  title: string | null;
};

export function SettingsContent({
  activeSection,
  dataMode = "live",
  disabled = false,
  locale,
  panel,
  onPanelAction,
  onPanelFieldChange,
  onPanelFieldCommit,
}: SettingsContentProps) {
  const copy = settingsContentCopy(locale);
  const headingTitle = settingsSectionLabel(activeSection, locale);
  const controlsDisabled = disabled || dataMode !== "live";
  const fields = panel?.fields ?? [];
  const actions = panel?.actions ?? [];
  const hasFields = fields.length > 0;
  const summarySections = panel?.body
    ? settingsSummarySections(panel.body, panel.title)
    : [];

  function changeField(
    fieldId: string,
    value: string,
    commitOnChange: boolean,
  ) {
    onPanelFieldChange(fieldId, value);
    if (commitOnChange) {
      onPanelFieldCommit?.(fieldId, value);
    }
  }

  return (
    <section
      className="settings-page"
      aria-label={copy.title}
      data-mode={dataMode}
    >
      <main className="settings-content">
        <header className="settings-heading">
          <h1>{headingTitle}</h1>
          {panel?.subtitle ? <p>{panel.subtitle}</p> : null}
        </header>

        {dataMode !== "live" ? (
          <section className="settings-trust-callout" data-mode={dataMode}>
            {dataMode === "demo" ? (
              <AlertTriangle size={16} aria-hidden="true" />
            ) : (
              <CloudOff size={16} aria-hidden="true" />
            )}
            <span>
              <strong>{copy.dataModeTitle[dataMode]}</strong>
              <small>{copy.dataModeDescription[dataMode]}</small>
            </span>
          </section>
        ) : null}

        {panel?.error ? (
          <section
            className="settings-state-card"
            data-tone="error"
            role="alert"
          >
            <AlertTriangle size={17} aria-hidden="true" />
            <span>
              <strong>{copy.unavailable}</strong>
              <small>{panel.error}</small>
            </span>
          </section>
        ) : null}

        {hasFields ? (
          <section className="settings-group">
            <h2>{copy.configuration}</h2>
            <div className="settings-card settings-form-card">
              <div className="settings-field-list">
                {fields.map((field) => (
                  <label data-control={field.control ?? "text"} key={field.id}>
                    <span className="settings-field-copy">
                      <strong>{field.label}</strong>
                      {field.description ? (
                        <small>{field.description}</small>
                      ) : null}
                    </span>
                    <SettingsFieldControl
                      disabled={controlsDisabled}
                      field={field}
                      onChange={(value, commitOnChange) =>
                        changeField(field.id, value, commitOnChange)
                      }
                    />
                  </label>
                ))}
              </div>
              {actions.length > 0 ? (
                <SettingsActions
                  actions={actions}
                  disabled={controlsDisabled}
                  onPanelAction={onPanelAction}
                />
              ) : null}
            </div>
          </section>
        ) : null}

        {!hasFields && summarySections.length > 0 ? (
          <section className="settings-group">
            <h2>{copy.currentStatus}</h2>
            <div className="settings-card settings-summary-card">
              <div className="settings-summary-sections">
                {summarySections.map((section, index) => (
                  <SettingsSummarySectionView
                    key={`${section.title ?? "summary"}-${index}`}
                    section={section}
                  />
                ))}
              </div>
              {actions.length > 0 ? (
                <SettingsActions
                  actions={actions}
                  disabled={controlsDisabled}
                  onPanelAction={onPanelAction}
                />
              ) : null}
            </div>
          </section>
        ) : null}

        {!panel?.error && summarySections.length === 0 && !hasFields ? (
          <section className="settings-state-card" role="status">
            <LoaderCircle className="settings-loading-spinner" size={17} />
            <span>
              <strong>{copy.loadingTitle}</strong>
              <small>{copy.loading}</small>
            </span>
          </section>
        ) : null}
      </main>
    </section>
  );
}

function SettingsActions({
  actions,
  disabled,
  onPanelAction,
}: {
  actions: NonNullable<CapabilityPanel["actions"]>;
  disabled: boolean;
  onPanelAction: (actionId: string) => void;
}) {
  return (
    <div className="settings-actions">
      {actions.map((action) => (
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
  );
}

function SettingsSummarySectionView({
  section,
}: {
  section: SettingsSummarySection;
}) {
  return (
    <section className="settings-summary-section">
      {section.title ? <h3>{section.title}</h3> : null}
      {section.rows.length > 0 ? (
        <dl>
          {section.rows.map((row, index) => (
            <div key={`${row.label}-${index}`}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {section.bullets.length > 0 ? (
        <ul>
          {section.bullets.map((bullet, index) => (
            <li key={`${bullet}-${index}`}>{bullet}</li>
          ))}
        </ul>
      ) : null}
      {section.notes.map((note, index) => (
        <p key={`${note}-${index}`}>{note}</p>
      ))}
    </section>
  );
}

function settingsSummarySections(
  body: string,
  panelTitle: string,
): SettingsSummarySection[] {
  return body
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.split("\n").map((line) => line.trim()))
    .filter((lines) => lines.some(Boolean))
    .map((lines) => {
      const contentLines = lines.filter(Boolean);
      const firstLine = contentLines[0] ?? "";
      const hasSectionTitle =
        contentLines.length > 1 &&
        !firstLine.startsWith("- ") &&
        splitSummaryRow(firstLine) === null;
      const rawTitle = hasSectionTitle ? firstLine : null;
      const section: SettingsSummarySection = {
        bullets: [],
        notes: [],
        rows: [],
        title: rawTitle === panelTitle ? null : rawTitle,
      };

      for (const line of hasSectionTitle
        ? contentLines.slice(1)
        : contentLines) {
        if (line.startsWith("- ")) {
          section.bullets.push(line.slice(2));
          continue;
        }
        const row = splitSummaryRow(line);
        if (row) {
          section.rows.push(row);
          continue;
        }
        section.notes.push(line);
      }

      return section;
    });
}

function splitSummaryRow(
  line: string,
): { label: string; value: string } | null {
  const separatorMatch = /^(.*?)(?::\s+|：)(.+)$/u.exec(line);
  if (!separatorMatch) {
    return null;
  }
  const [, label, value] = separatorMatch;
  if (!label?.trim() || !value?.trim()) {
    return null;
  }
  return { label: label.trim(), value: value.trim() };
}

function settingsContentCopy(locale: Locale) {
  return locale === "zh"
    ? {
        configuration: "设置",
        currentStatus: "当前状态",
        dataModeDescription: {
          demo: "当前仅展示演示内容，所有输入和操作均已锁定。",
          disconnected: "CrewON Control 不可用，不展示或保存占位配置。",
          live: "",
        },
        dataModeTitle: {
          demo: "演示模式不会保存",
          disconnected: "真实配置暂不可用",
          live: "",
        },
        loading: "正在读取真实配置与运行状态…",
        loadingTitle: "正在加载",
        title: "设置",
        unavailable: "暂时无法读取",
      }
    : {
        configuration: "Settings",
        currentStatus: "Current status",
        dataModeDescription: {
          demo: "Demo content is read-only and cannot be saved.",
          disconnected:
            "CrewON Control is unavailable, so placeholder settings are not shown or saved.",
          live: "",
        },
        dataModeTitle: {
          demo: "Demo mode does not save",
          disconnected: "Live configuration is unavailable",
          live: "",
        },
        loading: "Reading live configuration and runtime status…",
        loadingTitle: "Loading",
        title: "Settings",
        unavailable: "Unable to read",
      };
}
