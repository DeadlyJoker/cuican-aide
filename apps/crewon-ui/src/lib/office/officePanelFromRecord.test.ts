import { describe, expect, it } from "vitest";

import type { OfficeRuntimeRecordReference } from "./officePanelFromRecord";
import {
  officePanelFromRecord,
  officePanelMatchesRecord,
  officeRecordKey,
} from "./officePanelFromRecord";

function record(
  filePath: string,
  overrides: Partial<OfficeRuntimeRecordReference["config"]["workspace"]> = {},
): OfficeRuntimeRecordReference {
  return {
    filePath,
    config: {
      title: "Duplicate title",
      subtitle: "Office",
      workspace: {
        goal: "Ship safely",
        members: [],
        messages: [],
        tasks: [],
        ...overrides,
      },
    },
  };
}

describe("officePanelFromRecord", () => {
  it("uses record id before path and never falls back to a duplicate title", () => {
    expect(
      officeRecordKey(record("/repo/a.json", { recordId: "record-a" })),
    ).toBe("record:record-a");
    expect(officeRecordKey(record("/repo/b.json"))).toBe("path:/repo/b.json");
    expect(officeRecordKey(record("", { threadId: "thread-c" }))).toBe(
      "thread:thread-c",
    );
    expect(
      officeRecordKey({
        ...record("/repo/a.json"),
        workspaceCwd: "/repo/team",
      }),
    ).toBe("workspace:/repo/team|path:/repo/a.json");
  });

  it("builds an exact panel identity from the selected config record", () => {
    const selected = { ...record("/repo/a.json"), workspaceCwd: "/repo/team" };
    const duplicateTitle = record("/repo/b.json");
    const panel = officePanelFromRecord(selected, "zh");

    expect(panel).toMatchObject({
      kind: "office",
      title: "Duplicate title",
      configPath: "/repo/a.json",
      workspaceCwd: "/repo/team",
      workspace: { goal: "Ship safely" },
    });
    expect(officePanelMatchesRecord(panel, selected)).toBe(true);
    expect(officePanelMatchesRecord(panel, duplicateTitle)).toBe(false);
    expect(
      officePanelMatchesRecord(panel, {
        ...selected,
        workspaceCwd: "/repo/another-team",
      }),
    ).toBe(false);
  });
});
