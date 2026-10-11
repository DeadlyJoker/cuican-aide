import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  captureDesktopNativePluginAuthorityOwner,
  createDesktopNativePluginAuthority,
} from "./desktopNativePluginAuthority.ts";
import { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";
import { LocalWorkspaceSandbox } from "./localWorkspace.ts";
import {
  LocalWorkspaceProjectAllocationJournal,
  projectAllocationWorkspaceId,
} from "./localWorkspaceProjectAllocationJournal.ts";
import { nativeProjectWorkspaceBridgeFixture } from "./desktopNativeProjectWorkspaceBridge.test-support.ts";

const observation = vi.hoisted(() => ({
  afterRegistryRename: null as (() => void) | null,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      fs.renameSync(...args);
      if (String(args[1]).endsWith("/desktop-workspace.json")) {
        const callback = observation.afterRegistryRename;
        observation.afterRegistryRename = null;
        callback?.();
      }
    },
  };
});
type Fixture = Awaited<ReturnType<typeof nativeProjectWorkspaceBridgeFixture>>;
const fixtures: Fixture[] = [];
async function fixture(requirement: "none" | "perAction" = "none") {
  const f = await nativeProjectWorkspaceBridgeFixture(requirement);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  observation.afterRegistryRename = null;
  for (const f of fixtures.splice(0)) await f.close();
});
const unavailable = "desktop_native_project_workspace_bridge_unavailable";

