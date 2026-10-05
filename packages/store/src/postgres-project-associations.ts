import type { Pool } from "pg";
import type {
  ExtensionRunLocator,
  ProjectGenerationSourceLocator,
} from "@crewon/application";
import {
  migratePostgresProjectGenerations,
  assertPostgresProjectGenerationSchema,
} from "./project-generation-schema.ts";
import {
  decodeProjectGeneration,
  projectGenerationReadSql,
  projectGenerationLocator,
} from "./project-generation-store-support.ts";
import {
  projectGenerationSourceLocator,
  projectGenerationSourceValues,
  projectGenerationSourceReadSql,
  decodeProjectGenerationSource,
  verifyPostgresProjectSourceFunding,
  assertPostgresProjectGenerationReadSchema,
} from "./project-generation-source-read.ts";
import {
  migratePostgresProjectQueries,
  assertPostgresProjectQuerySchema,
} from "./project-query-schema.ts";
import { loadPostgresProjectQueryLink } from "./project-query-store-support.ts";

import {
  migratePostgresProjectHistoricalQueries,
  assertPostgresProjectHistoricalQuerySchema,
} from "./project-historical-query-schema.ts";
import { loadPostgresProjectHistoricalQueryLink } from "./project-historical-query-store-support.ts";
import { migratePostgresHistoricalQueryMarker } from "./project-historical-query-marker.ts";
/** Optional project storage capabilities reuse the host's pool; they never own a second runtime. */
export class PostgresProjectAssociations {
  #projectGenerationsEnabled = false;
  #projectGenerationReadsEnabled = false;
  #projectQueriesEnabled = false;
  #projectHistoricalQueriesEnabled = false;
  get historicalQueriesEnabled() {
    return this.#projectHistoricalQueriesEnabled;
  }
  readonly #pool: Pool;
  readonly #schemaName: string;
  readonly #schema: string;
  readonly #assertOpen: () => void;
  constructor(pool: Pool, schema: string, assertOpen: () => void) {
    this.#pool = pool;
    this.#schemaName = schema;
    this.#schema = `"${schema}"`;
    this.#assertOpen = assertOpen;
  }
  get generationsEnabled() {
    return this.#projectGenerationsEnabled;
  }
  get readsEnabled() {
    return this.#projectGenerationReadsEnabled;
  }
  get queriesEnabled() {
    return this.#projectQueriesEnabled;
  }
  /** Explicit opt-in; ordinary extension migration does not inspect project metadata. */
  async migrateProjectGenerations(): Promise<void> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify(["project-generation-migration", this.#schemaName])],
      );
      await migratePostgresProjectGenerations(client, this.#schemaName);
      this.#assertOpen();
      await client.query("COMMIT");
      this.#projectGenerationsEnabled = true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async loadProjectGenerationLink(input: ExtensionRunLocator) {
    if (!this.#projectGenerationsEnabled)
      throw new Error("project_generation_unavailable");
    this.#assertOpen();
    const locator = projectGenerationLocator(input);
    const client = await this.#pool.connect();
    try {
      await assertPostgresProjectGenerationSchema(client, this.#schemaName);
      const rows = await client.query(
        projectGenerationReadSql(`${this.#schema}.`, true),
        locator,
      );
      this.#assertOpen();
      return decodeProjectGeneration(rows.rows[0], {
        tenantId: locator[0],
        spaceId: locator[1],
        runId: locator[2],
      });
    } finally {
      client.release();
    }
  }
  /** Verify existing immutable data only; never create schema or grant generation writes. */
  async enableProjectGenerationReads(): Promise<void> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      await assertPostgresProjectGenerationReadSchema(
        client,
        this.#schemaName,
        `${this.#schema}.`,
      );
      this.#assertOpen();
      this.#projectGenerationReadsEnabled = true;
    } finally {
      client.release();
    }
  }
  async loadProjectGenerationLinkBySource(
    input: ProjectGenerationSourceLocator,
  ) {
    if (!this.#projectGenerationReadsEnabled)
      throw new Error("project_generation_read_unavailable");
    this.#assertOpen();
    const locator = projectGenerationSourceLocator(input);
    const client = await this.#pool.connect();
    try {
      await assertPostgresProjectGenerationReadSchema(
        client,
        this.#schemaName,
        `${this.#schema}.`,
      );
      const rows = await client.query(
        projectGenerationSourceReadSql(`${this.#schema}.`, true),
        projectGenerationSourceValues(locator),
      );
      this.#assertOpen();
      const link = decodeProjectGenerationSource(rows.rows, locator);
      await verifyPostgresProjectSourceFunding(
        client,
        this.#schemaName,
        rows.rows,
        link,
      );
      this.#assertOpen();
      return link;
    } finally {
      client.release();
    }
  }

  /** Query opt-in verifies existing generation history and never grants generation writes. */
  async migrateProjectHistoricalQueries(): Promise<void> {
    this.#assertOpen();
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([
          "project-historical-query-migration",
          this.#schemaName,
        ]),
      ]);
      await migratePostgresHistoricalQueryMarker(c, this.#schemaName);
      await migratePostgresProjectHistoricalQueries(c, this.#schemaName);
      this.#assertOpen();
      await c.query("COMMIT");
      this.#projectHistoricalQueriesEnabled = true;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  async loadProjectHistoricalQueryLink(input: ExtensionRunLocator) {
    if (!this.#projectHistoricalQueriesEnabled)
      throw new Error("project_historical_query_unavailable");
    this.#assertOpen();
    const c = await this.#pool.connect();
    try {
      await assertPostgresProjectHistoricalQuerySchema(c, this.#schemaName);
      const link = await loadPostgresProjectHistoricalQueryLink(
        c,
        this.#schemaName,
        input,
      );
      this.#assertOpen();
      return link;
    } finally {
      c.release();
    }
  }
  async migrateProjectQueries(): Promise<void> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify(["project-query-migration", this.#schemaName])],
      );
      await migratePostgresProjectQueries(client, this.#schemaName);
      this.#assertOpen();
      await client.query("COMMIT");
      this.#projectQueriesEnabled = true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async loadProjectQueryLink(input: ExtensionRunLocator) {
    if (!this.#projectQueriesEnabled)
      throw new Error("project_query_unavailable");
    this.#assertOpen();
    const values = projectGenerationLocator(input),
      locator = { tenantId: values[0], spaceId: values[1], runId: values[2] };
    const client = await this.#pool.connect();
    try {
      await assertPostgresProjectQuerySchema(client, this.#schemaName);
      const link = await loadPostgresProjectQueryLink(
        client,
        this.#schemaName,
        locator,
      );
      this.#assertOpen();
      return link;
    } finally {
      client.release();
    }
  }
}
