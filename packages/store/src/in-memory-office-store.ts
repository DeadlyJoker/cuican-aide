import type {
  CommitOfficeDefinitionInput,
  OfficeDefinitionStore,
  OfficeListCursor,
  OfficeLocator,
} from "@crewon/application";
import { parseOfficeDefinition, type OfficeDefinition } from "@crewon/domain";

export class InMemoryOfficeStore implements OfficeDefinitionStore {
  readonly #definitions = new Map<string, OfficeDefinition>();
  readonly #receipts = new Map<
    string,
    { digest: string; officeVersionId: string }
  >();

  async commitOfficeDefinition(input: CommitOfficeDefinitionInput) {
    const value = validateCommit(input);
    const receiptKey = [
      value.tenantId,
      value.spaceId,
      input.receipt.actorId,
      input.receipt.idempotencyKey,
    ].join("\0");
    const receipt = this.#receipts.get(receiptKey);
    if (receipt !== undefined) {
      if (receipt.digest !== input.receipt.requestDigest) {
        throw new Error("office_idempotency_conflict");
      }
      const definition = this.#definitions.get(receipt.officeVersionId);
      if (definition === undefined) throw new Error("office_receipt_corrupt");
      return {
        disposition: "replayed" as const,
        definition: structuredClone(definition),
      };
    }

    const latestRevision = [...this.#definitions.values()]
      .filter(
        (item) =>
          item.tenantId === value.tenantId &&
          item.spaceId === value.spaceId &&
          item.officeId === value.officeId,
      )
      .reduce((revision, item) => Math.max(revision, item.revision), 0);
    if (latestRevision !== input.expectedRevision) {
      throw new Error("office_revision_conflict");
    }

    this.#definitions.set(value.officeVersionId, structuredClone(value));
    this.#receipts.set(receiptKey, {
      digest: input.receipt.requestDigest,
      officeVersionId: value.officeVersionId,
    });
    return {
      disposition: "created" as const,
      definition: structuredClone(value),
    };
  }

  async loadOfficeDefinition(locator: OfficeLocator) {
    const value = this.#definitions.get(locator.officeVersionId);
    return value?.tenantId === locator.tenantId &&
      value.spaceId === locator.spaceId
      ? structuredClone(value)
      : null;
  }

  async listOfficeDefinitions(input: {
    tenantId: string;
    spaceId: string;
    before: OfficeListCursor | null;
    limit: number;
  }) {
    return [...this.#definitions.values()]
      .filter(
        (value) =>
          value.tenantId === input.tenantId &&
          value.spaceId === input.spaceId &&
          (input.before === null ||
            value.createdAt < input.before.createdAt ||
            (value.createdAt === input.before.createdAt &&
              value.officeVersionId < input.before.officeVersionId)),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.officeVersionId.localeCompare(left.officeVersionId),
      )
      .slice(0, input.limit)
      .map((value) => structuredClone(value));
  }
}

function validateCommit(input: CommitOfficeDefinitionInput) {
  const value = parseOfficeDefinition(input.definition);
  if (
    value.revision !== input.expectedRevision + 1 ||
    value.createdByActorId !== input.receipt.actorId
  ) {
    throw new Error("office_commit_authority_mismatch");
  }
  return value;
}
