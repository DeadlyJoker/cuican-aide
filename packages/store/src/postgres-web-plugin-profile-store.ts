import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ActorContext } from "@crewon/application";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";

export type WebPluginProfile = Readonly<{
  scope: PluginProfileScope;
  authorityEpoch: string;
  membershipDigest: string;
  revoked: boolean;
}>;

/** Host authority records; a verified account owns one persistent plugin profile per realm.
 * Resolving an account never adopts a local-device profile or a different principal's installation.
 */
export class PostgresWebPluginProfileStore {
  readonly #pool: Pool;
  readonly #schema: string;
  constructor(input: { pool: Pool; schema: string }) {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(input.schema))
      throw new Error("web_plugin_profile_schema_invalid");
    this.#pool = input.pool;
    this.#schema = `"${input.schema}"`;
  }

  async migrate(): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [this.#schema],
      );
      const existing = await client.query<{ name: string }>(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=$1",
        [this.#schema.slice(1, -1)],
      );
      if (existing.rowCount !== 0) {
        await this.#version(client);
        return;
      }
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schema};
        CREATE TABLE ${this.#schema}.schema_version (
          id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL CHECK(version=1));
        INSERT INTO ${this.#schema}.schema_version VALUES(1,1);
        CREATE TABLE ${this.#schema}.profiles (
          tenant_id text NOT NULL, space_id text NOT NULL,
          principal_id text NOT NULL, actor_id text NOT NULL,
          profile_id uuid NOT NULL UNIQUE, authority_epoch uuid NOT NULL,
          membership_digest text NOT NULL CHECK(membership_digest ~ '^[a-f0-9]{64}$'),
          revoked boolean NOT NULL DEFAULT false,
          PRIMARY KEY(tenant_id,space_id,principal_id,actor_id));
        CREATE FUNCTION ${this.#schema}.protect_profile_identity() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF (NEW.tenant_id,NEW.space_id,NEW.principal_id,NEW.actor_id,NEW.profile_id)
              IS DISTINCT FROM (OLD.tenant_id,OLD.space_id,OLD.principal_id,OLD.actor_id,OLD.profile_id) THEN
              RAISE EXCEPTION 'web_plugin_profile_identity_immutable';
            END IF;
            IF (NEW.membership_digest,NEW.revoked) IS DISTINCT FROM (OLD.membership_digest,OLD.revoked)
               AND NEW.authority_epoch=OLD.authority_epoch THEN
              RAISE EXCEPTION 'web_plugin_profile_epoch_required';
            END IF;
            RETURN NEW;
          END $$;
        CREATE TRIGGER protect_profile_identity BEFORE UPDATE ON ${this.#schema}.profiles
          FOR EACH ROW EXECUTE FUNCTION ${this.#schema}.protect_profile_identity();`);
    });
  }
  async assertReady(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await this.#version(client);
    } finally {
      client.release();
    }
  }

  async resolveVerifiedAccount(input: {
    actor: ActorContext;
    membershipDigest: string;
  }): Promise<WebPluginProfile> {
    const values = actorValues(input.actor);
    if (!/^[a-f0-9]{64}$/u.test(input.membershipDigest))
      throw new Error("web_plugin_profile_membership_invalid");
    return this.#transaction(async (client) => {
      await this.#version(client);
      const result = await client.query(
        `INSERT INTO ${this.#schema}.profiles
        (tenant_id,space_id,principal_id,actor_id,profile_id,authority_epoch,membership_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(tenant_id,space_id,principal_id,actor_id) DO UPDATE SET
          membership_digest=EXCLUDED.membership_digest,
          authority_epoch=CASE WHEN profiles.membership_digest=EXCLUDED.membership_digest
            THEN profiles.authority_epoch ELSE EXCLUDED.authority_epoch END
        WHERE NOT profiles.revoked RETURNING *`,
        [...values, randomUUID(), randomUUID(), input.membershipDigest],
      );
      if (result.rowCount !== 1) throw new Error("web_plugin_profile_revoked");
      return profile(result.rows[0]);
    });
  }

  async find(actor: ActorContext): Promise<WebPluginProfile | null> {
    const values = actorValues(actor);
    return this.#transaction(async (client) => {
      await this.#version(client);
      const result = await client.query(
        `SELECT * FROM ${this.#schema}.profiles
        WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4`,
        values,
      );
      return result.rowCount === 0 ? null : profile(result.rows[0]);
    });
  }

  /** Operator revocation is durable; signing in again cannot silently restore access. */
  async revoke(actor: ActorContext): Promise<boolean> {
    const values = actorValues(actor);
    return this.#transaction(async (client) => {
      await this.#version(client);
      const result = await client.query(
        `UPDATE ${this.#schema}.profiles
        SET revoked=true,authority_epoch=$5
        WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND NOT revoked`,
        [...values, randomUUID()],
      );
      return result.rowCount === 1;
    });
  }

  async #version(client: PoolClient): Promise<void> {
    const result = await client.query(
      `SELECT version FROM ${this.#schema}.schema_version WHERE id=1`,
    );
    if (result.rowCount !== 1 || result.rows[0].version !== 1)
      throw new Error("web_plugin_profile_schema_invalid");
    await client.query(`SELECT tenant_id,space_id,principal_id,actor_id,profile_id,
      authority_epoch,membership_digest,revoked FROM ${this.#schema}.profiles LIMIT 0`);
    const trigger = await client.query(
      "SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='profiles' AND t.tgname='protect_profile_identity' AND t.tgenabled='O'",
      [this.#schema.slice(1, -1)],
    );
    if (trigger.rowCount !== 1)
      throw new Error("web_plugin_profile_schema_invalid");
  }

  async #transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
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
      (value) =>
        typeof value !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(value),
    )
  )
    throw new Error("web_plugin_profile_actor_invalid");
  return values;
}
function profile(row: Record<string, unknown>): WebPluginProfile {
  const scope = parsePluginProfileScope({
    tenantId: row.tenant_id,
    spaceId: row.space_id,
    profileId: row.profile_id,
  });
  if (
    typeof row.authority_epoch !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(row.authority_epoch) ||
    typeof row.membership_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.membership_digest) ||
    typeof row.revoked !== "boolean"
  )
    throw new Error("web_plugin_profile_record_invalid");
  return Object.freeze({
    scope,
    authorityEpoch: row.authority_epoch,
    membershipDigest: row.membership_digest,
    revoked: row.revoked,
  });
}
