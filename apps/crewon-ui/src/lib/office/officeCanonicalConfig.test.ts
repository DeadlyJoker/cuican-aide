import { describe, expect, it } from "vitest";

import type { OfficeConfig } from "../domain/crewonDomain";
import { readCanonicalOfficeConfigForMutation } from "./officeCanonicalConfig";

function officeConfig(params: {
  recordId?: string;
  recordRevision?: string;
  threadId?: string;
}): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Workspace",
    workspace: {
      goal: "Ship",
      members: [],
      messages: [],
      tasks: [],
      ...params,
    },
  };
}

describe("canonical Office config reads", () => {
  it("reads by thread and verifies the stable record id", async () => {
    const canonical = officeConfig({
      recordId: "office-record-1",
      recordRevision: "revision-2",
      threadId: "office-thread",
    });
    const calls: unknown[] = [];

    const result = await readCanonicalOfficeConfigForMutation({
      client: {
        async readOfficeConfig(cwd, params) {
          calls.push({ cwd, params });
          return {
            record: {
              config: canonical,
              filePath: "/repo/.crewon/offices/office.json",
              savedAt: "2026-07-13T00:00:00Z",
            },
          };
        },
      },
      cwd: "/repo",
      reference: officeConfig({
        recordId: "office-record-1",
        recordRevision: "revision-1",
        threadId: "office-thread",
      }),
    });

    expect(calls).toEqual([
      {
        cwd: "/repo",
        params: { threadId: "office-thread", title: null },
      },
    ]);
    expect(result).toEqual({
      config: canonical,
      filePath: "/repo/.crewon/offices/office.json",
    });
  });

  it("supports legacy snapshots without a record id through exact thread lookup", async () => {
    const canonical = officeConfig({
      recordId: "derived-record-id",
      recordRevision: "revision-2",
      threadId: "legacy-thread",
    });

    await expect(
      readCanonicalOfficeConfigForMutation({
        client: {
          async readOfficeConfig() {
            return {
              record: {
                config: canonical,
                filePath: "/repo/.crewon/offices/legacy.json",
                savedAt: "2026-07-13T00:00:00Z",
              },
            };
          },
        },
        cwd: "/repo",
        reference: officeConfig({ threadId: "legacy-thread" }),
      }),
    ).resolves.toEqual({
      config: canonical,
      filePath: "/repo/.crewon/offices/legacy.json",
    });
  });

  it("fails closed when the canonical record id differs", async () => {
    await expect(
      readCanonicalOfficeConfigForMutation({
        client: {
          async readOfficeConfig() {
            return {
              record: {
                config: officeConfig({
                  recordId: "other-record",
                  threadId: "office-thread",
                }),
                filePath: "/repo/.crewon/offices/other.json",
                savedAt: "2026-07-13T00:00:00Z",
              },
            };
          },
        },
        cwd: "/repo",
        reference: officeConfig({
          recordId: "office-record-1",
          threadId: "office-thread",
        }),
      }),
    ).rejects.toThrow("Canonical Office recordId does not match the target");
  });

  it("fails closed without a thread id because office/read cannot read by record id yet", async () => {
    await expect(
      readCanonicalOfficeConfigForMutation({
        client: {
          async readOfficeConfig() {
            throw new Error("unexpected read");
          },
        },
        cwd: "/repo",
        reference: officeConfig({ recordId: "office-record-1" }),
      }),
    ).rejects.toThrow(
      "Cannot safely resolve canonical Office config without workspace.threadId",
    );
  });

  it("fails closed when the canonical Office no longer exists", async () => {
    await expect(
      readCanonicalOfficeConfigForMutation({
        client: {
          async readOfficeConfig() {
            return { record: null };
          },
        },
        cwd: "/repo",
        reference: officeConfig({ threadId: "office-thread" }),
      }),
    ).rejects.toThrow(
      "Unable to resolve canonical Office record for thread office-thread",
    );
  });
});
