// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import { renderToStaticMarkup } from "react-dom/server";
import { InstalledPluginCreditSettings } from "../settings/InstalledPluginCreditSettings";
import { ControlSettingsContent } from "./ControlSettingsContent";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("personal credits in the original settings slot", () => {
  it("identifies the real Native device ledger without presenting it as the signed-in user's personal balance", () => {
    const client = { listAccounts: vi.fn(), getEntries: vi.fn() };
    const markup = renderToStaticMarkup(
      <InstalledPluginCreditSettings
        client={client}
        ownerKey="actual-device-client"
        locale="zh"
        accountSource="localDevice"
      />,
    );
    expect(markup).toContain("本机插件积分");
    expect(markup).toContain("登录账号的个人积分尚未接通");
    expect(markup).not.toContain("当前账号的独立积分账户");
    expect(client.listAccounts).not.toHaveBeenCalled();
  });
  it("uses authenticated Control GET only in Tools, preserves templates and clears the old account when its owner changes", async () => {
    const calls: string[] = [];
    let owner = 37;
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      accessToken: "named-test-token",
      origin: "https://ui.test",
      fetch: async (url, init) => {
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer named-test-token",
        );
        const path = new URL(String(url)).pathname;
        calls.push(path);
        const result = path.endsWith("/credits/accounts")
          ? {
              schemaVersion: "crewon.plugin-credit-accounts.v1",
              state: "ready",
              accounts: [
                {
                  poolId: `具名账号${owner}/短剧积分`,
                  revision: 4,
                  availableCredits: "82",
                  reservedCredits: "0",
                  spentCredits: "18",
                  grantedCredits: "100",
                },
              ],
              nextPoolId: null,
            }
          : path.endsWith("/sources")
            ? { sources: [], next: null }
            : path.endsWith("/packages")
              ? { packages: [], next: null }
              : path.endsWith("/selections")
                ? { selections: [], next: null }
                : { plugins: [], next: null };
        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    cleanups.push(async () => {
      await act(async () => root.unmount());
      container.remove();
    });
    const render = (section: SettingsSection) =>
      root.render(
        <ControlSettingsContent
          activeSection={section}
          client={client}
          locale="zh"
          platformUser={{
            id: owner,
            username: `test-user-${owner}`,
            email: "fixture@example.test",
            role: "user",
          }}
          onSectionChange={vi.fn()}
        />,
      );
    await act(async () => {
      render("environment");
    });
    expect(calls).toEqual([]);
    expect(container.querySelector('[aria-label="个人插件积分"]')).toBeNull();
    await act(async () => {
      render("mcp-servers");
    });
    await vi.waitFor(() =>
      expect(
        container.querySelector('[aria-label="个人插件积分"]')?.textContent,
      ).toContain("查看当前账号"),
    );
    expect(
      calls.filter((path) => path.endsWith("/credits/accounts")),
    ).toHaveLength(1);
    expect(calls.some((path) => path.endsWith("/credits/entries"))).toBe(false);
    expect(container.querySelector(".settings-content")).not.toBeNull();
    expect(container.querySelector(".bundled-task-packs")).not.toBeNull();
    expect(
      container.querySelector('[aria-label="选择积分账户"]'),
    ).not.toBeNull();
    owner = 38;
    await act(async () => {
      render("mcp-servers");
    });
    await vi.waitFor(() =>
      expect(
        calls.filter((path) => path.endsWith("/credits/accounts")),
      ).toHaveLength(2),
    );
    expect(container.textContent).not.toContain("具名账号37");
    await act(async () => {
      render("environment");
    });
    expect(container.querySelector('[aria-label="个人插件积分"]')).toBeNull();
    expect(calls.every((path) => path.startsWith("/api/v1/plugins/"))).toBe(
      true,
    );
  });
});
