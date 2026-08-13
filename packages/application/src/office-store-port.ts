import type { OfficeDefinition } from "@crewon/domain";

export type OfficeLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  officeVersionId: string;
}>;

export type OfficeListCursor = Readonly<{
  createdAt: string;
  officeVersionId: string;
}>;

export type CommitOfficeDefinitionInput = Readonly<{
  definition: OfficeDefinition;
  expectedRevision: number;
  receipt: Readonly<{
    actorId: string;
    idempotencyKey: string;
    requestDigest: string;
  }>;
}>;

export type CommitOfficeDefinitionResult = Readonly<{
  disposition: "created" | "replayed";
  definition: OfficeDefinition;
}>;

/** Durable immutable Office authority with receipt-first CAS creation. */
export interface OfficeDefinitionStore {
  commitOfficeDefinition(
    input: CommitOfficeDefinitionInput,
  ): Promise<CommitOfficeDefinitionResult>;
  loadOfficeDefinition(
    locator: OfficeLocator,
  ): Promise<OfficeDefinition | null>;
  listOfficeDefinitions(input: {
    tenantId: string;
    spaceId: string;
    before: OfficeListCursor | null;
    limit: number;
  }): Promise<readonly OfficeDefinition[]>;
}
