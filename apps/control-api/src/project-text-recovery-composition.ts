import {
  PluginProjectTextRecoveryApplicationService,
  type CreativeProjectAuthorizationPort,
  type CreativeProjectStore,
  type ProjectTextUiIntentJournalStore,
} from "@crewon/application";
import type { ProjectTextPluginUiConfig } from "./project-text-plugin-ui-composition.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";

export type ProjectTextRecoveryStoreOwner = Readonly<{
  projectTextUiIntentJournalStore?(): ProjectTextUiIntentJournalStore & {
    migrate(): Promise<void>;
  };
}>;

/** An explicit metadata opt-in alone opens the independent journal on the original parent Store. */
export async function prepareProjectTextRecovery(
  owner: ProjectTextRecoveryStoreOwner,
  input: Readonly<{
    configuration: ProjectTextPluginUiConfig | undefined;
    projects: Pick<CreativeProjectStore, "loadProject">;
    authorization: CreativeProjectAuthorizationPort;
  }>,
): Promise<PluginProjectTextRecoveryApplicationService | undefined> {
  if (input.configuration === undefined) return undefined;
  if (owner.projectTextUiIntentJournalStore === undefined)
    throw new Error("project_text_recovery_store_required");
  const journal = owner.projectTextUiIntentJournalStore();
  await journal.migrate();
  return new PluginProjectTextRecoveryApplicationService({
    journal,
    projects: input.projects,
    authorization: input.authorization,
    publications: input.configuration.publications,
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
    digester: new NodeSha256ContentDigester(),
  });
}
