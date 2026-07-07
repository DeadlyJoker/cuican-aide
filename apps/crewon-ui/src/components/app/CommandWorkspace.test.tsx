import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  activateDesignPanelTab,
  applyDesignCardVisibility,
  cleanSlotTitle,
  CommandWorkspace,
  selectCommandHomeSlots,
  setDefaultTeamOfficePreview,
  setActiveFilter,
  syncDesignFilterState,
} from "./CommandWorkspace";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";

function snapshot(): AgentPlatformSnapshot {
  return {
    agents: [
      {
        id: 1,
        name: "Plain Agent",
        model_info: { model_name: "qwen-lite" },
        is_active: true,
      },
      {
        id: 2,
        name: "Delivery Agent",
        description: "Has all bindings.",
        model_info: { model_name: "qwen-plus" },
        knowledge_base_ids: [10],
        skill_ids: [20],
        mcp_servers: ["filesystem"],
        is_active: true,
      },
    ],
    knowledgeBases: [
      {
        id: 10,
        name: "Delivery Knowledge",
        document_count: 3,
        embedding_model: "text-embedding-v2",
      },
    ],
    skills: [
      {
        id: 20,
        name: "Schema 校验",
        description: "Validate schema.",
      },
      {
        id: 21,
        name: "交付检查 Skill",
        description: "Check delivery.",
      },
      {
        id: 22,
        name: "Unused Skill",
      },
    ],
    mcpServers: [
      {
        id: 30,
        name: "filesystem",
        alias: "Filesystem MCP",
        description: "Read files.",
      },
      {
        id: 31,
        name: "http-tools",
        alias: "HTTP Tools",
      },
      {
        id: 32,
        name: "unused",
      },
    ],
    mcpTools: [],
    workflows: [
      {
        id: 40,
        name: "普通流程",
      },
      {
        id: 41,
        name: "Workflow Gate",
        description: "Gate approval.",
      },
    ],
  };
}

describe("selectCommandHomeSlots", () => {
  it("selects real platform resources only for the design palettes", () => {
    const slots = selectCommandHomeSlots(snapshot());

    expect(slots.agent.title).toBe("Delivery Agent");
    expect(slots.model).toBe("qwen-plus");
    expect(slots.workflow.title).toBe("Workflow Gate");
    expect(slots.knowledge.title).toBe("Delivery Knowledge");
    expect(slots.skills.map((item) => item.title)).toEqual([
      "Schema 校验",
      "交付检查 Skill",
    ]);
    expect(slots.mcps.map((item) => item.title)).toEqual([
      "Filesystem MCP",
      "HTTP Tools",
    ]);
  });

  it("cleans low-quality test resource names before placing them in palettes", () => {
    const slots = selectCommandHomeSlots({
      ...snapshot(),
      agents: [
        {
          id: 3,
          name: "测试12333",
          model_info: { model_name: "qwen-plus" },
          is_active: true,
        },
      ],
      skills: [
        { id: 20, name: "测试技能" },
        { id: 21, name: "12345" },
      ],
      mcpServers: [
        { id: 30, name: "test-mcp" },
        { id: 31, name: "filesystem" },
      ],
    });

    expect(slots.agent.title).toBe("产品审阅智能体");
    expect(slots.skills.map((item) => item.title)).toEqual([
      "页面审阅 Skill",
      "交付检查 Skill",
    ]);
    expect(slots.mcps.map((item) => item.title)).toEqual([
      "Filesystem MCP",
      "Screenshot MCP",
    ]);
    expect(cleanSlotTitle("Delivery Agent", "Fallback")).toBe("Delivery Agent");
  });
});

