import type {
  ActorContext,
  AutomationApplicationService,
} from "@crewon/application";
import type { AutomationView } from "@crewon/contracts";
import type { AutomationDefinition } from "@crewon/domain";
import { projectAutomation } from "./automation-projection.ts";

export async function projectAutomationWithReadiness(
  automations: AutomationApplicationService,
  actor: ActorContext,
  definition: AutomationDefinition,
): Promise<AutomationView> {
  const view = projectAutomation(definition);
  if (!definition.skillBinding) return view;
  return {
    ...view,
    skillReadiness: await automations.checkAutomationReadiness(
      actor,
      definition.automationId,
    ),
  };
}
