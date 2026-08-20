import { describe, expect, it } from "vitest";

import {
  officeRecordKey,
  type OfficeRuntimeRecordReference,
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

describe("officeRecordKey", () => {
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
});
