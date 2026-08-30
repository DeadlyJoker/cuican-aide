import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CapabilityEditorDialog } from "./CapabilityEditorDialog";
import { mcpEditorDraftForPreset } from "../../lib/capability/capabilityCatalog";

function render(presetId: string) {
  return renderToStaticMarkup(
    <CapabilityEditorDialog
      busy={false}
      draft={mcpEditorDraftForPreset(presetId)}
      error={null}
      onChange={() => {}}
      onClose={() => {}}
      onSave={() => {}}
    />,
  );
}

describe("CapabilityEditorDialog", () => {
  it("renders typed MCP fields without a server URL or JSON editor", () => {
    const markup = render("filesystem");

    expect(markup).toContain("服务类型");
    expect(markup).toContain("允许访问的目录");
    expect(markup).toContain("无需填写 MCP Server URL");
    expect(markup).not.toContain("服务配置 JSON");
    expect(markup).not.toContain('name="url"');
    expect(markup).toMatchSnapshot();
  });

  it("renders OAuth and managed-service states", () => {
    const oauthMarkup = render("notion");
    const managedMarkup = render("wecom");

    expect(oauthMarkup).toContain("保存并登录");
    expect(oauthMarkup).toContain("自动打开官方登录页");
    expect(oauthMarkup).toMatchSnapshot();
    expect(managedMarkup).toContain("组织服务目录下发");
    expect(managedMarkup).toContain("CrewON 不允许手工填写或猜测 URL");
    expect(managedMarkup).toMatchSnapshot();
  });
});
