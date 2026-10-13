import type { ActorContext } from "@crewon/application";
import type { Pool } from "pg";
export type PimAccountIdentity = Readonly<{
  userId: number;
  tenantId: number;
  spaceId: number;
}>;

/** Durable directory-to-Control bindings. Legacy ownership is an explicit operator
 * adoption backed by an actual imported dataset, never a fixed actor for all logins.
 */
export class PostgresPimActorBindings {
  readonly #pool: Pool;
  readonly #schema: string;
  constructor(input: { pool: Pool; schema: string }) {
    this.#pool = input.pool;
    this.#schema = identifier(input.schema);
  }
  async migrate(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["pim-actor-bindings:" + this.#schema],
      );
      const exists = await client.query("SELECT to_regclass($1) AS table", [
        `${this.#schema}.bindings`,
      ]);
      if (exists.rows[0].table === null) {
        const other = await client.query(
          "SELECT 1 FROM information_schema.tables WHERE table_schema=$1 LIMIT 1",
          [this.#schema.slice(1, -1)],
        );
        if (other.rowCount !== 0)
          throw new Error("pim_actor_bindings_schema_partial");
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schema};
          CREATE TABLE ${this.#schema}.bindings (
            pim_user_id bigint NOT NULL CHECK(pim_user_id>0),pim_tenant_id bigint NOT NULL CHECK(pim_tenant_id>0),pim_space_id bigint NOT NULL CHECK(pim_space_id>0),
            tenant_id text NOT NULL,space_id text NOT NULL,principal_id text NOT NULL,actor_id text NOT NULL,
            source_digest text CHECK(source_digest IS NULL OR source_digest ~ '^sha256:[a-f0-9]{64}$'),
            PRIMARY KEY(pim_user_id,pim_tenant_id,pim_space_id),UNIQUE(tenant_id,space_id,principal_id,actor_id));
          CREATE TABLE ${this.#schema}.realm_bindings (
            pim_tenant_id bigint NOT NULL CHECK(pim_tenant_id>0),pim_space_id bigint NOT NULL CHECK(pim_space_id>0),
            tenant_id text NOT NULL,space_id text NOT NULL,source_digest text NOT NULL CHECK(source_digest ~ '^sha256:[a-f0-9]{64}$'),
            adopted_by_pim_user_id bigint NOT NULL CHECK(adopted_by_pim_user_id>0),
            PRIMARY KEY(pim_tenant_id,pim_space_id),UNIQUE(tenant_id,space_id));
          CREATE FUNCTION ${this.#schema}.immutable_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pim_actor_binding_immutable'; END $$;
          CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON ${this.#schema}.bindings FOR EACH ROW EXECUTE FUNCTION ${this.#schema}.immutable_binding();`);
        await client.query(
          `CREATE TRIGGER immutable_realm_binding BEFORE UPDATE OR DELETE ON ${this.#schema}.realm_bindings FOR EACH ROW EXECUTE FUNCTION ${this.#schema}.immutable_binding()`,
        );
      }
      await this.#assertSchema(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  assertReady(): Promise<void> {
    return this.#assertSchema(this.#pool);
  }
  async resolveVerifiedAccountActor(
    account: PimAccountIdentity,
  ): Promise<ActorContext> {
    await this.#assertSchema(this.#pool);
    const values = identityValues(account);
    const current = await this.#pool.query(
      `SELECT * FROM ${this.#schema}.bindings WHERE pim_user_id=$1 AND pim_tenant_id=$2 AND pim_space_id=$3`,
      values,
    );
    if (current.rowCount === 1) return actorRow(current.rows[0]);
    const actor = {
      tenantId: `pim-tenant-${account.tenantId}`,
      spaceId: `pim-space-${account.spaceId}`,
      principalId: `pim-user-${account.userId}`,
      actorId: `pim-user-${account.userId}`,
    };
    const realm = await this.#pool.query(
      `SELECT tenant_id,space_id FROM ${this.#schema}.realm_bindings WHERE pim_tenant_id=$1 AND pim_space_id=$2`,
      [account.tenantId, account.spaceId],
    );
    if (realm.rowCount === 1) {
      actor.tenantId = realm.rows[0].tenant_id;
      actor.spaceId = realm.rows[0].space_id;
      actorValues(actor);
    }
    await this.#pool.query(
      `INSERT INTO ${this.#schema}.bindings VALUES($1,$2,$3,$4,$5,$6,$7,null) ON CONFLICT(pim_user_id,pim_tenant_id,pim_space_id) DO NOTHING`,
      [...values, ...actorValues(actor)],
    );
    const after = await this.#pool.query(
      `SELECT * FROM ${this.#schema}.bindings WHERE pim_user_id=$1 AND pim_tenant_id=$2 AND pim_space_id=$3`,
      values,
    );
    if (after.rowCount !== 1) throw new Error("pim_actor_binding_unavailable");
    return actorRow(after.rows[0]);
  }
  /** The caller is the deployment operator after verifying this exact active PIM account. */
  async adoptImportedLegacyActor(input: {
    verifiedAccount: PimAccountIdentity &
      Readonly<{ userRole: string; spaceRole: string; expiresAt: number }>;
    actor: ActorContext;
    coreSchema: string;
    sourceDigest: string;
  }): Promise<void> {
    const values = identityValues(input.verifiedAccount);
    const actor = actorValues(input.actor);
    const core = identifier(input.coreSchema);
    if (
      input.verifiedAccount.userRole !== "admin" ||
      input.verifiedAccount.spaceRole !== "owner" ||
      input.verifiedAccount.expiresAt <= Date.now() ||
      !/^sha256:[a-f0-9]{64}$/u.test(input.sourceDigest)
    )
      throw new Error("pim_actor_legacy_adoption_denied");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await this.#assertSchema(client);
      const proof = await client.query(
        `SELECT 1 FROM ${core}.control_snapshot_import WHERE source_digest=$1`,
        [input.sourceDigest],
      );
      const data = await client.query(
        `SELECT 1 FROM ${core}.threads WHERE tenant_id=$1 AND space_id=$2 AND state_json->>'createdByActorId'=$3 LIMIT 1`,
        [input.actor.tenantId, input.actor.spaceId, input.actor.actorId],
      );
      if (proof.rowCount !== 1 || data.rowCount !== 1)
        throw new Error("pim_actor_legacy_snapshot_missing");
      await client.query(
        `INSERT INTO ${this.#schema}.realm_bindings VALUES($1,$2,$3,$4,$5,$6)`,
        [
          input.verifiedAccount.tenantId,
          input.verifiedAccount.spaceId,
          input.actor.tenantId,
          input.actor.spaceId,
          input.sourceDigest,
          input.verifiedAccount.userId,
        ],
      );
      await client.query(
        `INSERT INTO ${this.#schema}.bindings VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [...values, ...actor, input.sourceDigest],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async #assertSchema(connection: Pick<Pool, "query">): Promise<void> {
    await connection.query(
      `SELECT pim_user_id,pim_tenant_id,pim_space_id,tenant_id,space_id,principal_id,actor_id,source_digest FROM ${this.#schema}.bindings LIMIT 0`,
    );
    await connection.query(
      `SELECT pim_tenant_id,pim_space_id,tenant_id,space_id,source_digest,adopted_by_pim_user_id FROM ${this.#schema}.realm_bindings LIMIT 0`,
    );
    const result = await connection.query(
      "SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND t.tgenabled='O' AND ((c.relname='bindings' AND t.tgname='immutable_binding') OR (c.relname='realm_bindings' AND t.tgname='immutable_realm_binding'))",
      [this.#schema.slice(1, -1)],
    );
    if (result.rowCount !== 2)
      throw new Error("pim_actor_bindings_schema_invalid");
  }
}
function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error("pim_actor_bindings_schema_invalid");
  return `"${value}"`;
}
function identityValues(account: PimAccountIdentity): number[] {
  const values = [account.userId, account.tenantId, account.spaceId];
  if (values.some((v) => !Number.isSafeInteger(v) || v < 1))
    throw new Error("pim_actor_identity_invalid");
  return values;
}
function actorValues(actor: ActorContext): string[] {
  const values = [
    actor.tenantId,
    actor.spaceId,
    actor.principalId,
    actor.actorId,
  ];
  if (
    values.some(
      (v) =>
        typeof v !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(v),
    )
  )
    throw new Error("pim_actor_binding_invalid");
  return values;
}
function actorRow(row: Record<string, unknown>): ActorContext {
  const actor = {
    tenantId: row.tenant_id,
    spaceId: row.space_id,
    principalId: row.principal_id,
    actorId: row.actor_id,
  } as ActorContext;
  actorValues(actor);
  return Object.freeze(actor);
}
