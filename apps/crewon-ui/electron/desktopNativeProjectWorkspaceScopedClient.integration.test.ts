import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import {
  nativeProjectWorkspaceBridgeFixture,
  waitMessage,
} from "./desktopNativeProjectWorkspaceBridge.test-support.ts";
import { LocalWorkspaceProjectAllocationJournal } from "./localWorkspaceProjectAllocationJournal.ts";

const profileId = "00000000-0000-4000-8000-000000000001";
const pkg = {
  pluginId: "example.short-drama",
  publisherId: "example.publisher",
  version: "1.0.0",
  packageDigest: "sha256:" + "a".repeat(64),
};
const fixtureUrl = new URL(
  "../../../packages/store/src/project-workspace-preparation.test-support.ts",
  import.meta.url,
).href;
const clientUrl = new URL(
  "../../control-api/src/desktop-native-project-workspace-client.ts",
  import.meta.url,
).href;
const applicationUrl = new URL(
  "../../../packages/application/src/index.ts",
  import.meta.url,
).href;
const program = `
const { workspacePreparationUiFixture } = await import(${JSON.stringify(fixtureUrl)});
const { DesktopNativeProjectWorkspaceClient } = await import(${JSON.stringify(clientUrl)});
const { qualifyPluginProjectWorkspacePreparation } = await import(${JSON.stringify(applicationUrl)});
const f = await workspacePreparationUiFixture({actor:${JSON.stringify(actor)}, profileId:${JSON.stringify(profileId)}, packageIdentity:${JSON.stringify(pkg)}});
const client = new DesktopNativeProjectWorkspaceClient({signal:new AbortController().signal, deadlineMs:1000});
let giveTicket;

process.on("message", async value => {
  if(value?.kind === "fixture.start") {
    f.state.callback = async preparation => {
      const source = qualifyPluginProjectWorkspacePreparation(preparation);
      const ticket = await new Promise(resolve => {
        giveTicket=resolve;
        process.send({kind:"fixture.prepared", owner:source.owner, packageIdentity:source.packageIdentity, expectedWorkspaceId:source.expectedWorkspaceId});
      });
      const output=await client.allocateForProject({preparation, ticket});
      process.send({kind:"fixture.allocated", output});
      return output;
    };
    try {
      const output=await f.invoke();
      process.send({kind:"fixture.completed", output});
    } catch(error) {
      process.send({kind:"fixture.completed", error:error.code ?? error.message, cause:error.cause?.message,
        });
    }
  } else if(value?.kind === "fixture.ticket") giveTicket?.(value.ticket);
  else if(value?.kind === "fixture.revoke") f.state.policyAllowed=false;
  else if(value?.kind === "fixture.fake") {
    try { await client.allocateForProject({preparation:{version:"crewon.plugin-project-workspace-preparation.v1"}, ticket:value.ticket}); }
    catch(error){process.send({kind:"fixture.fake-result", error:error.code ?? error.message});}
  } else if(value?.kind === "fixture.cleanup") {
    await client.close();
    f.close();
    process.send({kind:"fixture.cleaned"});
  }
});
process.send({kind:"fixture.ready"});
`;
type Fixture = Awaited<ReturnType<typeof nativeProjectWorkspaceBridgeFixture>>;
const fixtures: Fixture[] = [];
async function fixture() {
  const f = await nativeProjectWorkspaceBridgeFixture("none", program, {
    beforeBootstrap(base) {
      writeFileSync(
        join(base.dataDirectory, "plugin-profile.json"),
        JSON.stringify({
          schemaVersion: "crewon.desktop-plugin-profile.v1",
          actor,
          scope: {
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            profileId,
          },
        }),
        { mode: 0o600 },
      );
    },
  });
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    try {
      const cleaned = waitMessage(
        f.control,
        (v) => v.kind === "fixture.cleaned",
      );
      f.control.send({ kind: "fixture.cleanup" });
      await cleaned;
    } finally {
      await f.close();
    }
  }
});
async function start(f: Fixture) {
  const prepared = waitMessage(f.control, (v) => v.kind === "fixture.prepared");
  const completed = waitMessage(
    f.control,
    (v) => v.kind === "fixture.completed",
  );
  f.control.send({ kind: "fixture.start" });
  return { preparation: await prepared, completed };
}
describe("genuine project preparation and actual Native allocation", () => {
  it("uses the same full owner from the original project manager for an actual Native allocation", async () => {
    const f = await fixture();
    const bridge = f.bridge();
    const { preparation, completed } = await start(f);
    expect(preparation.packageIdentity).toEqual(f.packageIdentity);
    const observed = waitMessage(
      f.control,
      (v) => v.kind === "fixture.allocated",
    );
    f.control.send({
      kind: "fixture.ticket",
      ticket: f.prepare(bridge, preparation.owner.projectId),
    });
    expect((await observed).output.allocation.workspaceId).toBe(
      preparation.expectedWorkspaceId,
    );
    const result = await completed;
    expect(result.error).toBeUndefined();
    expect(result.output.allocation.workspaceId).toBe(
      preparation.expectedWorkspaceId,
    );
    expect(f.workspaces.root()).toBe(f.ordinary);
    const journal = new LocalWorkspaceProjectAllocationJournal(
      f.dataDirectory,
    ).read();
    expect(journal.state.allocations[0].owner).toEqual(preparation.owner);
    expect(journal.state.allocations[0].phase).toBe("registered");
  });
  it("refuses a copied JSON preparation before Native allocation and preserves the original ticket", async () => {
    const f = await fixture();
    const bridge = f.bridge();
    const ticket = f.prepare(bridge);
    const rejected = waitMessage(
      f.control,
      (v) => v.kind === "fixture.fake-result",
    );
    f.control.send({ kind: "fixture.fake", ticket });
    expect((await rejected).error).toBe(
      "plugin_project_workspace_preparation_unavailable",
    );
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations,
    ).toHaveLength(0);
  });
  it("refuses a result for another project without accepting another project and preserves actual Native files", async () => {
    const f = await fixture();
    const bridge = f.bridge();
    const { completed } = await start(f);
    f.control.send({
      kind: "fixture.ticket",
      ticket: f.prepare(bridge, "wrong-project"),
    });
    const result = await completed;
    expect(result.cause).toBe(
      "desktop_native_project_workspace_client_project_mismatch",
    );
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations,
    ).toHaveLength(1);
  });
  it("rechecks write policy after the Native request and never turns a committed directory into a Thread grant", async () => {
    const f = await fixture();
    const bridge = f.bridge();
    const { preparation, completed } = await start(f);
    const revoke = (v: any) => {
      if (
        v?.schemaVersion ===
        "crewon.desktop-native-project-workspace-request.v1"
      )
        f.control.send({ kind: "fixture.revoke" });
    };
    f.control.on("message", revoke);
    f.control.send({
      kind: "fixture.ticket",
      ticket: f.prepare(bridge, preparation.owner.projectId),
    });
    const result = await completed;
    f.control.removeListener("message", revoke);
    expect(result.error).toBe("creative_project_access_denied");
    expect(
      new LocalWorkspaceProjectAllocationJournal(f.dataDirectory).read().state
        .allocations,
    ).toHaveLength(1);
  });
});
