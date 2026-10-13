import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresWebPluginProfileStore } from "./postgres-web-plugin-profile-store.ts";

test(
  "real PostgreSQL account profiles persist identity, isolate users and fence revocation",
  {
    skip: !process.env.CREWON_TEST_POSTGRES_URL,
  },
  async (t) => {
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      max: 3,
    });
    const schema = `web_profiles_${randomUUID().replaceAll("-", "")}`;
    t.after(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    const store = new PostgresWebPluginProfileStore({ pool, schema });
    const actor = {
      tenantId: "pim-tenant-1",
      spaceId: "pim-space-2",
      principalId: "pim-user-3",
      actorId: "pim-user-3",
    };
    const input = { actor, membershipDigest: "a".repeat(64) };
    await assert.rejects(store.find(actor));
    await store.migrate();
    await store.migrate();
    const [first, concurrent] = await Promise.all([
      store.resolveVerifiedAccount(input),
      store.resolveVerifiedAccount(input),
    ]);
    assert.deepEqual(first, concurrent);
    assert.deepEqual(
      await new PostgresWebPluginProfileStore({ pool, schema }).find(actor),
      first,
    );
    const other = await store.resolveVerifiedAccount({
      actor: { ...actor, principalId: "pim-user-4", actorId: "pim-user-4" },
      membershipDigest: input.membershipDigest,
    });
    assert.notEqual(other.scope.profileId, first.scope.profileId);
    const updated = await store.resolveVerifiedAccount({
      ...input,
      membershipDigest: "b".repeat(64),
    });
    assert.deepEqual(updated.scope, first.scope);
    assert.notEqual(updated.authorityEpoch, first.authorityEpoch);
    await assert.rejects(
      pool.query(
        `UPDATE "${schema}".profiles SET profile_id=$1 WHERE principal_id=$2`,
        [randomUUID(), actor.principalId],
      ),
      /identity_immutable/,
    );
    await assert.rejects(
      pool.query(
        `UPDATE "${schema}".profiles SET revoked=true WHERE principal_id=$1`,
        [actor.principalId],
      ),
      /epoch_required/,
    );
    assert.equal(await store.revoke(actor), true);
    assert.equal(await store.revoke(actor), false);
    assert.equal((await store.find(actor))!.revoked, true);
    await assert.rejects(
      store.resolveVerifiedAccount(input),
      /profile_revoked/,
    );
    assert.equal(
      await store.find({ ...actor, tenantId: "pim-tenant-5" }),
      null,
    );
    await pool.query(
      `ALTER TABLE "${schema}".profiles DISABLE TRIGGER protect_profile_identity`,
    );
    await assert.rejects(store.find(actor), /schema_invalid/);
  },
);

test("profile storage rejects unsafe schema names before connecting", () => {
  const pool = {} as Pool;
  assert.throws(
    () =>
      new PostgresWebPluginProfileStore({
        pool,
        schema: 'public";DROP SCHEMA public;--',
      }),
    /schema_invalid/,
  );
});
