import type {
  CommitOfficeDefinitionInput,
  OfficeDefinitionStore,
  OfficeListCursor,
  OfficeLocator,
} from "@crewon/application";
import type { OfficeDefinition } from "@crewon/domain";

export class InMemoryOfficeStore implements OfficeDefinitionStore {
  private readonly definitions = new Map<string, OfficeDefinition>();
  private readonly receipts = new Map<
    string,
    { digest: string; officeVersionId: string }
  >();
  async commitOfficeDefinition(input: CommitOfficeDefinitionInput) {
    const value = input.definition;
    const key = [
      value.tenantId,
      value.spaceId,
      input.receipt.actorId,
      input.receipt.idempotencyKey,
    ].join("\0");
    const receipt = this.receipts.get(key);
    if (receipt !== undefined) {
      if (receipt.digest !== input.receipt.requestDigest)
        throw new Error("office_idempotency_conflict");
      const definition = this.definitions.get(receipt.officeVersionId);
      if (definition === undefined) throw new Error("office_receipt_corrupt");
      return { disposition: "replayed" as const, definition };
    }
    const latest = [...this.definitions.values()]
      .filter(
        (item) =>
          item.tenantId === value.tenantId &&
          item.spaceId === value.spaceId &&
          item.officeId === value.officeId,
      )
      .reduce((revision, item) => Math.max(revision, item.revision), 0);
    if (latest !== input.expectedRevision)
      throw new Error("office_revision_conflict");
    this.definitions.set(value.officeVersionId, structuredClone(value));
    this.receipts.set(key, {
      digest: input.receipt.requestDigest,
      officeVersionId: value.officeVersionId,
    });
    return {
      disposition: "created" as const,
      definition: structuredClone(value),
    };
  }
  async loadOfficeDefinition(locator: OfficeLocator) {
    const value = this.definitions.get(locator.officeVersionId);
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
    return [...this.definitions.values()]
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
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.officeVersionId.localeCompare(a.officeVersionId),
      )
      .slice(0, input.limit)
      .map((value) => structuredClone(value));
  }
}
