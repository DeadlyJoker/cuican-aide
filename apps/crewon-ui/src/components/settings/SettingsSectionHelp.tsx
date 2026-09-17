import type { Locale } from "../../lib/i18n";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";
import "./SettingsSectionHelp.css";

export function SettingsSectionHelp({
  section,
  locale,
}: {
  section: SettingsSection;
  locale: Locale;
  onSectionChange?: (section: SettingsSection) => void;
}) {
  const zh = locale === "zh";
  const content =
    section === "appearance"
      ? {
          scope: zh ? "界面偏好" : "Interface preferences",
          text: zh
            ? "修改后立即生效，仅保存在当前设备。"
            : "Changes apply immediately and are saved on this device.",
        }
      : section === "personalization"
        ? {
            scope: zh
              ? "助理偏好 · 点击保存后生效"
              : "Assistant preferences · Save to apply",
            text: zh
              ? "用于助理之后的回复，不改变团队成员的职责。长期记忆仅在当前服务支持时可用。"
              : "Applies to future assistant replies, not team member roles. Long-term memory requires support from your service.",
          }
        : null;
  if (!content) return null;
  return (
    <aside className="settings-section-help" aria-label={content.scope}>
      <strong>{content.scope}</strong>
      <p>{content.text}</p>
    </aside>
  );
}