describe("private Main-issued Native project allocation bridge over real child IPC", () => {
  it("uses original registry and real directory, preserving active workspace and an in-flight file lease", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      lease = f.workspaces.captureRoot();
    writeFileSync(join(f.ordinary, "saved.txt"), "keep ordinary");
    const preview = new LocalWorkspaceSandbox(f.workspaces).readFile(
      "/workspace/saved.txt",
    );
    const reply = await f.send(f.control, f.request(f.prepare(bridge)));
    expect(reply).toMatchObject({
      outcome: "observed",
      allocation: {
        phase: "registered",
        observation: "registered",
        failureCode: null,
      },
    });
    if (reply?.outcome !== "observed") throw new Error("expected observed");
    const root = f.workspaces.root(reply.allocation.workspaceId);
    expect(statSync(root).isDirectory()).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    const journal = new LocalWorkspaceProjectAllocationJournal(
      f.dataDirectory,
    ).read();
    expect(journal.state.allocations[0].owner).toEqual({
      ...f.input.actor,
      profileId: f.bootstrap.scope.profileId,
      pluginId: f.source.pluginId,
      publisherId: f.source.publisherId,
      projectId: "project-a",
    });
    expect(f.workspaces.root()).toBe(f.ordinary);
    expect(() => f.workspaces.assertRootCurrent(lease)).not.toThrow();
    expect(await preview).toMatchObject({ content: "keep ordinary" });
    expect(f.workspaces.status().workspaces).toHaveLength(2);
    expect(JSON.stringify(reply)).not.toContain(f.directory);
    expect(JSON.stringify(reply)).not.toMatch(
      /ready|owner|principal|publisher|metadata|binding/iu,
    );
    expect(Object.keys(f.native.authority)).not.toContain("signal");
  });

  it("burns once regardless of a different request id and supports an explicit same-owner provision replay", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      ticket = f.prepare(bridge);
    const first = await f.send(f.control, f.request(ticket));
    expect(
      await f.send(f.control, f.request(ticket, "request-b")),
    ).toMatchObject({
      outcome: "unavailable",
      reasonCode: "ticket_unavailable",
    });
    const replay = await f.send(
      f.control,
      f.request(f.prepare(bridge), "request-c"),
    );
    expect(replay).toMatchObject({
      outcome: "observed",
      allocation: first?.outcome === "observed" ? first.allocation : undefined,
    });
    expect(f.workspaces.status().revision).toBe(1);
    expect(f.workspaces.status().workspaces).toHaveLength(2);
  });

  it.each(["path", "workspaceId", "actor", "owner", "profileId", "recover"])(
    "rejects wire-supplied %s and burns the attempted ticket before validation",
    async (key) => {
      const f = await fixture(),
        bridge = f.bridge(),
        ticket = f.prepare(bridge);
      expect(
        await f.send(f.control, {
          ...f.request(ticket),
          [key]: "/tmp/foreign",
        }),
      ).toMatchObject({
        outcome: "unavailable",
        reasonCode: "request_invalid",
      });
      expect(
        await f.send(f.control, f.request(ticket, "after-invalid")),
      ).toMatchObject({
        outcome: "unavailable",
        reasonCode: "ticket_unavailable",
      });
      expect(f.workspaces.status().workspaces).toHaveLength(1);
      expect(
        existsSync(
          join(f.dataDirectory, "desktop-plugin-project-workspaces.json"),
        ),
      ).toBe(false);
    },
  );

  it.each([
    "path",
    "workspaceId",
    "actor",
    "owner",
    "profileId",
    "publisherId",
  ])(
    "rejects Main prepare recipe's extra %s field without issuing allocation",
    async (key) => {
      const f = await fixture(),
        bridge = f.bridge();
      expect(() =>
        bridge.prepare({
          projectId: "project-a",
          packageIdentity: f.packageIdentity,
          [key]: "spoofed",
        } as never),
      ).toThrow();
      expect(f.workspaces.status().revision).toBe(0);
    },
  );

  it.each(["pluginId", "publisherId", "version", "packageDigest"])(
    "rejects an unapproved exact package %s",
    async (key) => {
      const f = await fixture(),
        bridge = f.bridge();
      expect(() =>
        bridge.prepare({
          projectId: "project-a",
          packageIdentity: { ...f.packageIdentity, [key]: "unapproved" },
        }),
      ).toThrow(unavailable);
      expect(f.workspaces.status().revision).toBe(0);
    },
  );

  it("rejects perAction policy without an actual action approval source", async () => {
    const f = await fixture("perAction"),
      bridge = f.bridge();
    expect(() => f.prepare(bridge)).toThrow(unavailable);
    expect(f.workspaces.status().revision).toBe(0);
  });

  it("rejects structural/copied policy issuance with a real bootstrap, and policy from another original data directory", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const policy of [
      { ...f.policy },
      { ...f.policy, assertCurrent() {} },
      other.policy,
    ])
      expect(() =>
        createDesktopNativePluginAuthority({
          dataDirectory: f.dataDirectory,
          bootstrap: f.bootstrap,
          policy,
        }),
      ).toThrow("native_policy_unissued");
    expect(captureDesktopNativePluginAuthorityOwner(f.native).authority).toBe(
      f.native.authority,
    );
    expect(() =>
      captureDesktopNativePluginAuthorityOwner({ ...f.native }),
    ).toThrow("native_owner_unissued");
  });

  it("rejects structural/copied Native owner and actual workspace authority of another root before listeners attach", async () => {
    const f = await fixture(),
      before = f.control.listenerCount("message");
    for (const nativeAuthority of [
      { ...f.native },
      { authority: f.native.authority, assertCurrent() {} },
      f.native.authority,
    ])
      expect(() => f.bridge({ nativeAuthority })).toThrow(
        "native_owner_unissued",
      );
    const otherRoot = join(f.directory, "foreign-data");
    mkdirSync(otherRoot, { mode: 0o700 });
    expect(() =>
      f.bridge({
        workspaces: new LocalWorkspaceAuthority(otherRoot, f.ordinary),
      }),
    ).toThrow(unavailable);
    expect(() =>
      f.bridge({
        workspaces: {
          projectAllocationDataDirectory: () => f.dataDirectory,
        } as LocalWorkspaceAuthority,
      }),
    ).toThrow(unavailable);
    expect(f.control.listenerCount("message")).toBe(before);
  });

  it("rejects a structural child, unspawned ChildProcess and real spawned child without IPC", async () => {
    const f = await fixture();
    expect(() =>
      f.bridge({
        control: { connected: true, pid: f.control.pid } as ChildProcess,
      }),
    ).toThrow(unavailable);
    expect(() => f.bridge({ control: new ChildProcess() })).toThrow(
      unavailable,
    );
    const noIpc = spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
      stdio: "ignore",
    });
    const closed = once(noIpc, "close");
    try {
      expect(() => f.bridge({ control: noIpc })).toThrow(unavailable);
    } finally {
      noIpc.kill();
      await closed;
    }
  });

  it("allows exactly one bridge for the same physical child and revokes old-generation tickets after close/rebind", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      ticket = f.prepare(bridge);
    expect(() => f.bridge()).toThrow(unavailable);
    await bridge.close();
    const replacement = f.bridge();
    expect(await f.send(f.control, f.request(ticket))).toMatchObject({
      outcome: "unavailable",
      reasonCode: "ticket_unavailable",
    });
    expect(
      await f.send(
        f.control,
        f.request(f.prepare(replacement), "new-generation"),
      ),
    ).toMatchObject({ outcome: "observed" });
  });

  it("does not let another actual child or bridge borrow a ticket", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      ticket = f.prepare(bridge),
      child = await f.spawnControl();
    f.bridge({ control: child });
    expect(await f.send(child, f.request(ticket))).toMatchObject({
      outcome: "unavailable",
      reasonCode: "ticket_unavailable",
    });
    expect(
      await f.send(f.control, f.request(ticket, "original-child")),
    ).toMatchObject({ outcome: "observed" });
  });

  it.each(["withdraw", "abort", "nativeWithdraw"] as const)(
    "%s synchronously withdraws unused tickets without withdrawing another shared Native owner",
    async (method) => {
      const f = await fixture(),
        bridge = f.bridge(),
        ticket = f.prepare(bridge);
      if (method === "withdraw") bridge.withdraw();
      else if (method === "abort") f.signal.abort();
      else f.native.withdraw();
      expect(() => f.prepare(bridge)).toThrow(unavailable);
      await f.send(f.control, f.request(ticket), false);
      expect(f.workspaces.status().revision).toBe(0);
      if (method !== "nativeWithdraw")
        expect(() => f.native.assertCurrent()).not.toThrow();
    },
  );

  it.each(["disconnect", "exit"])(
    "actual child %s revokes preparation immediately",
    async (event) => {
      const f = await fixture(),
        bridge = f.bridge();
      f.prepare(bridge);
      const observed = once(f.control, event);
      f.control.send({ kind: `fixture.${event}` });
      await observed;
      expect(() => f.prepare(bridge)).toThrow(unavailable);
      expect(f.workspaces.status().revision).toBe(0);
    },
  );

  it.each(["policy", "approval", "profile"])(
    "rechecks %s file pin after prepare, before consumption",
    async (pin) => {
      const f = await fixture(),
        bridge = f.bridge(),
        ticket = f.prepare(bridge);
      const path =
        pin === "policy"
          ? f.policyPath
          : pin === "approval"
            ? f.approvalPath
            : join(f.dataDirectory, "plugin-profile.json");
      writeFileSync(path, "{}", { mode: 0o600 });
      await f.send(f.control, f.request(ticket), false);
      expect(() => f.prepare(bridge)).toThrow(unavailable);
      expect(f.workspaces.status().revision).toBe(0);
    },
  );

  it("rechecks Native pins at result publication even after a real registry commit", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      ticket = f.prepare(bridge);
    observation.afterRegistryRename = () =>
      writeFileSync(f.policyPath, "{}", { mode: 0o600 });
    const responses: unknown[] = [];
    const capture = (value: { kind?: string }) => {
      if (value.kind === "fixture.response") responses.push(value);
    };
    f.control.on("message", capture);
    await f.send(f.control, f.request(ticket), false);
    f.control.removeListener("message", capture);
    expect(responses).toEqual([]);
    expect(() => f.prepare(bridge)).toThrow(unavailable);
    expect(f.workspaces.status().workspaces).toHaveLength(2);
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations[0].phase,
    ).toBe("registered");
    expect(f.workspaces.root()).toBe(f.ordinary);
  });

  it("bounds pending tickets without allocation", async () => {
    const f = await fixture(),
      bridge = f.bridge();
    Array.from({ length: 16 }, (_, index) =>
      f.prepare(bridge, `project-${index}`),
    );
    expect(() => f.prepare(bridge, "project-overflow")).toThrow(unavailable);
    expect(f.workspaces.status().revision).toBe(0);
  });

  it("expires an unused ticket without allocation or implicit retry", async () => {
    const f = await fixture(),
      bridge = f.bridge({ deadlineMs: 50 }),
      ticket = f.prepare(bridge);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await f.send(f.control, f.request(ticket))).toMatchObject({
      outcome: "unavailable",
      reasonCode: "ticket_unavailable",
    });
    expect(f.workspaces.status().revision).toBe(0);
    expect(() => f.prepare(bridge, "new-explicit-project")).not.toThrow();
  });

  it("failed allocation burns the ticket and subsequent explicit provision only observes the failure, without recover", async () => {
    const f = await fixture(),
      bridge = f.bridge();
    const owner = {
      ...f.input.actor,
      profileId: f.bootstrap.scope.profileId,
      pluginId: f.source.pluginId,
      publisherId: f.source.publisherId,
      projectId: "project-a",
    };
    mkdirSync(join(f.dataDirectory, "plugin-project-workspaces"), {
      mode: 0o700,
    });
    mkdirSync(
      join(
        f.dataDirectory,
        "plugin-project-workspaces",
        projectAllocationWorkspaceId(owner),
      ),
      { mode: 0o700 },
    );
    const ticket = f.prepare(bridge),
      first = await f.send(f.control, f.request(ticket));
    expect(first).toMatchObject({
      outcome: "observed",
      allocation: {
        phase: "failed",
        observation: "unobserved",
        failureCode: "directoryUnavailable",
      },
    });
    expect(
      await f.send(f.control, f.request(ticket, "used-ticket")),
    ).toMatchObject({ reasonCode: "ticket_unavailable" });
    const before = readFileSync(
      join(f.dataDirectory, "desktop-plugin-project-workspaces.json"),
      "utf8",
    );
    expect(
      await f.send(f.control, f.request(f.prepare(bridge), "observe-failure")),
    ).toMatchObject({
      outcome: "observed",
      allocation: first?.outcome === "observed" ? first.allocation : undefined,
    });
    expect(
      readFileSync(
        join(f.dataDirectory, "desktop-plugin-project-workspaces.json"),
        "utf8",
      ),
    ).toBe(before);
    expect(f.workspaces.status().revision).toBe(0);
  });

  it("honors original registry stale-byte authority fence before any allocation", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      ticket = f.prepare(bridge);
    const concurrent = new LocalWorkspaceAuthority(f.dataDirectory, f.ordinary);
    concurrent.select(f.other, {
      expectedRevision: 0,
      idempotencyKey: "external-select",
    });
    await f.send(f.control, f.request(ticket), false);
    expect(() => f.prepare(bridge)).toThrow(unavailable);
    expect(new LocalWorkspaceAuthority(f.dataDirectory).root()).toBe(f.other);
    expect(
      existsSync(
        join(f.dataDirectory, "desktop-plugin-project-workspaces.json"),
      ),
    ).toBe(false);
  });

  it("keeps another original active workspace selection made between prepare and consume", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      ticket = f.prepare(bridge);
    f.workspaces.select(f.other, {
      expectedRevision: 0,
      idempotencyKey: "select-other",
    });
    const lease = f.workspaces.captureRoot();
    expect(await f.send(f.control, f.request(ticket))).toMatchObject({
      outcome: "observed",
    });
    expect(f.workspaces.root()).toBe(f.other);
    expect(() => f.workspaces.assertRootCurrent(lease)).not.toThrow();
  });

  it("close preserves foreign listeners and live child, joins requests, and does not mutate registry files", async () => {
    const f = await fixture(),
      foreign = () => {},
      bridge = f.bridge();
    f.control.on("message", foreign);
    f.control.on("disconnect", foreign);
    const ticket = f.prepare(bridge);
    await bridge.close();
    expect(f.control.connected).toBe(true);
    expect(f.control.listeners("message")).toEqual([foreign]);
    expect(f.control.listeners("disconnect")).toEqual([foreign]);
    expect(() => f.native.assertCurrent()).not.toThrow();
    expect(() => f.prepare(bridge)).toThrow(unavailable);
    await f.send(f.control, f.request(ticket), false);
    expect(f.workspaces.status().revision).toBe(0);
    f.control.removeListener("message", foreign);
    f.control.removeListener("disconnect", foreign);
  });

  it("sanitizes an oversized extra IPC field, rejects oversized correlation ids, and burns both attempted tickets", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      first = f.prepare(bridge),
      second = f.prepare(bridge, "project-b");
    expect(
      await f.send(f.control, {
        ...f.request(first),
        extra: { nested: ["x".repeat(256 * 1024)] },
      }),
    ).toMatchObject({ outcome: "unavailable", reasonCode: "request_invalid" });
    await f.send(
      f.control,
      { ...f.request(second), requestId: "x".repeat(256 * 1024) },
      false,
    );
    for (const [index, ticket] of [first, second].entries())
      expect(
        await f.send(f.control, f.request(ticket, `after-oversized-${index}`)),
      ).toMatchObject({ reasonCode: "ticket_unavailable" });
    expect(f.workspaces.status().revision).toBe(0);
  });

  it("ignores another private protocol without burning its referenced ticket or removing its handler", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      ticket = f.prepare(bridge),
      messages: unknown[] = [];
    const foreign = (value: { schemaVersion?: string }) => {
      if (value.schemaVersion === "another.private.v1") messages.push(value);
    };
    f.control.on("message", foreign);
    const request = {
      ...f.request(ticket),
      schemaVersion: "another.private.v1",
      unrelated: { input: "foreign" },
    };
    await f.send(f.control, request, false);
    expect(messages).toEqual([request]);
    expect(f.workspaces.status().revision).toBe(0);
    expect(
      await f.send(f.control, f.request(ticket, "own-protocol")),
    ).toMatchObject({ outcome: "observed" });
    await bridge.close();
    expect(f.control.listeners("message")).toContain(foreign);
    f.control.removeListener("message", foreign);
  });

  it("treats send false as backpressure while still using the real IPC delivery and callback", async () => {
    const f = await fixture(),
      actualSend = f.control.send;
    const spy = vi.spyOn(f.control, "send").mockImplementation(((
      ...args: unknown[]
    ) => {
      Reflect.apply(actualSend, f.control, args);
      return false;
    }) as ChildProcess["send"]);
    try {
      const bridge = f.bridge();
      expect(
        await f.send(f.control, f.request(f.prepare(bridge))),
      ).toMatchObject({ outcome: "observed" });
      expect(() => f.prepare(bridge, "project-b")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("a real IPC send error withdraws this bridge after Native commit and cannot make the ticket reusable", async () => {
    const f = await fixture(),
      actualSend = f.control.send;
    const spy = vi.spyOn(f.control, "send").mockImplementation(((
      message: { schemaVersion?: string },
      ...args: unknown[]
    ) => {
      if (
        message.schemaVersion ===
        "crewon.desktop-native-project-workspace-response.v1"
      )
        f.control.disconnect();
      return Reflect.apply(actualSend, f.control, [message, ...args]);
    }) as ChildProcess["send"]);
    try {
      const bridge = f.bridge(),
        ticket = f.prepare(bridge),
        disconnected = once(f.control, "disconnect");
      f.control.send({
        kind: "fixture.send",
        id: "send-error",
        request: f.request(ticket),
      });
      await disconnected;
      await bridge.close();
      expect(() => f.prepare(bridge)).toThrow(unavailable);
      expect(f.workspaces.status().workspaces).toHaveLength(2);
      expect(() => f.native.assertCurrent()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("joins an actual Native request when close happens during the original registry write, preserving the committed files", async () => {
    const f = await fixture(),
      bridge = f.bridge(),
      ticket = f.prepare(bridge);
    let closed: Promise<void> | undefined;
    observation.afterRegistryRename = () => {
      closed = bridge.close();
    };
    await f.send(f.control, f.request(ticket), false);
    await closed;
    expect(closed).toBeDefined();
    expect(f.control.connected).toBe(true);
    expect(f.control.listenerCount("message")).toBe(0);
    expect(f.workspaces.status().workspaces).toHaveLength(2);
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations[0].phase,
    ).toBe("registered");
    expect(existsSync(f.native.path)).toBe(true);
    expect(() => f.native.assertCurrent()).not.toThrow();
    expect(f.workspaces.root()).toBe(f.ordinary);
  });

  it("bounds actual send deadline with a stopped real child and queued IPC backpressure", async () => {
    const f = await fixture(),
      bridge = f.bridge({ deadlineMs: 120 }),
      ticket = f.prepare(bridge);
    const fill = (value: { kind?: string }) => {
      if (value.kind === "fixture.stopping")
        f.control.send(
          { kind: "fixture.fill", input: "x".repeat(2 * 1024 * 1024) },
          () => {},
        );
    };
    f.control.on("message", fill);
    try {
      f.control.send({ kind: "fixture.send-stop", request: f.request(ticket) });
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(() => f.prepare(bridge)).toThrow(unavailable);
      await bridge.close();
      expect(f.workspaces.status().workspaces).toHaveLength(2);
      expect(f.control.connected).toBe(true);
      expect(f.workspaces.root()).toBe(f.ordinary);
    } finally {
      f.control.removeListener("message", fill);
      f.control.kill("SIGCONT");
    }
  });

  it("bounds pending responses and synchronously withdraws on a real IPC request flood", async () => {
    const f = await fixture(),
      bridge = f.bridge({ deadlineMs: 150 });
    f.prepare(bridge);
    const fill = (value: { kind?: string }) => {
      if (value.kind === "fixture.stopping")
        f.control.send(
          { kind: "fixture.fill", input: "x".repeat(2 * 1024 * 1024) },
          () => {},
        );
    };
    f.control.on("message", fill);
    try {
      f.control.send({
        kind: "fixture.send-stop",
        requests: Array.from({ length: 5 }, (_, index) => ({
          schemaVersion: "crewon.desktop-native-project-workspace-request.v1",
          requestId: `flood-${index}`,
          ticketId: "0".repeat(64),
        })),
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(() => f.prepare(bridge)).toThrow(unavailable);
      await bridge.close();
      expect(f.control.connected).toBe(true);
      expect(f.workspaces.status().revision).toBe(0);
      expect(
        existsSync(
          join(f.dataDirectory, "desktop-plugin-project-workspaces.json"),
        ),
      ).toBe(false);
    } finally {
      f.control.removeListener("message", fill);
      f.control.kill("SIGCONT");
    }
  });
});
