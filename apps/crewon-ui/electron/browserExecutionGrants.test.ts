import { describe, expect, it } from "vitest";
import type { BrowserActInput } from "@crewon/contracts";
import type { BrowserGrantScope } from "../src/lib/browser-execution/browserExecutionGrant.ts";
import {
  assertBrowserGrantAllows,
  parseBrowserGrantScope,
  type BrowserRunIdentity,
} from "./browserExecutionGrants.ts";

const ref = {
  skillId: "report-skill",
  versionId: "version-1",
  contentDigest: `sha256:${"a".repeat(64)}`,
};
const origin = "https://reports.example.com";
const target = { role: "textbox", name: "报表日期" };
const locator = {
  sessionId: "session-1",
  observationId: "observation-1",
  generation: 1,
};
function identity(date = "2026-09-14"): BrowserRunIdentity {
  return {
    runId: "run-1",
    threadId: "thread-1",
    active: true,
    workspaceBindingId: "workspace-1",
    skill: { ref, parameters: { date } },
  };
}
function scope(): BrowserGrantScope {
  return {
    skillVersionRef: ref,
    origins: [origin],
    rules: [
      { action: "navigate", urlTemplate: `${origin}/export?date={date}` },
      { action: "fill", target, value: { parameter: "date" } },
      {
        action: "select",
        target: { role: "combobox", name: "部门" },
        value: { literal: "销售" },
      },
      { action: "download", target: { role: "button", name: "导出 CSV" } },
    ],
  };
}
const fill = (value: string): BrowserActInput => ({
  ...locator,
  action: "fill",
  target: { targetId: "target-1" },
  value,
});