describe("CommandWorkspace", () => {
  afterEach(() => {
    if (typeof document !== "undefined") {
      document.body.classList.remove("modal-open");
    }
  });

  function commandWorkspaceElement() {
    return (
      <CommandWorkspace
        composerValue=""
        connectionState="disconnected"
        cwd="C:\\Users\\admin\\Documents\\crewon"
        isSending={false}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />
    );
  }

  function renderCommandWorkspace() {
    return renderToStaticMarkup(commandWorkspaceElement());
  }

  it("renders the original desktop command shell and clean Chinese copy", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain('class="desktop-window command-window"');
    expect(markup).toContain('class="command-sidebar"');
    expect(markup).toContain('class="command-canvas"');
    expect(markup).toContain('class="shell-view command-home-view active"');
    expect(markup).toContain("\u521b\u5efa\u53ef\u7f16\u6392\u7684 Agent \u5c0f\u961f");
    expect(markup).toContain("\u4f8b\u5982\uff1a\u6574\u7406\u4eca\u5929\u7684\u9879\u76ee\u4e8b\u9879");
    expect(markup).not.toContain("????");
  });

  it("keeps the original sidebar space tree instead of real data names", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain("Agent \u5c0f\u961f\u4ea4\u4ed8\u7a7a\u95f4");
    expect(markup).toContain("\u5c0f\u961f\u521b\u5efa\u8349\u7a3f");
    expect(markup).toContain("Workflow Gate");
    expect(markup).toContain("\u4ea4\u4ed8\u9a8c\u6536\u6e05\u5355");
    expect(markup).toContain("\u529e\u516c\u5ba4\u6743\u9650\u7a7a\u95f4");
    expect(markup).toContain("\u56db\u5c42\u6743\u9650");
    expect(markup).toContain("Channel \u6865\u63a5");
    expect(markup).toContain("Skill/MCP \u80fd\u529b\u7a7a\u95f4");
    expect(markup).toContain("Schema \u6821\u9a8c");
    expect(markup).toContain("\u6c99\u7bb1\u5ba1\u8ba1");
  });

  it("keeps only the original visible composer actions and hidden palette hooks", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain('class="icon-action prompt-action"');
    expect(markup).toContain('aria-label="\u8bed\u97f3\u8f93\u5165"');
    expect(markup).toContain('class="send-button"');
    expect(markup).toContain('data-context-open=""');
    expect(markup).toContain('data-slash-open=""');
    expect(markup).not.toContain('class="icon-action context-trigger"');
    expect(markup).not.toContain('class="icon-action slash-trigger"');
  });

  it("renders shell views for sidebar navigation", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain('data-shell-view="assist"');
    expect(markup).toContain('data-shell-view="projects"');
    expect(markup).toContain('data-shell-view="agents"');
    expect(markup).toContain('data-shell-view="schedule"');
    expect(markup).toContain('data-shell-view="team"');
    expect(markup).toContain('data-run-title-zh="\u77e5\u8bc6\u5e93"');
  });

  it("includes original page-specific content for sidebar targets", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain("\u5df2\u8fde\u63a5\uff1a");
    expect(markup).toContain("Crewon \u52a9\u7406");
    expect(markup).toContain("\u5f53\u524d\u4efb\u52a1");
    expect(markup).toContain("Workflow \u6267\u884c\u961f\u5217");
    expect(markup).toContain("\u6267\u884c\u72b6\u6001\u673a");
    expect(markup).toContain("\u6280\u80fd\u00b7\u8fde\u63a5\u5668");
    expect(markup).toContain("\u8ba1\u5212\u00b7\u63d0\u9192");
    expect(markup).toContain("\u529e\u516c\u5ba4");
  });

  it("includes original schedule modal and filter landmarks", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain('data-shell-view="schedule"');
    expect(markup).toContain('data-filter-group="schedule-mode" data-filter="calendar"');
    expect(markup).toContain('data-filter-group="schedule-source" data-filter="teamflow"');
    expect(markup).toContain('data-od-id="schedule-calendar-team"');
    expect(markup).toContain('data-od-id="schedule-arrangement-catalog"');
    expect(markup).toContain('id="schedule-arrangement-modal"');
    expect(markup).toContain("创建任务安排");
    expect(markup).toContain("小队执行安排");
  });

  it("filters schedule cards like the original design runtime", () => {
    if (typeof document === "undefined") {
      return;
    }
    const scope = document.createElement("section");
    scope.innerHTML = `
      <button class="filter-chip active" data-filter-group="schedule-mode" data-filter="calendar"></button>
      <button class="filter-chip" data-filter-group="schedule-mode" data-filter="arrangement"></button>
      <button class="filter-chip" data-filter-group="schedule-source" data-filter="personal"></button>
      <button class="filter-chip active" data-filter-group="schedule-source" data-filter="teamflow"></button>
      <article data-card-filter="calendar personal" data-card="personal-calendar"></article>
      <article data-card-filter="calendar teamflow" data-card="team-calendar"></article>
      <article data-card-filter="arrangement personal" data-card="personal-arrangement"></article>
      <article data-card-filter="arrangement teamflow" data-card="team-arrangement"></article>
    `;

    syncDesignFilterState(scope);
    expect(scope.querySelector<HTMLElement>('[data-card="team-calendar"]')?.hidden).toBe(false);
    expect(scope.querySelector<HTMLElement>('[data-card="personal-calendar"]')?.hidden).toBe(true);
    expect(scope.querySelector<HTMLElement>('[data-card="personal-arrangement"]')?.hidden).toBe(
      true,
    );
    expect(scope.querySelector<HTMLElement>('[data-card="team-arrangement"]')?.hidden).toBe(true);

    setActiveFilter(scope, "schedule-mode", "arrangement");
    expect(scope.querySelector<HTMLElement>('[data-card="team-calendar"]')?.hidden).toBe(true);
    expect(scope.querySelector<HTMLElement>('[data-card="team-arrangement"]')?.hidden).toBe(false);

    setActiveFilter(scope, "schedule-source", "personal");
    expect(scope.querySelector<HTMLElement>('[data-card="team-arrangement"]')?.hidden).toBe(true);
    expect(scope.querySelector<HTMLElement>('[data-card="personal-arrangement"]')?.hidden).toBe(
      false,
    );
  });

  it("applies catalog search on top of active filters", () => {
    if (typeof document === "undefined") {
      return;
    }
    const scope = document.createElement("section");
    scope.innerHTML = `
      <label class="catalog-search"><input value="Code Review"></label>
      <button class="filter-chip active" data-filter="calendar"></button>
      <article data-card-filter="calendar">Code Review 安排</article>
      <article data-card-filter="calendar">个人周报草稿</article>
    `;

    applyDesignCardVisibility(scope);
    expect(scope.querySelectorAll<HTMLElement>("[data-card-filter]")[0]?.hidden).toBe(false);
    expect(scope.querySelectorAll<HTMLElement>("[data-card-filter]")[1]?.hidden).toBe(true);
  });

  it("resets team page to the original office list state without showing inline rooms", () => {
    if (typeof document === "undefined") {
      return;
    }
    const view = document.createElement("section");
    view.setAttribute("data-shell-view", "team");
    view.innerHTML = `
      <div data-filter-scope>
        <button class="filter-chip active" data-filter-group="team-mode" data-filter="workflow"></button>
        <button class="filter-chip" data-filter-group="team-mode" data-filter="office"></button>
        <section data-card-filter="office" data-office-shell class="team-office-shell is-room-open">
          <div data-office-list hidden></div>
          <section data-office-room></section>
          <aside data-office-drawer="members"></aside>
          <button data-office-drawer-open="members" aria-expanded="true"></button>
        </section>
        <section data-card-filter="workflow" data-workflow-shell class="team-workflow-shell is-room-open">
          <div data-workflow-list hidden></div>
          <section data-workflow-room></section>
          <aside data-workflow-drawer="members"></aside>
          <button data-workflow-drawer-open="members" aria-expanded="true"></button>
        </section>
      </div>
    `;
    view.classList.add("office-room-active", "workflow-room-active");

    setDefaultTeamOfficePreview(view);

    expect(view.querySelector<HTMLElement>("[data-office-list]")?.hidden).toBe(false);
    expect(view.querySelector<HTMLElement>("[data-office-room]")?.hidden).toBe(true);
    expect(view.querySelector<HTMLElement>("[data-workflow-list]")?.hidden).toBe(false);
    expect(view.querySelector<HTMLElement>("[data-workflow-room]")?.hidden).toBe(true);
    expect(view.querySelector<HTMLElement>("[data-office-shell]")?.classList.contains("is-room-open")).toBe(false);
    expect(view.querySelector<HTMLElement>("[data-workflow-shell]")?.classList.contains("is-room-open")).toBe(false);
    expect(view.classList.contains("office-room-active")).toBe(false);
    expect(view.classList.contains("workflow-room-active")).toBe(false);
    expect(view.querySelector<HTMLElement>('[data-office-drawer="members"]')?.hidden).toBe(true);
    expect(view.querySelector<HTMLElement>("[data-office-drawer-open]")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("switches room tab panels like the original design runtime", () => {
    if (typeof document === "undefined") {
      return;
    }
    const scope = document.createElement("section");
    scope.setAttribute("data-tab-scope", "");
    scope.innerHTML = `
      <button data-tab-target="#chat" class="active" aria-selected="true"></button>
      <button data-tab-target="#run" aria-selected="false"></button>
      <button data-tab-target="#memory" aria-selected="false"></button>
      <section id="chat" data-tab-panel></section>
      <section id="run" data-tab-panel hidden></section>
      <section id="memory" data-tab-panel hidden></section>
    `;
    const runTab = scope.querySelector<HTMLButtonElement>('[data-tab-target="#run"]');
    expect(runTab).not.toBeNull();

    if (runTab) {
      activateDesignPanelTab(runTab, scope);
    }

    expect(scope.querySelector<HTMLElement>('[data-tab-target="#chat"]')?.classList.contains("active")).toBe(false);
    expect(scope.querySelector<HTMLElement>('[data-tab-target="#run"]')?.classList.contains("active")).toBe(true);
    expect(scope.querySelector<HTMLElement>('[data-tab-target="#run"]')?.getAttribute("aria-selected")).toBe("true");
    expect(scope.querySelector<HTMLElement>("#chat")?.hidden).toBe(true);
    expect(scope.querySelector<HTMLElement>("#run")?.hidden).toBe(false);
    expect(scope.querySelector<HTMLElement>("#memory")?.hidden).toBe(true);
  });

});
