import {
  DemonstratedSkillService,
  RecordingSkillImporter,
  SkillDraftGenerationService,
  resolveAutomationSkillForRun,
  type ActorContext,
  type AgentVersionStore,
  type ApplicationClock,
  type AutomationStore,
  type ContentDigester,
  type ModelCallStore,
  type RunApplicationService,
  type RunRouteResolverPort,
  type RunStore,
  type ThreadStore,
  type TurnApplicationService,
} from "@crewon/application";
import {
  SqliteDemonstratedSkillStore,
  SqliteSkillDraftGenerationStore,
  SqliteSkillRecordingStore,
} from "@crewon/store";
import { createConfiguredSkillGenerationRouteResolver } from "./skill-generation-route-resolver.ts";
import { randomUUID } from "node:crypto";
import {
  ConfiguredSkillExecutionAuthorization,
  StoreBackedSkillRunEvidence,
} from "./demonstrated-skill-adapters.ts";

export function createStandaloneSkillHost(input: {
  databasePath: string;
  generationAgentVersionId?: string;
  deliveryTargets?: DemonstratedSkillService["dependencies"]["deliveryTargets"];
  actor: ActorContext;
  store: AgentVersionStore &
    ModelCallStore &
    AutomationStore &
    Pick<RunStore, "loadRun"> &
    Pick<ThreadStore, "loadThreadInSpace" | "messageWindows">;
  turns: TurnApplicationService;
  routes: RunRouteResolverPort;
  application: RunApplicationService;
  digester: ContentDigester;
  clock: ApplicationClock;
}) {
  const store = new SqliteDemonstratedSkillStore(
    input.databasePath,
    input.digester,
  );
  let recordings: SqliteSkillRecordingStore | undefined;
  let generationStore: SqliteSkillDraftGenerationStore | undefined;
  try {
    recordings = new SqliteSkillRecordingStore(input.databasePath);
    generationStore = new SqliteSkillDraftGenerationStore(input.databasePath);
    const evidence = new StoreBackedSkillRunEvidence({
      application: input.application,
      store: input.store,
    });
    const skills = new DemonstratedSkillService({
      store,
      recording: new RecordingSkillImporter(recordings),
      authorization: new ConfiguredSkillExecutionAuthorization({
        actor: input.actor,
        agentVersions: input.store,
        digester: input.digester,
      }),
      evidence,
      deliveryTargets: input.deliveryTargets,
      scheduledInvocations: {
        resolveForRun: (actor, runId) =>
          resolveAutomationSkillForRun(
            { store: input.store, digester: input.digester },
            actor,
            runId,
          ),
      },
      turns: input.turns,
      routes: input.routes,
      digester: input.digester,
      clock: input.clock,
      nextId: () => randomUUID(),
    });
    const generations = new SkillDraftGenerationService({
      store: generationStore,
      skills,
      turns: input.turns,
      routes: createConfiguredSkillGenerationRouteResolver({
        routes: input.routes,
        store: input.store,
        digester: input.digester,
        generationAgentVersionId: input.generationAgentVersionId,
      }),
      threads: input.store,
      evidence,
      digester: input.digester,
      clock: input.clock,
    });
    return {
      skills,
      recordings,
      generations,
      async close() {
        await generationStore?.close();
        await recordings?.close();
        await store.close();
      },
    };
  } catch (error) {
    void generationStore?.close();
    void recordings?.close();
    void store.close();
    throw error;
  }
}
