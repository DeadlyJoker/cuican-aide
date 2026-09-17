import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { controlSettingsPanel } from "../../lib/settings/controlSettingsPanels";
import { SettingsContent } from "./SettingsContent";
import { BundledTaskPackSettings } from "./BundledTaskPackSettings";

describe("Control settings presentation", () => {
  const sections = [
    "config",
    "connections",
    "account",
    "mcp-servers",
    "browser",
    "computer-control",
    "environment",
  ] as const;
  it.each(sections)(
    "renders honest %s content and available actions",
    (section) => {
      const panel = controlSettingsPanel({
        section,
        locale: "zh",
        state: { status: "loading" },
        surface: "web",
        platformUser: {
          id: 1,
          username: "admin",
          role: "admin",
          email: "admin@example.com",
        },
      });
      const markup = renderToStaticMarkup(
        <SettingsContent
          presentation="authored"
          activeSection={section}
          locale="zh"
          panel={panel}
          onPanelAction={vi.fn()}
          onPanelFieldChange={vi.fn()}
        >
          {section === "mcp-servers" && (
            <BundledTaskPackSettings
              locale="zh"
              userId={1}
              onPrepare={vi.fn()}
            />
          )}
        </SettingsContent>,
      );
      expect(markup).not.toContain("login-chatgpt");
      expect(markup).not.toContain("enable-remote-control");
      if (section === "mcp-servers") {
        expect(markup).toContain("使用模板");
        expect(markup).not.toContain("settings-loading-spinner");
      }
      expect(markup).toMatchSnapshot();
    },
  );

  it.each(["zh", "en"] as const)(
    "keeps implementation commentary out of %s settings",
    (locale) => {
      for (const section of sections) {
        const panel = controlSettingsPanel({
          section,
          locale,
          state: { status: "loading" },
          surface: "web",
          platformUser: null,
        });
        const copy = JSON.stringify(panel);
        expect(copy).not.toMatch(
          /CrewON Control|扩展原则|受治理|发布版本|激活目录|执行策略版本|不以零用量|尚未接入|声明式|宿主|governed runtime|active catalog|policy version|Extension principles|legacy settings/i,
        );
        expect(panel.fields).toBeUndefined();
      }
    },
  );
});
