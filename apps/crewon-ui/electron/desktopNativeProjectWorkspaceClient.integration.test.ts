import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  nativeProjectWorkspaceBridgeFixture,
  waitMessage,
} from "./desktopNativeProjectWorkspaceBridge.test-support.ts";
import { LocalWorkspaceProjectAllocationJournal } from "./localWorkspaceProjectAllocationJournal.ts";

const clientUrl = new URL(
  "../../control-api/src/desktop-native-project-workspace-client.ts",
  import.meta.url,
).href;
const program = `
const { DesktopNativeProjectWorkspaceClient } = await import(${JSON.stringify(clientUrl)});
const lifetime = new AbortController();
const client = new DesktopNativeProjectWorkspaceClient({signal: lifetime.signal, deadlineMs: 500});
const report = value => process.connected ? process.send(value) : process.stdout.write(JSON.stringify(value) + "\\n");
process.on("message", async value => {
  if (value?.kind === "fixture.allocate") {
    try {
      const signal = new AbortController();
      if (value.abort) signal.abort();
      const result = await client.allocate(value.ticket, signal.signal);
      report({kind: "fixture.result", id: value.id, result});
    } catch (error) { report({kind:"fixture.result", id:value.id, error:error.message}); }
  } else if (value?.kind === "fixture.close") {
    const before = {message: process.listenerCount("message"), disconnect: process.listenerCount("disconnect")};
    await client.close();
    process.send({kind:"fixture.closed", before, after: {message: process.listenerCount("message"), disconnect: process.listenerCount("disconnect")}});
  } else if (value?.kind === "fixture.abort") lifetime.abort();
});
process.send({kind:"fixture.ready"});
`;
type Fixture = Awaited<ReturnType<typeof nativeProjectWorkspaceBridgeFixture>>;
const fixtures: Fixture[] = [];
let sequence = 0;
async function fixture() {
  const f = await nativeProjectWorkspaceBridgeFixture("none", program);
  fixtures.push(f);
  return f;
}
function allocate(f: Fixture, ticket: unknown, abort = false) {
  const id = `client-${++sequence}`;
  const result = waitMessage(
    f.control,
    (v) => v.kind === "fixture.result" && v.id === id,
  );
  f.control.send({ kind: "fixture.allocate", id, ticket, abort });
  return result;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
describe("actual Control child and Main workspace transport", () => {
  it("connects the real Control client to the original Main allocator without changing the active workspace", async () => {
    const f = await fixture();
    const original = readFileSync(
      join(f.dataDirectory, "desktop-workspace.json"),
      "utf8",
    );
    const bridge = f.bridge();
    const ticket = f.prepare(bridge);
    const observed = await allocate(f, ticket);
    expect(observed.result.outcome).toBe("observed");
    expect(observed.result.allocation.phase).toBe("registered");
    expect(observed.result.allocation.observation).toBe("registered");
    expect(observed.result.allocation.failureCode).toBeNull();
    expect(f.workspaces.root()).toBe(f.ordinary);
    const updated = JSON.parse(
      readFileSync(join(f.dataDirectory, "desktop-workspace.json"), "utf8"),
    );
    expect(updated.workspaces).toHaveLength(
      JSON.parse(original).workspaces.length + 1,
    );
    const replay = await allocate(f, ticket);
    expect(replay.result).toMatchObject({
      outcome: "unavailable",
      reasonCode: "ticket_unavailable",
    });
    const cold = await allocate(f, f.prepare(bridge));
    expect(cold.result.allocation.workspaceId).toBe(
      observed.result.allocation.workspaceId,
    );
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations,
    ).toHaveLength(1);
  });
  it("fails expired, aborted and expanded tickets before sending or allocating", async () => {
    const f = await fixture();
    const bridge = f.bridge();
    const ticket = f.prepare(bridge);
    expect(
      (await allocate(f, { ...ticket, root: "/tmp/foreign" })).error,
    ).toMatch(/wire_invalid/);
    expect(
      (await allocate(f, { ...ticket, expiresAt: "2000-01-01T00:00:00.000Z" }))
        .error,
    ).toMatch(/ticket_expired/);
    expect((await allocate(f, ticket, true)).error).toMatch(/request_aborted/);
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations,
    ).toHaveLength(0);
    expect((await allocate(f, ticket)).result.allocation.phase).toBe(
      "registered",
    );
  });
  it("reports absent responses once, keeps the real child alive, and preserves completed allocations", async () => {
    const f = await fixture();
    // No Main bridge is present for this first request: no response, retry or directory is manufactured.
    const unknown = {
      schemaVersion: "crewon.desktop-native-project-workspace-ticket.v1",
      ticketId: "f".repeat(64),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    };
    expect((await allocate(f, unknown)).error).toMatch(/deadline_exceeded/);
    const bridge = f.bridge();
    const observed = await allocate(f, f.prepare(bridge));
    expect(observed.result.allocation.phase).toBe("registered");
    const closed = waitMessage(f.control, (v) => v.kind === "fixture.closed");
    f.control.send({ kind: "fixture.close" });
    const cleanup = await closed;
    expect(cleanup.after.message).toBe(cleanup.before.message - 1);
    expect(cleanup.after.disconnect).toBe(cleanup.before.disconnect - 1);
    expect(f.control.connected).toBe(true);
    expect(
      (await allocate(f, f.prepare(bridge, "another-project"))).error,
    ).toMatch(/unavailable/);
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations,
    ).toHaveLength(1);
  });
  it("rejects a correlated malformed reply, ignores another correlation, and bounds concurrent requests without a retry queue", async () => {
    const f = await fixture();
    const ticket = {
      schemaVersion: "crewon.desktop-native-project-workspace-ticket.v1",
      ticketId: "f".repeat(64),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    };
    const sent = waitMessage(
      f.control,
      (v) =>
        v.schemaVersion ===
        "crewon.desktop-native-project-workspace-request.v1",
    );
    const first = allocate(f, ticket);
    const request = await sent;
    f.control.send({
      schemaVersion: "crewon.desktop-native-project-workspace-response.v1",
      requestId: "foreign",
      outcome: "unavailable",
      reasonCode: "ticket_unavailable",
    });
    f.control.send({
      schemaVersion: "crewon.desktop-native-project-workspace-response.v1",
      requestId: request.requestId,
      outcome: "unavailable",
      reasonCode: "ticket_unavailable",
      root: "/tmp/foreign",
    });
    expect((await first).error).toMatch(/response_invalid/);
    let sentCount = 0;
    const count = (v: any) => {
      if (
        v?.schemaVersion ===
        "crewon.desktop-native-project-workspace-request.v1"
      )
        sentCount++;
    };
    f.control.on("message", count);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => allocate(f, ticket)),
    );
    expect(
      results.filter((v) => /deadline_exceeded/.test(v.error)),
    ).toHaveLength(4);
    expect(
      results.filter((v) => /capacity_exceeded/.test(v.error)),
    ).toHaveLength(1);
    expect(sentCount).toBe(4);
    f.control.removeListener("message", count);
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations,
    ).toHaveLength(0);
  });
  it("withdraws an actual pending request when the Control lifetime is aborted", async () => {
    const f = await fixture();
    const ticket = {
      schemaVersion: "crewon.desktop-native-project-workspace-ticket.v1",
      ticketId: "f".repeat(64),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    };
    const sent = waitMessage(
      f.control,
      (v) =>
        v.schemaVersion ===
        "crewon.desktop-native-project-workspace-request.v1",
    );
    const pending = allocate(f, ticket);
    await sent;
    f.control.send({ kind: "fixture.abort" });
    expect((await pending).error).toMatch(/unavailable/);
    expect((await allocate(f, ticket)).error).toMatch(/unavailable/);
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations,
    ).toHaveLength(0);
  });
  it("withdraws on a real parent IPC disconnect and leaves no allocation", async () => {
    const f = await fixture();
    const ticket = {
      schemaVersion: "crewon.desktop-native-project-workspace-ticket.v1",
      ticketId: "f".repeat(64),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    };
    const sent = waitMessage(
      f.control,
      (v) =>
        v.schemaVersion ===
        "crewon.desktop-native-project-workspace-request.v1",
    );
    const result = new Promise<any>((resolve, reject) => {
      let bytes = "";
      const timer = setTimeout(() => {
        f.control.stdout!.removeListener("data", read);
        reject(new Error("fixture_stdout_deadline"));
      }, 2000);
      const read = (chunk: Buffer) => {
        bytes += chunk.toString("utf8");
        if (!bytes.includes("\n")) return;
        clearTimeout(timer);
        f.control.stdout!.removeListener("data", read);
        resolve(JSON.parse(bytes.split("\n")[0]));
      };
      f.control.stdout!.on("data", read);
    });
    f.control.send({ kind: "fixture.allocate", id: "disconnect", ticket });
    await sent;
    f.control.disconnect();
    expect((await result).error).toMatch(/unavailable/);
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations,
    ).toHaveLength(0);
  });
});
