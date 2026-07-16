import { describe, expect, it } from "vitest";

import type { LibraryPanel } from "../domain/crewonDomain";
import {
  officeIdentityFromPanel,
  officeIdentitySnapshotFromPanel,
  officeIdentitySnapshotsMatch,
  officePanelMatchesIdentity,
  officeResponseMatchesIdentity,
} from "./officeIdentity";

function panel(params: {
  configPath?: string;
  recordId?: string;
  threadId?: string;
  workspaceCwd?: string;
}): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Workspace",
    configPath: params.configPath,
    workspaceCwd: params.workspaceCwd,
    items: [],
    workspace: {
      goal: "Ship",
      members: [],
      messages: [],
      tasks: [],
      recordId: params.recordId,
      threadId: params.threadId,
    },
  };
}

describe("Office identity", () => {
  it("prefers record id and fails closed without a stable identity", () => {
    expect(
      officeIdentityFromPanel(
        panel({
          configPath: "/repo/office.json",
          recordId: "record-1",
          threadId: "thread-1",
        }),
      ),
    ).toEqual({ kind: "recordId", value: "record-1" });
    expect(officeIdentityFromPanel(panel({}))).toBeNull();
  });

  it("fails closed when a stronger identity appears on only one side", () => {
    expect(
      officeIdentitySnapshotsMatch(
        officeIdentitySnapshotFromPanel(panel({ threadId: "thread-1" })),
        officeIdentitySnapshotFromPanel(
          panel({
            configPath: "/repo/office.json",
            recordId: "record-1",
            threadId: "thread-1",
          }),
        ),
      ),
    ).toBe(false);
  });

  it("does not downgrade a record identity to a shared legacy thread", () => {
    expect(
      officeIdentitySnapshotsMatch(
        officeIdentitySnapshotFromPanel(
          panel({ recordId: "record-1", threadId: "shared-thread" }),
        ),
        officeIdentitySnapshotFromPanel(panel({ threadId: "shared-thread" })),
      ),
    ).toBe(false);
  });

  it("does not match a different record even when titles are identical", () => {
    const target = officeIdentityFromPanel(panel({ recordId: "record-1" }));
    expect(target).not.toBeNull();
    expect(
      officePanelMatchesIdentity(panel({ recordId: "record-2" }), target!),
    ).toBe(false);
  });

  it("uses the group-chat workspace as a hard identity fence", () => {
    const target = officeIdentityFromPanel(
      panel({ recordId: "record-1", workspaceCwd: "/repo/team-a" }),
    );

    expect(target).toEqual({
      kind: "recordId",
      value: "record-1",
      workspaceCwd: "/repo/team-a",
    });
    expect(
      officePanelMatchesIdentity(
        panel({ recordId: "record-1", workspaceCwd: "/repo/team-b" }),
        target!,
      ),
    ).toBe(false);
    expect(
      officeIdentitySnapshotsMatch(
        officeIdentitySnapshotFromPanel(
          panel({ recordId: "record-1", workspaceCwd: "/repo/team-a" }),
        ),
        officeIdentitySnapshotFromPanel(
          panel({ recordId: "record-1", workspaceCwd: "/repo/team-b" }),
        ),
      ),
    ).toBe(false);
    expect(
      officeResponseMatchesIdentity(
        {
          title: "Office",
          subtitle: "Workspace",
          workspace: panel({ recordId: "record-1" }).workspace!,
        },
        "/repo/office.json",
        target!,
        null,
        "/repo/team-b",
      ),
    ).toBe(false);
  });
});
