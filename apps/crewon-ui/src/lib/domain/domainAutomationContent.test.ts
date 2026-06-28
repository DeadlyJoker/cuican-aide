import { describe, expect, it } from "vitest";

import type { AgentConfig, LibraryPanel, OfficeConfig } from "./crewonDomain";
import {
  automationConfigForCreate,
  automationRunPanelBody,
  automationRunUpdatedActions,
  automationTurnStartPrompt,
  automationBindingSubtitle,
  automationBodyText,
  automationConfigForRun,
  automationCreateFailureMessage,
  automationCreateFailureNotice,
  automationCreateFailurePanel,
  automationCreateFieldValues,
  automationCreateRequiresBindingsNotice,
  automationCreateRequiresBindingsPanel,
  automationCreateSelectionPanelContent,
  automationCreateSelectionPanel,
  automationCreateSuccessPanelContent,
  automationCreateSuccessPanel,
  automationCreateTitle,
  automationCreateTurnPrompt,
  automationRunLifecycleText,
  automationRunErrorNotice,
  automationRunErrorPanel,
  automationRunNoteFromFields,
  automationRunPrompt,
  prepareAutomationRun,
  automationRunUpdatedPanel,
} from "./domainAutomationContent";

const office: OfficeConfig = {
  title: "Demo Office",
  subtitle: "Backend office",
  workspace: {
    goal: "Ship the demo",
    members: [],
    messages: [],
    tasks: [],
  },
};

const agent: AgentConfig = {
  name: "Planner",
  role: "Plan work",
  model: "gpt-5.4",
  models: ["gpt-5.4"],
  permission: "workspace",
  permissions: ["workspace"],
  glyph: "◇",
  accent: "blue",
  systemPrompt: "Plan carefully.",
  mcp: [
    {
      id: "git",
      name: "Git",
      glyph: "⌁",
      accent: "green",
      description: "Git tools",
      enabled: true,
    },
    {
      id: "db",
      name: "Database",
      glyph: "▣",
      accent: "violet",
      description: "DB tools",
      enabled: false,
    },
  ],
  skills: [
    {
      id: "review",
      name: "Review",
      glyph: "✓",
      accent: "cyan",
      description: "Review skill",
      enabled: true,
    },
  ],
};

function automationPanel(): LibraryPanel {
  return {
    kind: "automation",
    title: "Automations",
    subtitle: "Library",
    items: [{ title: "Existing", meta: "old" }],
  };
}

