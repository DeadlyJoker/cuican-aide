import { parseKnowledgeRecord, type KnowledgeRecord } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  KnowledgeCreateResult,
  KnowledgePage,
  KnowledgeStore,
} from "./knowledge-store-port.ts";

export type CreateKnowledgeCommand = Readonly<{
  idempotencyKey: string;
  kind: "memory" | "source";
  sourceId: string;
  title: string;
  content: string;
}>;
type KnowledgeApplicationDependencies = Readonly<{
  store: KnowledgeStore;
  authorization: AuthorizationPort;
  ids: ApplicationIdGenerator;
  clock: ApplicationClock;
  digester: ContentDigester;
}>;

export class KnowledgeApplicationService {
  readonly #dependencies: KnowledgeApplicationDependencies;
  constructor(dependencies: KnowledgeApplicationDependencies) {
    this.#dependencies = dependencies;
  }

  async create(
    actor: ActorContext,
    command: CreateKnowledgeCommand,
  ): Promise<KnowledgeCreateResult> {
    validateActor(actor);
    if (
      typeof command.idempotencyKey !== "string" ||
      command.idempotencyKey.length < 1 ||
      command.idempotencyKey.length > 256
    )
      throw new ApplicationError("validation", "idempotency_key_invalid");
    await this.authorize(actor, "knowledge:create", null);
    const semantic = {
      content: command.content,
      kind: command.kind,
      sourceId: command.sourceId,
      title: command.title,
    };
    const idempotency = {
      scope: `knowledge.create:${actor.spaceId}`,
      key: command.idempotencyKey,
      requestFingerprint: this.#dependencies.digester.sha256(
        canonicalJson(semantic),
      ),
    };
    const prior = await this.#dependencies.store.loadKnowledgeReceipt({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      idempotency,
    });
    if (prior !== null) return prior;
    let record: KnowledgeRecord;
    try {
      record = parseKnowledgeRecord({
        schemaVersion: "crewon.knowledge.v0",
        knowledgeId: this.#dependencies.ids.nextId("knowledge"),
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        ownerActorId: actor.actorId,
        ...semantic,
        contentDigest: this.#dependencies.digester.sha256(command.content),
        createdAt: this.#dependencies.clock.now(),
      });
    } catch (error) {
      throw mapError(error);
    }
    return this.#dependencies.store.commitKnowledge({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      idempotency,
      record,
    });
  }

  async get(
    actor: ActorContext,
    knowledgeId: string,
  ): Promise<KnowledgeRecord> {
    validateActor(actor);
    await this.authorize(actor, "knowledge:read", knowledgeId);
    const record = await this.#dependencies.store.loadKnowledge({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      knowledgeId,
    });
    if (record === null)
      throw new ApplicationError("notFound", "knowledge_not_found");
    return record;
  }

  async list(
    actor: ActorContext,
    query: Readonly<{
      before: { createdAt: string; knowledgeId: string } | null;
      limit: number;
    }>,
  ): Promise<KnowledgePage> {
    validateActor(actor);
    await this.authorize(actor, "knowledge:read", null);
    return this.#dependencies.store.listKnowledge({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      ...query,
    });
  }

  private async authorize(
    actor: ActorContext,
    action: "knowledge:create" | "knowledge:read",
    knowledgeId: string | null,
  ): Promise<void> {
    const decision = await this.#dependencies.authorization.authorize({
      actor,
      action,
      resource: {
        kind: "knowledge",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        knowledgeId,
      },
    });
    if (decision.outcome === "deny")
      throw new ApplicationError("authorization", decision.reasonCode);
  }
}

function validateActor(actor: ActorContext): void {
  if (
    [actor.principalId, actor.actorId, actor.tenantId, actor.spaceId].some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  )
    throw new ApplicationError("validation", "actor_context_invalid");
}
function mapError(error: unknown): ApplicationError {
  return new ApplicationError(
    "validation",
    error instanceof Error ? error.message : "knowledge_record_invalid",
    { cause: error },
  );
}
