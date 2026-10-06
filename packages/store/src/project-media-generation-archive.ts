import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import type { ExtensionRunLocator } from "@crewon/application";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  migrateSqliteProjectMediaGenerations,
  migratePostgresProjectMediaGenerations,
  assertSqliteProjectMediaGenerationSchema,
  assertPostgresProjectMediaGenerationSchema,
} from "./project-media-generation-schema.ts";
import {
  executeSqliteMediaGenerationPlan,
  executePostgresMediaGenerationPlan,
} from "./project-media-generation-transaction.ts";
import { loadProjectMediaGenerationLinkPlan } from "./project-media-generation-read.ts";
const version = "crewon.project-media-generation-link.v1" as const;
export class SqliteProjectMediaGenerationArchive {
  #enabled = false;
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  constructor(db: DatabaseSync, assertOpen: () => void) {
    this.#db = db;
    this.#open = assertOpen;
  }
  get enabled() {
    return this.#enabled;
  }
  get version() {
    return this.#enabled ? version : undefined;
  }
  async migrate() {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteProjectMediaGenerations(this.#db);
      this.#open();
      this.#db.exec("COMMIT");
      this.#enabled = true;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    }
  }
  async load(input: ExtensionRunLocator) {
    this.#open();
    if (!this.#enabled) throw new Error("project_media_generation_unavailable");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteProjectMediaGenerationSchema(this.#db);
      const result = executeSqliteMediaGenerationPlan(
        this.#db,
        loadProjectMediaGenerationLinkPlan(
          { postgres: false, schema: "main", prefix: "" },
          input,
        ),
        this.#open,
      );
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    }
  }
}
export class PostgresProjectMediaGenerationArchive {
  #enabled = false;
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #open: () => void;
  constructor(pool: Pool, schema: string, assertOpen: () => void) {
    this.#pool = pool;
    this.#schema = schema;
    this.#open = assertOpen;
  }
  get enabled() {
    return this.#enabled;
  }
  get version() {
    return this.#enabled ? version : undefined;
  }
  async migrate() {
    this.#open();
    const c = await this.#pool.connect();
    try {
      this.#open();
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify(["project-media-generation-migration", this.#schema]),
      ]);
      await migratePostgresProjectMediaGenerations(c, this.#schema);
      this.#open();
      await c.query("COMMIT");
      this.#enabled = true;
    } catch (error) {
      try {
        await c.query("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    } finally {
      c.release();
    }
  }
  async load(input: ExtensionRunLocator) {
    this.#open();
    if (!this.#enabled) throw new Error("project_media_generation_unavailable");
    const c = await this.#pool.connect();
    try {
      this.#open();
      await c.query("BEGIN");
      await assertPostgresProjectMediaGenerationSchema(c, this.#schema);
      const result = await executePostgresMediaGenerationPlan(
        c,
        this.#schema,
        loadProjectMediaGenerationLinkPlan(
          {
            postgres: true,
            schema: this.#schema,
            prefix: `${creativeProjectSchemaName(this.#schema)}.`,
          },
          input,
        ),
        this.#open,
      );
      this.#open();
      await c.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await c.query("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    } finally {
      c.release();
    }
  }
}