describe("automation content helpers", () => {
  it("builds binding subtitles in both locales", () => {
    expect(
      automationBindingSubtitle({
        targetOffice: office,
        executionAgent: agent,
        locale: "zh",
        includeTrigger: true,
      }),
    ).toBe("手动触发 · Demo Office · Planner");
    expect(
      automationBindingSubtitle({
        targetOffice: null,
        executionAgent: null,
        locale: "en",
      }),
    ).toBe("No office · No agent");
  });

  it("summarizes enabled capabilities in automation body text", () => {
    const body = automationBodyText({
      title: "Nightly check",
      targetOffice: office,
      executionAgent: agent,
      triggerType: "manual",
      locale: "en",
    });

    expect(body).toContain("Trigger: manual");
    expect(body).toContain("Target office: Demo Office");
    expect(body).toContain("MCP: Git");
    expect(body).toContain("Skills: Review");
    expect(body).not.toContain("Database");
  });

  it("handles minimal backend agents without capability arrays", () => {
    const body = automationBodyText({
      title: "Nightly check",
      targetOffice: office,
      executionAgent: {
        agentId: "agent-1",
        name: "Backend Agent",
      } as AgentConfig,
      triggerType: "manual",
      locale: "en",
    });

    expect(body).toContain("Agent: Backend Agent");
    expect(body).toContain("MCP: not configured");
    expect(body).toContain("Skills: not configured");
  });

  it("formats run prompts and lifecycle text", () => {
    expect(
      automationRunPrompt({
        title: "Nightly check",
        targetOffice: office,
        executionAgent: agent,
        locale: "en",
        immediate: true,
      }),
    ).toContain('Run automation "Nightly check" now.');

    expect(
      automationRunLifecycleText({
        threadId: "thread-1",
        runId: "run-1",
        runFilePath: "/repo/.crewon/runs/run-1.json",
        configPath: "/repo/.crewon/automation/config.json",
        locale: "en",
        phase: "started",
      }),
    ).toEqual([
      "Execution: turn/start sent to thread thread-1",
      "Run record: automation/run created run-1",
      "Status sync: waiting for turn/completed before automation/run/update",
      "Run file: /repo/.crewon/runs/run-1.json",
      "Backend record: /repo/.crewon/automation/config.json",
    ]);
  });

  it("builds automation create titles and reads draft fields", () => {
    expect(automationCreateTitle("14:30", "en")).toBe("Automation 14:30");
    expect(automationCreateTitle("14:30", "zh")).toBe("自动化 14:30");
    expect(
      automationCreateFieldValues({
        defaultTitle: "Automation 14:30",
        fields: [
          { id: "automation-title", label: "Name", value: " Nightly check " },
          {
            id: "automation-office",
            label: "Office",
            value: " /repo/.crewon/offices/demo.json ",
          },
          {
            id: "automation-agent",
            label: "Agent",
            value: "/repo/.crewon/agents/planner.json",
          },
          { id: "automation-trigger", label: "Trigger", value: "" },
          { id: "automation-prompt", label: "Prompt", value: " Run it " },
        ],
      }),
    ).toEqual({
      title: "Nightly check",
      selectedOfficePath: "/repo/.crewon/offices/demo.json",
      selectedAgentPath: "/repo/.crewon/agents/planner.json",
      selectedTrigger: "manual",
      selectedPrompt: "Run it",
    });
    expect(
      automationCreateFieldValues({
        defaultTitle: "Automation 14:30",
        fields: null,
      }),
    ).toEqual({
      title: "Automation 14:30",
      selectedOfficePath: "",
      selectedAgentPath: "",
      selectedTrigger: "manual",
      selectedPrompt: "",
    });
  });

  it("builds automation create missing binding feedback", () => {
    expect(automationCreateRequiresBindingsNotice("en")).toEqual({
      text: "Creating an automation requires a saved office and backend agent. Create an office and create/save an agent first.",
      tone: "warning",
    });
    expect(automationCreateRequiresBindingsPanel(automationPanel(), "zh")).toEqual({
      ...automationPanel(),
      error:
        "创建自动化需要已保存的办公室和后端智能体。请先创建办公室，并在智能体库中新建/保存智能体。",
    });
    expect(automationCreateRequiresBindingsPanel(null, "en")).toBeNull();
  });

  it("builds automation create selection panel content", () => {
    expect(
      automationCreateSelectionPanelContent({
        officeRecords: [
          {
            filePath: "/repo/.crewon/offices/demo.json",
            config: office,
          },
        ],
        agentRecords: [
          {
            filePath: "/repo/.crewon/agents/planner.json",
            config: { ...agent, agentId: "agent-1" },
          },
        ],
        title: "Nightly check",
        locale: "en",
      }),
    ).toMatchObject({
      title: "New automation",
      subtitle: "1 offices · 1 agents",
      fields: [
        {
          id: "automation-title",
          value: "Nightly check",
        },
        {
          id: "automation-trigger",
          value: "manual",
        },
        {
          id: "automation-office",
          value: "/repo/.crewon/offices/demo.json",
          options: [
            {
              label: "Demo Office",
              value: "/repo/.crewon/offices/demo.json",
            },
          ],
        },
        {
          id: "automation-agent",
          value: "/repo/.crewon/agents/planner.json",
          options: [
            {
              label: "Planner",
              value: "/repo/.crewon/agents/planner.json",
            },
          ],
        },
        {
          id: "automation-prompt",
          value:
            'Run automation "Nightly check". Target office: Demo Office. Agent: Planner. Record results, next tasks, and risks.',
        },
      ],
      actions: [
        {
          id: "create-automation",
          label: "Save automation",
          tone: "primary",
        },
      ],
      items: [],
      error: undefined,
    });
    expect(
      automationCreateSelectionPanel(automationPanel(), {
        officeRecords: [
          {
            filePath: "/repo/.crewon/offices/demo.json",
            config: office,
          },
        ],
        agentRecords: [
          {
            filePath: "/repo/.crewon/agents/planner.json",
            config: { ...agent, agentId: "agent-1" },
          },
        ],
        title: "Nightly check",
        locale: "en",
      }),
    ).toMatchObject({
      title: "New automation",
      subtitle: "1 offices · 1 agents",
      error: undefined,
    });
  });

  it("builds automation create config and turn prompt", () => {
    const config = automationConfigForCreate({
      title: "Nightly check",
      threadId: "thread-1",
      targetOffice: office,
      executionAgent: { ...agent, agentId: "agent-1" },
      prompt: "",
      selectedTrigger: "schedule",
      locale: "zh",
    });

    expect(config).toMatchObject({
      title: "Nightly check",
      threadId: "thread-1",
      subtitle: "手动触发 · Demo Office · Planner",
      trigger: { type: "schedule" },
      enabled: true,
      status: "enabled",
      targetOffice: office,
      executionAgent: { ...agent, agentId: "agent-1" },
    });
    expect(config.body).toContain("触发器：定时");
    expect(config.prompt).toContain("运行自动化「Nightly check」");

    expect(
      automationCreateTurnPrompt({
        title: "Nightly check",
        configPath: "/repo/.crewon/automations/nightly.json",
        targetOffice: office,
        executionAgent: { ...agent, agentId: "agent-1" },
        prompt: "Run saved prompt",
        locale: "en",
      }),
    ).toBe(
      [
        "Create automation: Nightly check",
        "Backend record: /repo/.crewon/automations/nightly.json",
        "Target office: Demo Office",
        "Execution agent: Planner",
        "",
        "Run saved prompt",
      ].join("\n"),
    );
  });

  it("builds automation create success panel content", () => {
    const config = automationConfigForCreate({
      title: "Nightly check",
      threadId: "thread-1",
      targetOffice: office,
      executionAgent: { ...agent, agentId: "agent-1" },
      prompt: "Run saved prompt",
      selectedTrigger: "manual",
      locale: "en",
    });

    expect(
      automationCreateSuccessPanelContent({
        config,
        configPath: "/repo/.crewon/automations/nightly.json",
        currentItems: [
          {
            title: "Existing",
            meta: "old",
          },
        ],
        locale: "en",
        threadId: "thread-1",
      }),
    ).toEqual({
      body: "Created backend automation: Nightly check\nBound to: Demo Office · Planner\nBackend record: /repo/.crewon/automations/nightly.json",
      items: [
        {
          title: "Nightly check",
          meta: "automation/create · ready to run",
          description:
            "Target office, execution agent, and run prompt are written; it can run now and keep records.",
          glyph: "⏱",
          accent: "blue",
          badge: {
            label: "created",
            tone: "running",
          },
          action: {
            type: "automation-detail",
            title: "Nightly check",
            subtitle: "Manual trigger · Demo Office · Planner",
            body: config.body,
            prompt: "Run saved prompt",
            threadId: "thread-1",
            configPath: "/repo/.crewon/automations/nightly.json",
          },
        },
        {
          title: "Existing",
          meta: "old",
        },
      ],
      error: undefined,
    });
    expect(
      automationCreateSuccessPanel(automationPanel(), {
        config,
        configPath: "/repo/.crewon/automations/nightly.json",
        locale: "en",
        threadId: "thread-1",
      })?.items,
    ).toEqual([
      {
        title: "Nightly check",
        meta: "automation/create · ready to run",
        description:
          "Target office, execution agent, and run prompt are written; it can run now and keep records.",
        glyph: "⏱",
        accent: "blue",
        badge: {
          label: "created",
          tone: "running",
        },
        action: {
          type: "automation-detail",
          title: "Nightly check",
          subtitle: "Manual trigger · Demo Office · Planner",
          body: config.body,
          prompt: "Run saved prompt",
          threadId: "thread-1",
          configPath: "/repo/.crewon/automations/nightly.json",
        },
      },
      {
        title: "Existing",
        meta: "old",
      },
    ]);
    expect(automationCreateSuccessPanel(null, {
      config,
      configPath: null,
      locale: "en",
      threadId: "thread-1",
    })).toBeNull();
    expect(automationCreateFailureMessage(null, "en")).toBe(
      "Unable to create automation",
    );
    expect(automationCreateFailureNotice(new Error("offline"), "zh")).toEqual({
      text: "offline",
      tone: "warning",
    });
    expect(automationCreateFailurePanel(automationPanel(), null, "zh")).toEqual({
      ...automationPanel(),
      error: "创建自动化失败",
    });
  });

  it("preserves base config fields while binding runtime values", () => {
    const config = automationConfigForRun({
      baseConfig: {
        title: "Old",
        subtitle: "Keep subtitle",
        body: "Keep body",
        prompt: "Old prompt",
        trigger: { type: "schedule", cron: "0 9 * * *" },
      },
      title: "Nightly check",
      threadId: "thread-1",
      targetOffice: office,
      executionAgent: agent,
      prompt: "Run now",
      body: "New body",
      locale: "en",
    });

    expect(config).toMatchObject({
      title: "Nightly check",
      threadId: "thread-1",
      subtitle: "Keep subtitle",
      body: "Keep body",
      prompt: "Run now",
      trigger: { type: "schedule", cron: "0 9 * * *" },
      targetOffice: office,
      executionAgent: agent,
    });
  });

  it("prepares automation runs from action and latest bindings", () => {
    expect(
      automationRunNoteFromFields([
        {
          id: "automation-run-note",
          label: "Run note",
          value: " Focus auth ",
        },
      ]),
    ).toBe("Focus auth");
    expect(automationRunNoteFromFields(null)).toBe("");
    expect(
      prepareAutomationRun({
        action: { automationTitle: "Nightly check" },
        latestAgent: agent,
        latestOffice: office,
        locale: "en",
        runNote: "",
      }),
    ).toEqual({
      type: "error",
      message:
        "Running an automation requires a saved target office and backend agent. Create an office and create/save an agent first.",
    });

    const prepared = prepareAutomationRun({
      action: {
        automationPrompt: "Existing prompt",
        automationThreadId: "thread-1",
        automationTitle: "Nightly check",
      },
      latestAgent: { ...agent, agentId: "agent-1" },
      latestOffice: office,
      locale: "en",
      runNote: "Focus auth",
    });

    expect(prepared).toMatchObject({
      type: "ok",
      initialThreadId: "thread-1",
      title: "Nightly check",
      targetOffice: office,
      executionAgent: { ...agent, agentId: "agent-1" },
    });
    expect(prepared.type === "ok" ? prepared.prompt : "").toContain(
      "Run note: Focus auth",
    );
    expect(automationRunErrorPanel(automationPanel(), "missing binding")).toEqual({
      ...automationPanel(),
      error: "missing binding",
    });
    expect(automationRunErrorPanel(null, "missing binding")).toBeNull();
    expect(automationRunErrorNotice("missing binding")).toEqual({
      text: "missing binding",
      tone: "warning",
    });
  });

  it("formats automation turn prompts and panel updates", () => {
    const automationConfig = automationConfigForRun({
      baseConfig: null,
      title: "Nightly check",
      threadId: "thread-1",
      targetOffice: office,
      executionAgent: { ...agent, agentId: "agent-1" },
      prompt: "Run now",
      body: "Body",
      locale: "en",
    });

    expect(
      automationTurnStartPrompt({
        automationConfig,
        configPath: "/repo/.crewon/automation/config.json",
        locale: "en",
        runNote: "Focus auth",
        threadId: "thread-1",
      }),
    ).toBe(
      [
        "Run now",
        "Backend record: /repo/.crewon/automation/config.json",
        "Run note: Focus auth",
        "Execution thread: thread-1",
      ].join("\n"),
    );

    expect(
      automationRunPanelBody({
        automationConfig,
        configPath: "/repo/.crewon/automation/config.json",
        locale: "en",
        phase: "completed",
        runFilePath: "/repo/.crewon/runs/run-1.json",
        runId: "run-1",
        threadId: "thread-1",
        warning: "minor warning",
      }),
    ).toContain("Status sync: automation/run/update submitted the completed status");

    expect(
      automationRunUpdatedActions({
        actions: [
          {
            id: "run-automation",
            label: "Run now",
            automationTitle: "Nightly check",
          },
        ],
        automationConfig,
        configPath: "/repo/.crewon/automation/config.json",
        locale: "en",
        threadId: "thread-1",
      }),
    ).toEqual([
      {
        id: "run-automation",
        label: "Run again",
        automationTitle: "Nightly check",
        automationConfig,
        automationConfigPath: "/repo/.crewon/automation/config.json",
        automationThreadId: "thread-1",
      },
      {
        id: "open-path",
        label: "Open backend record",
        pathToOpen: "/repo/.crewon/automation/config.json",
        pathKind: "file",
      },
      {
        id: "delete-config-file",
        label: "Delete backend record",
        pathToOpen: "/repo/.crewon/automation/config.json",
        pathKind: "file",
        domainConfigKind: "automation",
        tone: "danger",
      },
    ]);
    expect(
      automationRunUpdatedPanel(automationPanel(), {
        automationConfig,
        configPath: "/repo/.crewon/automation/config.json",
        fallbackItems: [{ title: "Run 1", meta: "completed" }],
        locale: "en",
        phase: "started",
        runFilePath: "/repo/.crewon/runs/run-1.json",
        runId: "run-1",
        threadId: "thread-1",
        warning: "minor warning",
      }),
    ).toMatchObject({
      subtitle: "Written to backend execution thread",
      items: [{ title: "Run 1", meta: "completed" }],
      error: "minor warning",
    });
    expect(automationRunUpdatedPanel(null, {
      automationConfig,
      configPath: null,
      fallbackItems: undefined,
      locale: "en",
      phase: "started",
      threadId: "thread-1",
    })).toBeNull();
  });
});
