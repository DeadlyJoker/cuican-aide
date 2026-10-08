import type { DatabaseSync } from "node:sqlite";
import { SqliteExtensionStore } from "./sqlite-extension-store.ts";
import { SqliteExternalOperationStore } from "./sqlite-external-operation-store.ts";
import { SqlitePluginCreditStore } from "./sqlite-plugin-credit-store.ts";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { SqliteProjectFoundationStore } from "./project-foundation-sqlite-store.ts";

/** Keeps plugin construction separate from the core Run orchestration module. */
export function createSqliteExtensionStore(
  input: ConstructorParameters<typeof SqliteExtensionStore>[1] & {
    database: DatabaseSync;
  },
): SqliteExtensionStore {
  const { database, ...host } = input;
  host.assertOpen();
  return new SqliteExtensionStore(database, host);
}

export function createSqliteExternalOperationStore(input: {
  database: DatabaseSync;
  assertOpen(): void;
}): SqliteExternalOperationStore {
  input.assertOpen();
  return new SqliteExternalOperationStore(input.database, {
    assertOpen: input.assertOpen,
  });
}

/** Opt-in authority only: no migration, default account or funding during construction. */
export function createSqlitePluginCreditStore(input: {
  database: DatabaseSync;
  assertOpen(): void;
}): SqlitePluginCreditStore {
  input.assertOpen();
  return new SqlitePluginCreditStore(input);
}

/** Shares the host's lifetime; project persistence is migrated explicitly. */
export function createSqliteCreativeProjectStore(input: {
  database: DatabaseSync;
  assertOpen(): void;
}): SqliteCreativeProjectStore {
  input.assertOpen();
  return new SqliteCreativeProjectStore(input);
}

/** New source/proposal storage borrows the original project connection and lifetime. */
export function createSqliteProjectFoundationStore(input: {
  database: DatabaseSync;
  assertOpen(): void;
  sourceAdmission?: "trusted-internal-recipe";
}): SqliteProjectFoundationStore {
  input.assertOpen();
  return new SqliteProjectFoundationStore(input);
}
