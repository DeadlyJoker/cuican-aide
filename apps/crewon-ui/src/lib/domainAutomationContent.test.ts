import { describe, expect, it } from "vitest";

import type { AgentConfig, OfficeConfig } from "./crewonDomain";
import {
  automationBindingSubtitle,
  automationBodyText,
  automationConfigForRun,
  automationRunLifecycleText,
  automationRunPrompt,
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
});