describe("browser scoped task grants", () => {
  it("matches a named native date control without inventing an ARIA role", () => {
    const dateTarget = { role: "", name: "日期" };
    const grant = parseBrowserGrantScope({
      skillVersionRef: ref,
      origins: [origin],
      rules: [
        { action: "fill", target: dateTarget, value: { parameter: "date" } },
      ],
    });
    expect(() =>
      assertBrowserGrantAllows(
        grant,
        identity(),
        fill("2026-09-14"),
        origin,
        dateTarget,
        origin,
      ),
    ).not.toThrow();
    for (const other of [
      { role: "textbox", name: "日期" },
      { role: "", name: "其他日期" },
    ])
      expect(() =>
        assertBrowserGrantAllows(
          grant,
          identity(),
          fill("2026-09-14"),
          origin,
          other,
          origin,
        ),
      ).toThrow("requires_explicit_approval");
    expect(() =>
      parseBrowserGrantScope({
        ...grant,
        rules: [
          {
            action: "fill",
            target: { role: "", name: "" },
            value: { parameter: "date" },
          },
        ],
      }),
    ).toThrow();
  });
  it("retains an immutable copy of the reviewed scope", () => {
    const proposed = scope();
    const parsed = parseBrowserGrantScope(proposed);
    proposed.rules[1]!.value = { literal: "different date" };
    proposed.origins.push("https://other.example.com");
    expect(parsed).toEqual(scope());
  });

  it.each(["skillId", "versionId", "contentDigest"] as const)(
    "rejects a different trusted Skill %s",
    (key) => {
      const run = identity();
      run.skill = {
        ref: { ...ref, [key]: "different" },
        parameters: { date: "2026-09-14" },
      };
      expect(() =>
        assertBrowserGrantAllows(
          scope(),
          run,
          fill("2026-09-14"),
          origin,
          target,
          origin,
        ),
      ).toThrow("requires_explicit_approval");
    },
  );

  it("requires a trusted Skill identity even when the target and values match", () => {
    expect(() =>
      assertBrowserGrantAllows(
        scope(),
        { ...identity(), skill: null },
        fill("2026-09-14"),
        origin,
        target,
        origin,
      ),
    ).toThrow("requires_explicit_approval");
  });

  it.each(["2026-09-14", "2026-09-15"])(
    "resolves parameters separately for each trusted periodic Run on %s",
    (date) => {
      const run = identity(date);
      expect(() =>
        assertBrowserGrantAllows(
          scope(),
          run,
          fill(date),
          origin,
          target,
          origin,
        ),
      ).not.toThrow();
      const wrongDate = date === "2026-09-14" ? "2026-09-15" : "2026-09-14";
      expect(() =>
        assertBrowserGrantAllows(
          scope(),
          run,
          fill(wrongDate),
          origin,
          target,
          origin,
        ),
      ).toThrow("requires_explicit_approval");
      expect(() =>
        assertBrowserGrantAllows(
          scope(),
          run,
          {
            ...locator,
            action: "navigate",
            url: `${origin}/export?date=${date}`,
          },
          origin,
          null,
          origin,
        ),
      ).not.toThrow();
      expect(() =>
        assertBrowserGrantAllows(
          scope(),
          run,
          {
            ...locator,
            action: "navigate",
            url: `${origin}/export?date=${wrongDate}`,
          },
          origin,
          null,
          origin,
        ),
      ).toThrow("requires_explicit_approval");
    },
  );

  it("requires exact current origin, target semantics and literal values", () => {
    const input: BrowserActInput = {
      ...locator,
      action: "select",
      target: { targetId: "department" },
      value: "销售",
    };
    const selected = { role: "combobox", name: "部门" };
    expect(() =>
      assertBrowserGrantAllows(
        scope(),
        identity(),
        input,
        origin,
        selected,
        origin,
      ),
    ).not.toThrow();
    for (const [url, semantic, value] of [
      ["https://reports.example.com.attacker.test", selected, "销售"],
      ["https://other.example.com", selected, "销售"],
      [origin, { ...selected, name: "收款账户" }, "销售"],
      [origin, { ...selected, role: "textbox" }, "销售"],
      [origin, null, "销售"],
      [origin, selected, "所有部门"],
    ] as const) {
      expect(() =>
        assertBrowserGrantAllows(
          scope(),
          identity(),
          { ...input, value },
          url,
          semantic,
          origin,
        ),
      ).toThrow("requires_explicit_approval");
    }
  });

  it("encodes URL parameters so runtime values cannot add query arguments or change origins", () => {
    const date = "2026-09-14&action=delete";
    const run = identity(date);
    const url = `${origin}/export?date=${encodeURIComponent(date)}`;
    expect(() =>
      assertBrowserGrantAllows(
        scope(),
        run,
        { ...locator, action: "navigate", url },
        origin,
        null,
        origin,
      ),
    ).not.toThrow();
    expect(() =>
      assertBrowserGrantAllows(
        scope(),
        run,
        {
          ...locator,
          action: "navigate",
          url: `${origin}/export?date=${date}`,
        },
        origin,
        null,
        origin,
      ),
    ).toThrow("requires_explicit_approval");
  });

  it("rejects a matching control on a different same-origin page, while allowing the reviewed parameterized page", () => {
    const input = fill("2026-09-14");
    const authorizedPage = `${origin}/dashboard`;
    expect(() =>
      assertBrowserGrantAllows(
        scope(),
        identity(),
        input,
        `${origin}/admin`,
        target,
        authorizedPage,
      ),
    ).toThrow("requires_explicit_approval");
    expect(() =>
      assertBrowserGrantAllows(
        scope(),
        identity(),
        input,
        authorizedPage,
        target,
        authorizedPage,
      ),
    ).not.toThrow();
    expect(() =>
      assertBrowserGrantAllows(
        scope(),
        identity(),
        input,
        `${origin}/export?date=2026-09-14`,
        target,
        authorizedPage,
      ),
    ).not.toThrow();
    expect(() =>
      assertBrowserGrantAllows(
        scope(),
        identity(),
        input,
        `${origin}/export?date=2026-09-15`,
        target,
        authorizedPage,
      ),
    ).toThrow("requires_explicit_approval");
  });

  it.each([undefined, null, {}, [], "x".repeat(513)])(
    "rejects missing, structured or oversized runtime parameter %j",
    (date) => {
      const run = identity();
      run.skill!.parameters = { date };
      expect(() =>
        assertBrowserGrantAllows(
          scope(),
          run,
          fill("anything"),
          origin,
          target,
          origin,
        ),
      ).toThrow("requires_explicit_approval");
    },
  );

  it("rejects unreviewed actions and malformed or broader scope declarations", () => {
    expect(() =>
      assertBrowserGrantAllows(
        scope(),
        identity(),
        { ...locator, action: "click", target: { targetId: "target-1" } },
        origin,
        { role: "button", name: "导出 CSV" },
        origin,
      ),
    ).toThrow("requires_explicit_approval");
    for (const proposed of [
      { ...scope(), origins: [] },
      { ...scope(), origins: ["https://reports.example.com/"] },
      { ...scope(), origins: ["https://user:secret@reports.example.com"] },
      { ...scope(), rules: [] },
      {
        ...scope(),
        rules: [
          {
            action: "navigate",
            urlTemplate: "https://other.example.com/export",
          },
        ],
      },
      {
        ...scope(),
        rules: [{ action: "click", target, value: { literal: "ignored" } }],
      },
      { ...scope(), rules: [{ action: "fill", target }] },
      { ...scope(), extra: "capability" },
    ]) {
      expect(() =>
        parseBrowserGrantScope(proposed as BrowserGrantScope),
      ).toThrow("requires_explicit_approval");
    }
  });
});
