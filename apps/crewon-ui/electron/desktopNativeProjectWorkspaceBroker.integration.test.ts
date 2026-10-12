import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import {
  nativeProjectWorkspaceBridgeFixture,
  waitMessage,
} from "./desktopNativeProjectWorkspaceBridge.test-support.ts";
const profileId = "00000000-0000-4000-8000-000000000001";
const clientUrl = new URL(
  "../../control-api/src/desktop-native-project-workspace-client.ts",
  import.meta.url,
).href;
const fixtureUrl = new URL(
  "../../../packages/store/src/project-workspace-preparation.test-support.ts",
  import.meta.url,
).href;
const program = `
const {workspacePreparationUiFixture}=await import(${JSON.stringify(fixtureUrl)});
const {DesktopNativeProjectWorkspaceClient}=await import(${JSON.stringify(clientUrl)});
let f;const client=new DesktopNativeProjectWorkspaceClient({signal:new AbortController().signal,deadlineMs:2000});
process.on('message',async message=>{
 if(message?.kind==='fixture.start'){
  try{
   f=await workspacePreparationUiFixture({actor:${JSON.stringify(actor)},profileId:${JSON.stringify(profileId)},packageIdentity:message.packageIdentity,databasePath:message.databasePath});
   f.state.callback=async preparation=>{
    if(message.withdraw)f.state.policyAllowed=false;
    const observation=await client.observePreparedProject(preparation);
    return f.createConversation(observation);
   };
   const output=await f.invoke();
   process.send({kind:'fixture.completed',output,namespaces:f.namespaceCount(),threads:f.threadCount()});
  }catch(error){process.send({kind:'fixture.completed',error:error.code??error.message,namespaces:f?.namespaceCount()??0,threads:f?.threadCount()??0});}
 }else if(message?.kind==='fixture.fake'){
  try{await client.observePreparedProject({version:'crewon.plugin-project-workspace-preparation.v1'});}
  catch(error){process.send({kind:'fixture.fake-result',error:error.code??error.message});}
 }else if(message?.kind==='fixture.cleanup'){
  await client.close();await f?.close();process.send({kind:'fixture.cleaned'});
 }
});process.send({kind:'fixture.ready'});
`;
const fixtures: Awaited<
  ReturnType<typeof nativeProjectWorkspaceBridgeFixture>
>[] = [];
async function fixture() {
  const f = await nativeProjectWorkspaceBridgeFixture("none", program, {
    beforeBootstrap(f) {
      writeFileSync(
        join(f.dataDirectory, "plugin-profile.json"),
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
  f.bridge();
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    try {
      const cleaned = waitMessage(
        f.control,
        (value) => value.kind === "fixture.cleaned",
      );
      f.control.send({ kind: "fixture.cleanup" });
      await cleaned;
    } finally {
      await f.close();
    }
  }
});
it("genuine Control UI requests its own Main ticket and reaches the original namespace and Thread without fixture ticket forwarding", async () => {
  const f = await fixture();
  const completed = waitMessage(
    f.control,
    (value) => value.kind === "fixture.completed",
  );
  f.control.send({
    kind: "fixture.start",
    packageIdentity: f.packageIdentity,
    databasePath: join(f.dataDirectory, "control.sqlite"),
  });
  const result = await completed;
  expect(result.error).toBeUndefined();
  expect(result.namespaces).toBe(1);
  expect(result.threads).toBe(1);
  expect(result.output.disposition).toBe("committed");
  expect(f.workspaces.status().workspaces).toHaveLength(2);
  expect(f.workspaces.root()).toBe(f.ordinary);
});
it("copied preparations and independent project-policy withdrawal cannot request a Native allocation", async () => {
  const f = await fixture();
  const fake = waitMessage(
    f.control,
    (value) => value.kind === "fixture.fake-result",
  );
  f.control.send({ kind: "fixture.fake" });
  expect((await fake).error).toBe(
    "plugin_project_workspace_preparation_unavailable",
  );
  const completed = waitMessage(
    f.control,
    (value) => value.kind === "fixture.completed",
  );
  f.control.send({
    kind: "fixture.start",
    withdraw: true,
    packageIdentity: f.packageIdentity,
    databasePath: join(f.dataDirectory, "control.sqlite"),
  });
  const result = await completed;
  expect(result.error).toBe("creative_project_access_denied");
  expect(result.namespaces).toBe(0);
  expect(result.threads).toBe(0);
  expect(f.workspaces.status().workspaces).toHaveLength(1);
});
