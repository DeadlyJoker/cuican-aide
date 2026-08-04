import { assert, describe, expect, it } from "vitest";

import { composerSelectSections } from "./composerSelectSections";

import type { CommandComposerSelectOption } from "./CommandComposer";

const GROUPS = [
  { id: "single", label: "单智能体" },
  { id: "experts", label: "专家团" },
];

function option(
  value: string,
  group?: string,
): CommandComposerSelectOption<string> {
  return group === undefined
    ? { label: value, value }
    : { group, label: value, value };
}

describe("composerSelectSections", () => {
  it("keeps an ungrouped option above every labelled section", () => {
    const sections = composerSelectSections(
      [
        option("experts-a", "experts"),
        option("crewon"),
        option("agent-a", "single"),
      ],
      GROUPS,
    );

    expect(sections).toEqual([
      { id: "ungrouped", label: null, options: [option("crewon")] },
      {
        id: "single",
        label: "单智能体",
        options: [option("agent-a", "single")],
      },
      {
        id: "experts",
        label: "专家团",
        options: [option("experts-a", "experts")],
      },
    ]);
  });

  it("orders sections by the declaration, not by the options", () => {
    const sections = composerSelectSections(
      [option("experts-a", "experts"), option("agent-a", "single")],
      GROUPS,
    );

    expect(sections.map((section) => section.id)).toEqual([
      "single",
      "experts",
    ]);
  });

  it("preserves the option order inside a section", () => {
    const sections = composerSelectSections(
      [
        option("agent-b", "single"),
        option("agent-a", "single"),
        option("agent-c", "single"),
      ],
      GROUPS,
    );

    expect(sections[0]?.options.map((entry) => entry.value)).toEqual([
      "agent-b",
      "agent-a",
      "agent-c",
    ]);
  });

  it("drops a declared group that has no options", () => {
    const sections = composerSelectSections(
      [option("crewon"), option("agent-a", "single")],
      GROUPS,
    );

    expect(sections.map((section) => section.id)).toEqual([
      "ungrouped",
      "single",
    ]);
  });

  it("renders one unlabelled section when no groups are declared", () => {
    const options = [option("a"), option("b")];

    expect(composerSelectSections(options, [])).toEqual([
      { id: "ungrouped", label: null, options },
    ]);
  });

  it("still shows options carrying an undeclared group", () => {
    // A new group must not silently vanish from the menu.
    const sections = composerSelectSections(
      [option("crewon"), option("x", "workflow")],
      GROUPS,
    );

    expect(sections).toEqual([
      { id: "ungrouped", label: null, options: [option("crewon")] },
      {
        id: "workflow",
        label: "workflow",
        options: [option("x", "workflow")],
      },
    ]);
  });

  it("lists every option exactly once", () => {
    const options = [
      option("crewon"),
      option("agent-a", "single"),
      option("agent-b", "single"),
      option("experts-a", "experts"),
      option("stray", "unknown"),
    ];

    const flattened = composerSelectSections(options, GROUPS).flatMap(
      (section) => section.options,
    );

    expect(flattened).toHaveLength(options.length);
    expect(new Set(flattened.map((entry) => entry.value)).size).toBe(
      options.length,
    );
    for (const entry of options) {
      assert(flattened.includes(entry));
    }
  });
});
