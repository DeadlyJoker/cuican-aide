import type { OfficeDefinition, ThreadState } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import { officeIdempotencyDigest } from "./office-idempotency-digest.ts";
import type { OfficeApplicationService } from "./office-application-service.ts";
import type {
  OfficeThreadBinding,
  OfficeThreadStore,
} from "./office-thread-store-port.ts";
import { RunStoreError } from "./run-store-port.ts";
import type { ThreadApplicationService } from "./thread-application-service.ts";
import type { ThreadStore } from "./thread-store-port.ts";

type AuthorizationRequest = Parameters<AuthorizationPort["authorize"]>[0];

type Dependencies = Readonly<{
  store: OfficeThreadStore & Pick<ThreadStore, "commitThread">;
  offices: Pick<OfficeApplicationService, "get">;
  threads: Pick<ThreadApplicationService, "getThread">;
  authorization: AuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
}>;
export type OfficeThreadSnapshot = Readonly<{
  office: OfficeDefinition;
  thread: ThreadState | null;
}>;
export type OfficeThreadMutation = Readonly<{
  disposition: "created" | "bound" | "existing";
  office: OfficeDefinition;
  thread: ThreadState;
}>;

/** Office write authority joins Thread authority without using titles as identity. */
export class OfficeThreadApplicationService {
  readonly #dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  async get(
    actor: ActorContext,
    officeVersionId: string,
  ): Promise<OfficeThreadSnapshot> {
    const office = await this.#dependencies.offices.get(actor, officeVersionId);
    return { office, thread: await this.#readBound(actor, office) };
  }

  async create(
    actor: ActorContext,
    command: { officeVersionId: string; idempotencyKey: string },
  ): Promise<OfficeThreadMutation> {
    requireText(command.idempotencyKey, 256, "idempotency_key_invalid");
    const office = await this.#dependencies.offices.get(
      actor,
      command.officeVersionId,
    );
    const existing = await this.#readBound(actor, office);
    if (existing) return { disposition: "existing", office, thread: existing };
    await this.#authorizeOfficeWrite(actor, office);
    await this.#authorize({
      actor,
      action: "thread:create",
      resource: {
        kind: "thread",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: null,
      },
    });
    const threadId = this.#id("thread");
    const occurredAt = this.#dependencies.clock.now();
    const binding = this.#binding(actor, office, threadId, occurredAt);
    const title = `💬 ${Array.from(office.title.trim()).slice(0, 96).join("")}`;
    const scope = canonicalJson([
      actor.tenantId,
      actor.spaceId,
      actor.actorId,
      office.officeId,
    ]);
    let disposition: "created" | "existing" = "created";
    try {
      const result = await this.#dependencies.store.commitThread({
        tenantId: actor.tenantId,
        officeBinding: binding,
        idempotency: {
          scope: `office.thread.create:${officeIdempotencyDigest(this.#dependencies.digester, scope)}`,
          key: command.idempotencyKey,
          requestFingerprint: canonicalJson({
            officeVersionId: office.officeVersionId,
            title,
          }),
        },
        expectedRevision: 0,
        messages: [],
        history: { expectedLastSequence: 0, items: [] },
        events: [
          {
            schemaVersion: "crewon.thread-event.v0",
            identity: { threadId },
            eventId: this.#id("threadEvent"),
            sequence: 1,
            occurredAt,
            type: "thread.created",
            data: {
              tenantId: actor.tenantId,
              spaceId: actor.spaceId,
              createdByActorId: actor.actorId,
              title,
            },
          },
        ],
      });
      if (result.disposition === "replayed") disposition = "existing";
    } catch (error) {
      if (
        error instanceof RunStoreError &&
        error.code === "office_thread_already_bound"
      )
        disposition = "existing";
      else throw storeError(error);
    }
    const thread = await this.#readBound(actor, office);
    if (thread === null)
      throw new ApplicationError("internal", "office_thread_binding_missing");
    return { disposition, office, thread };
  }

  async bind(
    actor: ActorContext,
    command: {
      officeVersionId: string;
      threadId: string;
      expectedRevision: number;
    },
  ): Promise<OfficeThreadMutation> {
    requireText(command.threadId, 128, "thread_id_invalid");
    if (
      !Number.isSafeInteger(command.expectedRevision) ||
      command.expectedRevision < 1
    )
      throw new ApplicationError(
        "validation",
        "office_thread_revision_invalid",
      );
    const office = await this.#dependencies.offices.get(
      actor,
      command.officeVersionId,
    );
    await this.#authorizeOfficeWrite(actor, office);
    const thread = await this.#dependencies.threads.getThread(
      actor,
      command.threadId,
    );
    await this.#authorize({
      actor,
      action: "thread:message:append",
      resource: {
        kind: "thread",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: thread.threadId,
      },
    });
    try {
      const result = await this.#dependencies.store.bindOfficeThread({
        binding: this.#binding(
          actor,
          office,
          thread.threadId,
          this.#dependencies.clock.now(),
        ),
        expectedThreadRevision: command.expectedRevision,
      });
      const current = await this.#readBound(actor, office);
      if (current === null)
        throw new ApplicationError("internal", "office_thread_binding_missing");
      return { disposition: result.disposition, office, thread: current };
    } catch (error) {
      throw storeError(error);
    }
  }

  async #readBound(
    actor: ActorContext,
    office: OfficeDefinition,
  ): Promise<ThreadState | null> {
    let binding: OfficeThreadBinding | null;
    try {
      binding = await this.#dependencies.store.loadOfficeThreadBinding(office);
    } catch (error) {
      throw storeError(error);
    }
    if (binding === null) return null;
    if (
      binding.tenantId !== actor.tenantId ||
      binding.spaceId !== actor.spaceId ||
      binding.officeId !== office.officeId
    )
      throw new ApplicationError("internal", "office_thread_binding_mismatch");
    // A deleted or inaccessible bound Thread must never become permission to create a replacement.
    return this.#dependencies.threads.getThread(actor, binding.threadId);
  }

  #binding(
    actor: ActorContext,
    office: OfficeDefinition,
    threadId: string,
    boundAt: string,
  ): OfficeThreadBinding {
    return {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      officeId: office.officeId,
      officeVersionId: office.officeVersionId,
      threadId,
      boundByActorId: actor.actorId,
      boundAt,
    };
  }

  #authorizeOfficeWrite(
    actor: ActorContext,
    office: OfficeDefinition,
  ): Promise<void> {
    // Existing Office revisions already use office:create as Office editing authority.
    return this.#authorize({
      actor,
      action: "office:create",
      resource: {
        kind: "office",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        officeId: office.officeId,
        officeVersionId: office.officeVersionId,
      },
    });
  }

  async #authorize(request: AuthorizationRequest): Promise<void> {
    const decision = await this.#dependencies.authorization.authorize(request);
    if (decision.outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
  }

  #id(kind: "thread" | "threadEvent"): string {
    const value = this.#dependencies.ids.nextId(kind);
    requireText(value, 128, `${kind}_id_invalid`);
    return value;
  }
}

function requireText(value: unknown, max: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new ApplicationError("validation", code);
}
function storeError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  const code =
    error instanceof RunStoreError ? error.code : "office_thread_store_error";
  const category = [
    "revision_conflict",
    "idempotency_conflict",
    "office_thread_already_bound",
    "office_thread_already_claimed",
    "office_thread_not_eligible",
  ].includes(code)
    ? "conflict"
    : ["office_thread_office_not_found", "office_thread_not_found"].includes(
          code,
        )
      ? "notFound"
      : "internal";
  return new ApplicationError(category, code, { cause: error });
}
