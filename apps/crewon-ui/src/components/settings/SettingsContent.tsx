import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleCheck,
  Link2,
  LoaderCircle,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import type { Locale } from "../../lib/i18n";
import {
  settingsSectionDescription,
  settingsSectionIconKey,
  settingsSectionLabel,
  type SettingsSection,
} from "../../lib/settings/settingsCatalog";
import { presentSettingsPanel } from "../../lib/settings/settingsProductPresentation";
import { SettingsFieldControl } from "./SettingsFieldControl";
import { SettingsIcon } from "./SettingsIcon";

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
  const headingDescription = settingsSectionDescription(activeSection, locale);
  const presentedPanel = presentSettingsPanel(activeSection, panel, locale);
  const controlsDisabled = disabled || dataMode !== "live";
  const fields = presentedPanel?.fields ?? [];
  const actions = presentedPanel?.actions ?? [];
  const rows = presentedPanel?.rows ?? [];
  const hasFields = fields.length > 0;
  const hasRows = rows.length > 0;
  const summarySections = presentedPanel?.body
    ? settingsSummarySections(presentedPanel.body, presentedPanel.title)
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
      data-section={activeSection}
    >
      <main className="settings-content">
        <header className="settings-heading">
          <span className="settings-heading-icon">
            <SettingsIcon
              icon={settingsSectionIconKey(activeSection)}
              size={18}
            />
          </span>
          <span className="settings-heading-copy">
            <h1>{headingTitle}</h1>
            <p>{headingDescription}</p>
          </span>
        </header>

        {dataMode !== "live" ? (
          <AlertCard
            icon={
              dataMode === "demo" ? (
                <AlertTriangle size={16} />
              ) : (
                <RefreshCw size={16} />
              )
            }
            title={copy.dataModeTitle[dataMode]}
            description={copy.dataModeDescription[dataMode]}
            variant={dataMode === "demo" ? "warning" : "default"}
          />
        ) : null}

        {dataMode === "live" && presentedPanel?.error ? (
          <>
            <AlertCard
              icon={<AlertTriangle size={17} />}
              title={copy.unavailable}
              description={presentedPanel.error}
              variant="destructive"
            />
            {!hasFields &&
            !hasRows &&
            summarySections.length === 0 &&
            actions.length > 0 ? (
              <SettingsActions
                actions={actions}
                disabled={controlsDisabled}
                onPanelAction={onPanelAction}
              />
            ) : null}
          </>
        ) : null}

        {hasRows ? (
          <section className="settings-group">
            <Card className="settings-card settings-rows-card">
              <CardContent className="settings-row-list pt-6">
                {rows.map((row) => (
                  <div className="settings-row" key={row.id}>
                    <span className="settings-row-copy">
                      <strong>
                        {row.title}
                        {row.badge ? (
                          <SettingsRowBadge label={row.badge} />
                        ) : null}
                      </strong>
                      {row.subtitle ? (
                        <small className="settings-row-subtitle">
                          {row.subtitle}
                        </small>
                      ) : null}
                      {row.meta && row.meta.length > 0 ? (
                        <small className="settings-row-meta">
                          {row.meta.join(" · ")}
                        </small>
                      ) : null}
                    </span>
                    {row.actions && row.actions.length > 0 ? (
                      <span className="settings-row-actions">
                        {row.actions.map((action) => (
                          <SettingsActionButton
                            action={action}
                            compact
                            disabled={controlsDisabled}
                            key={action.id}
                            onClick={() => onPanelAction(action.id)}
                          />
                        ))}
                      </span>
                    ) : null}
                  </div>
                ))}
              </CardContent>
              {actions.length > 0 ? (
                <CardContent className="pt-0">
                  <SettingsActions
                    actions={actions}
                    disabled={controlsDisabled}
                    onPanelAction={onPanelAction}
                  />
                </CardContent>
              ) : null}
            </Card>
          </section>
        ) : null}

        {hasFields ? (
          <section className="settings-group">
            <Card className="settings-card settings-form-card">
              <CardContent className="settings-field-list pt-6">
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
              </CardContent>
              {actions.length > 0 ? (
                <CardContent className="pt-0">
                  <SettingsActions
                    actions={actions}
                    disabled={controlsDisabled}
                    onPanelAction={onPanelAction}
                  />
                </CardContent>
              ) : null}
            </Card>
          </section>
        ) : null}

        {summarySections.length > 0 ? (
          <section className="settings-group">
            <Card className="settings-card settings-summary-card">
              <CardContent className="settings-summary-sections pt-6">
                {summarySections.map((section, index) => (
                  <SettingsSummarySectionView
                    key={`${section.title ?? "summary"}-${index}`}
                    section={section}
                  />
                ))}
              </CardContent>
              {actions.length > 0 && !hasRows && !hasFields ? (
                <CardContent className="pt-0">
                  <SettingsActions
                    actions={actions}
                    disabled={controlsDisabled}
                    onPanelAction={onPanelAction}
                  />
                </CardContent>
              ) : null}
            </Card>
          </section>
        ) : null}

        {dataMode === "live" &&
        !presentedPanel?.error &&
        summarySections.length === 0 &&
        !hasFields &&
        !hasRows ? (
          <Card className="settings-state-card" role="status">
            <LoaderCircle className="settings-loading-spinner" size={17} />
            <span>
              <strong>{copy.loadingTitle}</strong>
              <small>{copy.loading}</small>
            </span>
          </Card>
        ) : null}
      </main>
    </section>
  );
}

