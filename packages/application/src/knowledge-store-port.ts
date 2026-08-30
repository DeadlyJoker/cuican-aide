import type { KnowledgeRecord } from "@crewon/domain";
import type { IdempotencyDescriptor } from "./run-store-port.ts";

export type KnowledgeLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  knowledgeId: string;
}>;
export type KnowledgeCursor = Readonly<{
  createdAt: string;
  knowledgeId: string;
}>;
export type KnowledgeListQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  before: KnowledgeCursor | null;
  limit: number;
}>;
export type KnowledgePage = Readonly<{
  data: readonly KnowledgeRecord[];
  next: KnowledgeCursor | null;
}>;
export type KnowledgeCreateResult = Readonly<{
  disposition: "committed" | "replayed";
  record: KnowledgeRecord;
}>;
export type KnowledgeReceiptQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  idempotency: IdempotencyDescriptor;
}>;
export type CommitKnowledgeInput = KnowledgeReceiptQuery &
  Readonly<{ record: KnowledgeRecord }>;

/** Durable tenant/space Knowledge authority; implementations atomically commit records and receipts. */
export interface KnowledgeStore {
  loadKnowledgeReceipt(
    query: KnowledgeReceiptQuery,
  ): Promise<KnowledgeCreateResult | null>;
  commitKnowledge(input: CommitKnowledgeInput): Promise<KnowledgeCreateResult>;
  loadKnowledge(locator: KnowledgeLocator): Promise<KnowledgeRecord | null>;
  listKnowledge(query: KnowledgeListQuery): Promise<KnowledgePage>;
}
