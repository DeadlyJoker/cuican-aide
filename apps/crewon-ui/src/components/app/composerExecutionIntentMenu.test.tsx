import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ControlOfficeDefinitionRecordReference } from "../../lib/office/officePanelFromRecord";
import {
  Palette,
  firstSelectablePaletteItem,
  paletteSearchKeyAction,
} from "./CommandWorkspacePalette";
import {
  commandPlanDisabledReason,
  composerExecutionIntentMenuItems,
  executionIntentForMenuItem,
  teamPlanDisabledReason,
} from "../composer/composerExecutionIntentMenu";

function office(count: number): ControlOfficeDefinitionRecordReference {
  return {
    authority: "controlDefinition",
    filePath: "office.json",
    config: { title: "Test", subtitle: "" },
    definition: {
      officeId: "office",
      officeVersionId: "office-v1",
      revision: 1,
      members: Array.from({ length: count }, (_, index) => ({
        memberId: `member-${index}`,
        agentVersionId: `agent-${index}`,
        displayName: `Member ${index}`,
      })),
      executionTargets: [],
    },
  };
}

describe("composer intent menu", () => {
  it.each(["zh", "en"] as const)(
    "offers explicit, mutually exclusive %s selections without inserting prompt tokens",
    (locale) => {
      const items = composerExecutionIntentMenuItems({
        locale,
        value: "goal",
        disabled: false,
        planDisabledReason: null,
      });
      expect(items.map((item) => item.active)).toEqual([true, false]);
      expect(items.map(executionIntentForMenuItem)).toEqual(["goal", "plan"]);
      expect(items.every((item) => !item.token && !item.content)).toBe(true);
      expect(executionIntentForMenuItem(items[0])).toBe("goal"); // Selecting again keeps it selected.
      expect(
        executionIntentForMenuItem({
          kind: "file",
          label: "File",
          title: "Goal",
          detail: "",
          action: "attach-files",
        }),
      ).toBeNull();
      const markup = renderToStaticMarkup(
        <Palette
          id="add"
          inputId="search"
          items={items}
          kind="add"
          open
          placeholder="Add"
          query=""
          onClose={() => {}}
          onQueryChange={() => {}}
          onSelect={() => {}}
        />,
      );
      expect(markup).toContain('aria-pressed="true"');
      expect(markup).toMatchSnapshot();
    },
  );
  it("blocks a disabled Plan through pointer and keyboard selection", () => {
    const items = composerExecutionIntentMenuItems({
      locale: "zh",
      value: "none",
      disabled: false,
      planDisabledReason: "多成员团队不支持计划",
    });
    expect(items[1].disabled).toBe(true);
    expect(executionIntentForMenuItem(items[1])).toBeNull();
    expect(firstSelectablePaletteItem([items[1]])).toBeUndefined();
    expect(
      paletteSearchKeyAction(
        "Enter",
        Boolean(firstSelectablePaletteItem([items[1]])),
      ),
    ).toBe("blockSubmit");
    expect(firstSelectablePaletteItem([items[1], items[0]])).toBe(items[0]);
    const markup = renderToStaticMarkup(
      <Palette
        id="add"
        inputId="search"
        items={[items[1]]}
        kind="add"
        open
        placeholder="Add"
        query="计划"
        onClose={() => {}}
        onQueryChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(markup).toContain("disabled");
    expect(markup).toContain("多成员团队不支持计划");
  });
  it("locks mode changes while submitting and preserves the active-goal warning", () => {
    const items = composerExecutionIntentMenuItems({
      locale: "zh",
      value: "plan",
      disabled: true,
      planDisabledReason: null,
      hasActiveGoal: true,
    });
    expect(items.map(executionIntentForMenuItem)).toEqual([null, null]);
    expect(items[1].detail).toContain("清除当前目标");
  });
  it("uses exact team identity and does not assume an unknown team supports Plan", () => {
    const input = {
      authority: "control" as const,
      locale: "zh" as const,
      executionTarget: "team:office-v1",
      offices: [office(1)],
    };
    expect(commandPlanDisabledReason(input)).toBeNull();
    expect(
      commandPlanDisabledReason({ ...input, offices: [office(3)] }),
    ).toContain("多成员");
    expect(commandPlanDisabledReason({ ...input, offices: [] })).toContain(
      "无法确认",
    );
    expect(
      commandPlanDisabledReason({ ...input, offices: [office(1), office(1)] }),
    ).toContain("无法确认");
    expect(
      commandPlanDisabledReason({
        ...input,
        executionTarget: "experts:review",
      }),
    ).toContain("专家团");
    for (const executionTarget of ["crewon", "agent:local"])
      expect(
        commandPlanDisabledReason({ ...input, executionTarget }),
      ).toBeNull();
    expect(
      commandPlanDisabledReason({
        ...input,
        authority: "legacy",
        offices: [office(3)],
      }),
    ).toBeNull();
    expect(
      teamPlanDisabledReason({
        memberCount: 3,
        hasDirectMember: true,
        locale: "zh",
      }),
    ).toBeNull();
    expect(
      teamPlanDisabledReason({ memberCount: 3, locale: "zh" }),
    ).not.toBeNull();
  });
});