function AlertCard({
  icon,
  title,
  description,
  variant = "default",
}: {
  icon: ReactNode;
  title: string;
  description: string;
  variant?: "default" | "warning" | "destructive";
}) {
  /*
   * The stylesheet lays this card out as an icon-plus-text grid whose two
   * tracks are the direct children, so no CardContent wrapper here.
   */
  return (
    <Card
      className="settings-trust-callout"
      data-tone={variant === "default" ? undefined : variant}
    >
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </Card>
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
    <div className="settings-actions flex flex-wrap gap-2">
      {actions.map((action) => (
        <SettingsActionButton
          action={action}
          disabled={disabled}
          key={action.id}
          onClick={() => onPanelAction(action.id)}
        />
      ))}
    </div>
  );
}

function SettingsActionButton({
  action,
  compact = false,
  disabled,
  onClick,
}: {
  action: NonNullable<CapabilityPanel["actions"]>[number];
  compact?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const visual = settingsActionVisual(action.id);
  const iconOnly = compact || visual.utility;
  const Icon = visual.icon;
  return (
    <Button
      aria-label={action.label}
      className={iconOnly ? "settings-icon-action" : undefined}
      data-icon-only={iconOnly || undefined}
      data-tone={action.tone === "danger" ? "danger" : action.tone}
      disabled={disabled}
      size="sm"
      title={action.label}
      variant={action.tone === "primary" ? "default" : "outline"}
      onClick={onClick}
    >
      <Icon aria-hidden="true" size={14} />
      {iconOnly ? (
        <span className="visually-hidden">{action.label}</span>
      ) : (
        action.label
      )}
    </Button>
  );
}

function settingsActionVisual(actionId: string): {
  icon: LucideIcon;
  utility: boolean;
} {
  if (/refresh|retry/iu.test(actionId))
    return { icon: RefreshCw, utility: true };
  if (/reload/iu.test(actionId)) return { icon: RotateCw, utility: true };
  if (/delete|remove|revoke/iu.test(actionId))
    return { icon: Trash2, utility: false };
  if (/edit/iu.test(actionId)) return { icon: Pencil, utility: false };
  if (/test|probe/iu.test(actionId)) return { icon: Wifi, utility: false };
  if (/select|default/iu.test(actionId))
    return { icon: CircleCheck, utility: false };
  if (/add|pairing/iu.test(actionId)) return { icon: Plus, utility: false };
  if (/save/iu.test(actionId)) return { icon: Save, utility: false };
  if (/cancel/iu.test(actionId)) return { icon: X, utility: false };
  if (/logout|disable/iu.test(actionId))
    return { icon: LogOut, utility: false };
  if (/login|enable/iu.test(actionId)) return { icon: LogIn, utility: false };
  return { icon: Link2, utility: false };
}

function SettingsRowBadge({ label }: { label: string }) {
  if (
    /当前|使用|默认|已连接|active|current|default|connected|in use/iu.test(
      label,
    )
  ) {
    return (
      <span
        aria-label={label}
        className="settings-row-badge-icon"
        role="img"
        title={label}
      >
        <CheckCircle2 aria-hidden="true" />
      </span>
    );
  }
  return <em className="settings-row-badge">{label}</em>;
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
          demo: "当前为预览内容，暂时不能保存。",
          disconnected: "设置暂时无法读取，请稍后重试。",
          live: "",
        },
        dataModeTitle: {
          demo: "预览模式",
          disconnected: "设置暂不可用",
          live: "",
        },
        loading: "正在加载设置…",
        loadingTitle: "正在加载",
        title: "设置",
        unavailable: "暂时无法读取",
      }
    : {
        configuration: "Settings",
        currentStatus: "Current status",
        dataModeDescription: {
          demo: "This is a preview and cannot be saved yet.",
          disconnected:
            "Settings cannot be loaded right now. Try again shortly.",
          live: "",
        },
        dataModeTitle: {
          demo: "Preview mode",
          disconnected: "Settings unavailable",
          live: "",
        },
        loading: "Loading settings…",
        loadingTitle: "Loading",
        title: "Settings",
        unavailable: "Unable to read",
      };
}
