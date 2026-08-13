import { createHash } from "node:crypto";

import { OFFICE_LIMITS, type OfficeDefinition } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { ApplicationClock, ApplicationIdGenerator } from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort, OfficeAuthorizationAction } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { AgentVersionStore } from "./agent-version-store-port.ts";
import type { OfficeDefinitionStore, OfficeListCursor } from "./office-store-port.ts";

export type CreateOfficeCommand = Readonly<{
  idempotencyKey: string;
  officeId: string | null;
  expectedRevision: number;
  title: string;
  members: OfficeDefinition["members"];
  executionTargets: OfficeDefinition["executionTargets"];
}>;

export class OfficeApplicationService {
  constructor(private readonly dependencies: {
    store: OfficeDefinitionStore & AgentVersionStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
  }) {}

  async create(actor: ActorContext, command: CreateOfficeCommand) {
    validateActor(actor);
    validateCreate(command);
    await this.authorize(actor, "office:create", command.officeId, null);
    for (const agentVersionId of referencedAgentVersions(command)) {
      if (await this.dependencies.store.loadAgentVersion({ tenantId: actor.tenantId, agentVersionId }) === null) {
        throw new ApplicationError("validation", "office_agent_version_not_published");
      }
    }
    const officeId = command.officeId ?? this.nextId("office");
    const definition: OfficeDefinition = {
      schemaVersion: "crewon.office-definition.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      officeId,
      officeVersionId: this.nextId("officeVersion"),
      revision: command.expectedRevision + 1,
      title: command.title,
      members: command.members,
      executionTargets: command.executionTargets,
      createdByActorId: actor.actorId,
      createdAt: this.dependencies.clock.now(),
    };
    const requestDigest = createHash("sha256").update(canonicalJson(command)).digest("hex");
    try {
      return await this.dependencies.store.commitOfficeDefinition({
        definition,
        expectedRevision: command.expectedRevision,
        receipt: { actorId: actor.actorId, idempotencyKey: command.idempotencyKey, requestDigest },
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async get(actor: ActorContext, officeVersionId: string): Promise<OfficeDefinition> {
    validateActor(actor); requireText(officeVersionId, 128, "office_version_id_invalid");
    const definition = await this.dependencies.store.loadOfficeDefinition({ tenantId: actor.tenantId, spaceId: actor.spaceId, officeVersionId });
    if (definition === null) throw new ApplicationError("notFound", "office_not_found");
    await this.authorize(actor, "office:read", definition.officeId, officeVersionId);
    return definition;
  }

  async list(actor: ActorContext, query: { before: OfficeListCursor | null; limit: number }) {
    validateActor(actor);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > OFFICE_LIMITS.list) {
      throw new ApplicationError("validation", "office_list_limit_invalid");
    }
    await this.authorize(actor, "office:list", null, null);
    return this.dependencies.store.listOfficeDefinitions({ tenantId: actor.tenantId, spaceId: actor.spaceId, ...query });
  }

  async authorizeRun(actor: ActorContext, officeVersionId: string, targetId: string) {
    const definition = await this.get(actor, officeVersionId);
    await this.authorize(actor, "office:run", definition.officeId, officeVersionId);
    const target = definition.executionTargets.find((candidate) => candidate.targetId === targetId);
    if (target === undefined) throw new ApplicationError("notFound", "office_target_not_found");
    return target;
  }

  private async authorize(actor: ActorContext, action: OfficeAuthorizationAction, officeId: string | null, officeVersionId: string | null) {
    const decision = await this.dependencies.authorization.authorize({ actor, action, resource: { kind: "office", tenantId: actor.tenantId, spaceId: actor.spaceId, officeId, officeVersionId } });
    if (decision.outcome !== "allow") throw new ApplicationError("authorization", "authorization_denied");
  }

  private nextId(kind: "office" | "officeVersion") {
    const id = this.dependencies.ids.nextId(kind);
    requireText(id, 128, `${kind}_id_invalid`);
    return id;
  }
}

function validateActor(actor: ActorContext) { for (const value of [actor.actorId, actor.principalId, actor.tenantId, actor.spaceId]) requireText(value, 128, "actor_invalid"); }
function validateCreate(command: CreateOfficeCommand) {
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw new ApplicationError("validation", "office_revision_invalid");
  requireText(command.idempotencyKey, 200, "idempotency_key_invalid"); requireText(command.title, OFFICE_LIMITS.title, "office_title_invalid");
  if (command.officeId !== null) requireText(command.officeId, 128, "office_id_invalid");
  if (command.members.length > OFFICE_LIMITS.members || command.executionTargets.length < 1 || command.executionTargets.length > OFFICE_LIMITS.targets) throw new ApplicationError("validation", "office_collection_bounds_invalid");
  const ids = new Set<string>();
  for (const member of command.members) { requireText(member.memberId, 128, "office_member_invalid"); requireText(member.displayName, 160, "office_member_invalid"); requireText(member.agentVersionId, 128, "office_member_invalid"); if (ids.has(member.memberId)) throw new ApplicationError("validation", "office_member_duplicate"); ids.add(member.memberId); }
  ids.clear(); for (const target of command.executionTargets) { requireText(target.targetId, 128, "office_target_invalid"); requireText(target.agentVersionId, 128, "office_target_invalid"); if (ids.has(target.targetId)) throw new ApplicationError("validation", "office_target_duplicate"); ids.add(target.targetId); }
}
function referencedAgentVersions(command: CreateOfficeCommand) { return new Set([...command.members.map((value) => value.agentVersionId), ...command.executionTargets.map((value) => value.agentVersionId)]); }
function requireText(value: unknown, max: number, code: string): asserts value is string { if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value) throw new ApplicationError("validation", code); }
function mapStoreError(error: unknown) { const code = error instanceof Error ? error.message : "office_store_unavailable"; if (code.includes("conflict") || code.includes("idempotency")) return new ApplicationError("conflict", code); return new ApplicationError("internal", "office_store_unavailable", { cause: error }); }
