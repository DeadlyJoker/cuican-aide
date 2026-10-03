// @vitest-environment happy-dom
// @ts-expect-error Vitest reads styles in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
// @ts-expect-error Vitest resolves saved files in Node; the browser omits Node types.
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPlatformAuthGate } from "../auth/AgentPlatformAuthGate";
import { CommandSidebar } from "./CommandWorkspaceChrome";
import type { CommandHomeSlots } from "./commandWorkspaceState";

const { readUser } = vi.hoisted(() => ({ readUser: vi.fn() }));
vi.mock("../../lib/agent-platform/agentPlatformSession", () => ({
  readAgentPlatformCurrentUser: readUser,
  readWeComLoginConfig: async () => ({
    enabled: false,
    provider: "wecom",
    label: "企业微信",
  }),
  beginWeComLogin: vi.fn(),
  completeWeComLogin: vi.fn(),
  loginAgentPlatform: vi.fn(),
  logoutAgentPlatform: vi.fn(),
  registerAgentPlatform: vi.fn(),
  setAgentPlatformPassword: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function resourceSlot(value: string) {
  return { detail: value, label: value, title: value, value };
}

const slots: CommandHomeSlots = {
  agent: { detail: "Agent", label: "Agent", title: "Agent", value: "agent" },
  knowledge: {
    detail: "Knowledge",
    label: "Knowledge",
    title: "Knowledge",
    value: "knowledge",
  },
  mcps: [resourceSlot("MCP 1"), resourceSlot("MCP 2")],
  model: "gpt-5",
  skills: [resourceSlot("Skill 1"), resourceSlot("Skill 2")],
  workflow: {
    detail: "Workflow",
    label: "Workflow",
    title: "Workflow",
    value: "workflow",
  },
};

const styleFiles = ["app.css", "original-shell-overrides.css"] as const;

function baseRuleDeclarations(file: string, selector: string) {
  const source: string = readFileSync(
    new NodeURL(`../../styles/${file}`, import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selectors]) =>
      selectors
        .split(",")
        .some((item) => item.trim().replace(/\s+/gu, " ") === selector),
    )
    .map(([, , body]) => body);
  expect(rules.length, `${file}: ${selector}`).toBeGreaterThan(0);
  // The first rule is the base layout. Later narrow-screen declarations remain
  // conditional and must not be merged into a simulated computed style.
  return Object.fromEntries(
    [...rules[0].matchAll(/([\w-]+)\s*:\s*([^;]+);/gu)].map(
      ([, property, value]) => [property, value.trim()],
    ),
  );
}

let root: Root;
let container: HTMLDivElement;
const onSettings = vi.fn();
const onOpenModule = vi.fn();

beforeEach(() => {
  readUser.mockReset().mockResolvedValue({
    id: 42,
    username: "lin.xiao",
    display_name: "林晓",
    email: "lin@example.com",
    role: "user",
    linked_providers: ["wecom"],
    password_login_enabled: true,
  });
  onSettings.mockClear();
  onOpenModule.mockClear();
  window.history.replaceState(
    null,
    "",
    "/?surface=desktop&platform=mac&os=mac#view-command",
  );
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render(moduleCount: number) {
  const noop = () => undefined;
  await act(async () => {
    root.render(
      <AgentPlatformAuthGate>
        <section className="screen-shell command-screen desktop-command-screen">
          <section
            className="desktop-window command-window"
            style={{ height: 600 }}
          >
            <CommandSidebar
              activeView="command"
              cwd=""
              hostModules={Array.from({ length: moduleCount }, (_, index) => ({
                id: JSON.stringify([`example.plugin.${index}`, "main"]),
                label: `插件 ${index + 1}`,
                active: false,
                onOpen: () => onOpenModule(index),
              }))}
              isSearchOpen={false}
              linkedThreads={[]}
              platform="mac"
              query=""
              selectedLinkedThreadId={null}
              slots={slots}
              workspaceAuthority="control"
              onCloseSearch={noop}
              onNewThread={noop}
              onOpenLinkedThread={noop}
              onOpenSettings={onSettings}
              onQueryChange={noop}
              onSwitchView={noop}
              onToggleCollapse={noop}
              onToggleSearch={noop}
            />
          </section>
        </section>
      </AgentPlatformAuthGate>,
    );
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });
}

describe("command sidebar overflow", () => {
  it.each(styleFiles)(
    "allows only the navigation track to shrink in %s",
    (file) => {
      const selector =
        file === "app.css"
          ? ".screen-shell.command-screen .command-sidebar"
          : ".command-sidebar";
      const sidebar = baseRuleDeclarations(file, selector);
      expect(sidebar.display).toBe("grid");
      expect(sidebar["grid-template-rows"]).toBe(
        "auto minmax(0, auto) minmax(0, 1fr) auto",
      );
      expect(sidebar["grid-template-columns"]).toBeUndefined();

      const nav = baseRuleDeclarations(
        file,
        file === "app.css"
          ? ".screen-shell.command-screen .sidebar-nav"
          : ".sidebar-nav",
      );
      expect(nav).toMatchObject({
        "min-height": "0",
        "overflow-y": "auto",
        "grid-auto-rows": "minmax(28px, auto)",
        "align-content": "start",
        "gap": "2px",
      });
      expect({ sidebar, nav }).toMatchSnapshot();
    },
  );

  it.each([0, 1, 9])(
    "preserves the original account/settings action with %i installed modules",
    async (moduleCount) => {
      await render(moduleCount);
      const sidebar = container.querySelector(".command-sidebar")!;
      const nav = sidebar.querySelector(".sidebar-nav")!;
      const footer = sidebar.querySelector(".sidebar-account")!;
      expect(footer.parentElement).toBe(sidebar);
      expect(sidebar.lastElementChild).toBe(footer);
      expect(nav.contains(footer)).toBe(false);
      expect(nav.querySelectorAll("button")).toHaveLength(7 + moduleCount);
      expect(nav.querySelectorAll("[data-host-module-target]")).toHaveLength(
        moduleCount,
      );
      const summary = footer.querySelector("summary")!;
      expect(summary.getAttribute("aria-label")).toBe("账号菜单：林晓");
      const menu = footer.querySelector("details")!;
      const actions = [...menu.querySelectorAll<HTMLButtonElement>("button")];
      expect(actions.map((action) => action.textContent)).toEqual([
        "设置",
        "退出登录",
      ]);
      expect({
        navigation: [...nav.querySelectorAll("button")].map(
          (button) => button.querySelector("strong")?.textContent,
        ),
        account: summary.textContent,
        actions: actions.map((action) => action.textContent),
        footerClass: footer.className,
      }).toMatchSnapshot();

      // Happy DOM verifies structure and actions; it does not measure clipping.
      menu.open = true;
      await act(async () => actions[0].click());
      expect(onSettings).toHaveBeenCalledOnce();
      expect(menu.open).toBe(false);
      if (moduleCount) {
        await act(async () =>
          nav
            .querySelectorAll<HTMLButtonElement>("[data-host-module-target]")
            .item(moduleCount - 1)
            .click(),
        );
        expect(onOpenModule).toHaveBeenCalledExactlyOnceWith(moduleCount - 1);
        expect(sidebar.querySelector(".sidebar-account")).toBe(footer);
      }
    },
  );
});
