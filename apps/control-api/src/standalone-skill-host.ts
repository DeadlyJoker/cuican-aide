import { DemonstratedSkillService, RecordingSkillImporter, type ActorContext, type AgentVersionStore, type ApplicationClock, type ContentDigester, type ModelCallStore, type RunApplicationService, type RunRouteResolverPort, type TurnApplicationService } from "@crewon/application";
import { SqliteDemonstratedSkillStore, SqliteSkillRecordingStore } from "@crewon/store";
import { randomUUID } from "node:crypto";
import { ConfiguredSkillExecutionAuthorization, StoreBackedSkillRunEvidence } from "./demonstrated-skill-adapters.ts";

export function createStandaloneSkillHost(input: {
  databasePath: string;
  actor: ActorContext;
  store: AgentVersionStore & ModelCallStore;
  turns: TurnApplicationService;
  routes: RunRouteResolverPort;
  application: RunApplicationService;
  digester: ContentDigester;
  clock: ApplicationClock;
}) {
  const store = new SqliteDemonstratedSkillStore(input.databasePath,input.digester);
  let recordings: SqliteSkillRecordingStore;
  try { recordings=new SqliteSkillRecordingStore(input.databasePath); } catch(error) {void store.close();throw error;}
  const skills = new DemonstratedSkillService({
    store, recording: new RecordingSkillImporter(recordings),
    authorization: new ConfiguredSkillExecutionAuthorization({actor:input.actor,agentVersions:input.store,digester:input.digester}),
    evidence: new StoreBackedSkillRunEvidence({application:input.application,store:input.store}),
    turns:input.turns,routes:input.routes,digester:input.digester,clock:input.clock,nextId:()=>randomUUID(),
  });
  return {skills,recordings, async close(){await recordings.close();await store.close();}};
}
