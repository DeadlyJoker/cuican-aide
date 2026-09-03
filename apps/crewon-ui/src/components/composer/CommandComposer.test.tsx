import { ShieldCheck } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandComposerSelect } from "./CommandComposer";
import {
  commandComposerPermissionLearnMoreLabel,
  commandComposerPermissionLearnMoreUrl,
  commandComposerPermissionOptions,
} from "./commandComposerPermissionOptions";

describe("CommandComposerSelect", () => {
  it("snapshots the original permission trigger states", () => {
    const options = commandComposerPermissionOptions("zh");
    const renderPermission = (
      value: "approve-for-me" | "full-access",
    ) =>
      renderToStaticMarkup(
        <CommandComposerSelect
          ariaLabel="权限选择"
          className="max-w-[180px]"
          contentClassName="w-[min(360px,var(--radix-select-content-available-width))]"
          icon={<ShieldCheck aria-hidden="true" />}
          menuHelp={{
            href: commandComposerPermissionLearnMoreUrl,
            label: commandComposerPermissionLearnMoreLabel("zh"),
          }}
          menuTitle="应如何批准 ChatGPT 操作？"
          options={options}
          showChevron={false}
          value={value}
          onChange={vi.fn()}
        />,
      );

    const approveForMe = renderPermission("approve-for-me");
    const fullAccess = renderPermission("full-access");

    expect(approveForMe).toContain("帮我批准");
    expect(approveForMe).toContain('data-selected-tone="normal"');
    expect(fullAccess).toContain("完全访问");
    expect(fullAccess).toContain('data-selected-tone="warning"');
    expect({ approveForMe, fullAccess }).toMatchSnapshot();
  });
});
