import type { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";
import { skillJson, type AutomationDefinition } from "@crewon/domain";
import { requireSqliteSkillVersion } from "./sqlite-skill-admission.ts";

/** No optional fallback: local Skill-backed writes need the same database authority. */
export function assertSqliteAutomationSkillAllowed(
  database: DatabaseSync,
  definition: AutomationDefinition,
  ownerActorId: string,
): void {
  const binding = definition.skillBinding;
  if (!binding) return;
  const { version } = requireSqliteSkillVersion(database, {
    locator: {
      tenantId: definition.tenantId,
      spaceId: definition.spaceId,
      ownerActorId,
      skillId: binding.invocation.skill.skillId,
    },
    ref: binding.invocation.skill,
    purpose: "execute",
  });
  if (skillJson(version) !== skillJson(binding.version))
    throw new RunStoreError("automation_skill_snapshot_mismatch");
}
