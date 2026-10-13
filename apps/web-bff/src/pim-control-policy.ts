import type { PimControlActor } from "./pim-control-sessions.ts";

const actions: Readonly<Record<string, readonly string[]>> = {
  thread: [
    "thread:create",
    "thread:read",
    "thread:message:append",
    "thread:goal:read",
    "thread:goal:write",
    "thread:fork",
    "thread:archive",
    "thread:unarchive",
    "thread:rename",
    "thread:delete",
    "thread:compact",
    "thread:rollback",
    "thread:workspace:read",
    "thread:workspace:write",
    "thread:audit:read",
  ],
  run: ["run:create", "run:read", "run:execute", "run:cancel"],
  toolApproval: ["toolApproval:read", "toolApproval:decide"],
  agentVersion: [
    "agentVersion:publish",
    "agentVersion:deploy",
    "agentVersion:read",
    "agentVersion:list",
  ],
  workflowVersion: [
    "workflowVersion:publish",
    "workflowVersion:read",
    "workflowVersion:list",
  ],
  office: ["office:create", "office:read", "office:list", "office:run"],
  artifact: ["artifact:read"],
  knowledge: ["knowledge:create", "knowledge:read"],
  modelProviderSettings: [
    "modelProviderSettings:read",
    "modelProviderSettings:write",
    "modelProviderSettings:probe",
  ],
  extension: [
    "extension:read",
    "extension:configure",
    "extension:activate",
    "extension:run",
    "extension:query",
  ],
  creativeProject: [
    "creativeProject:create",
    "creativeProject:list",
    "creativeProject:read",
    "creativeProject:write",
  ],
  automation: ["automation:create", "automation:read", "automation:run"],
  pluginCredit: ["pluginCredit:read"],
  projectSourceUpload: [
    "projectSourceUpload:begin",
    "projectSourceUpload:write",
    "projectSourceUpload:status",
    "projectSourceUpload:prepare",
    "projectSourceUpload:cancel",
    "projectSourceUpload:adopt",
  ],
};
/** Current host policy for an already verified workspace member. New/unknown
 * action kinds never inherit access from a broad allow or from their name prefix.
 */
export function pimControlPolicy(input: {
  actor: PimControlActor;
  action: string;
  resource: Record<string, unknown>;
  spaceRole: string;
}) {
  const deny = (reasonCode: string) => ({
    outcome: "deny" as const,
    reasonCode,
  });
  const kind = input.resource.kind;
  if (
    typeof kind !== "string" ||
    !Object.hasOwn(actions, kind) ||
    !actions[kind]!.includes(input.action)
  )
    return deny("control_action_denied");
  const owner =
    kind === "projectSourceUpload" ? input.resource.owner : input.resource;
  if (!owner || typeof owner !== "object" || Array.isArray(owner))
    return deny("control_scope_mismatch");
  const scope = owner as Record<string, unknown>;
  if (
    scope.tenantId !== input.actor.tenantId ||
    scope.spaceId !== input.actor.spaceId
  )
    return deny("control_scope_mismatch");
  if (
    kind === "projectSourceUpload" &&
    scope.principalId !== input.actor.principalId
  )
    return deny("control_principal_mismatch");
  if (
    kind === "pluginCredit" &&
    input.resource.principalId !== input.actor.principalId
  )
    return deny("control_principal_mismatch");
  const write =
    !input.action.endsWith(":read") &&
    !input.action.endsWith(":list") &&
    !input.action.endsWith(":query");
  const readOnlyStatus = input.action === "projectSourceUpload:status";
  if (
    write &&
    !readOnlyStatus &&
    !["owner", "admin", "developer", "member"].includes(input.spaceRole)
  )
    return deny("control_read_only");
  if (
    [
      "agentVersion:publish",
      "agentVersion:deploy",
      "workflowVersion:publish",
      "modelProviderSettings:write",
    ].includes(input.action) &&
    !["owner", "admin"].includes(input.spaceRole)
  )
    return deny("control_administration_denied");
  if (
    kind === "artifact" &&
    input.resource.ownerActorId !== input.actor.actorId &&
    !["owner", "admin"].includes(input.spaceRole)
  )
    return deny("control_artifact_owner_mismatch");
  return { outcome: "allow" as const };
}
