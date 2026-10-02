import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import {
  fixture as installationFixture,
  scope,
} from "./plugin-installation-store.test-support.ts";
import { pluginInstallationProfileLockKey } from "./postgres-plugin-installation-profile-support.ts";
import type { PluginProfileScope } from "@crewon/domain";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function until(
  predicate: () => Promise<boolean> | boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    assert.ok(
      Date.now() < deadline,
      "Real PostgreSQL lifecycle condition did not complete",
    );
    await setTimeout(5);
  }
}

export async function fixture(t: TestContext) {
  const f = await installationFixture(t, "postgres");
  assert.ok(f.first.parent instanceof PostgresDomainStore);
  assert.ok(f.second.parent instanceof PostgresDomainStore);
  const store = f.first.parent.pluginInstallationStore();
  const peer = f.second.parent.pluginInstallationStore();
  const schema = f.prefix.slice(1, -2);
  const observer = new Pool({
    connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  t.after(() => observer.end());
  const locks = async (granted: boolean, profile: PluginProfileScope = scope) =>
    (
      await observer.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted=$2
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid
        AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1`,
        [pluginInstallationProfileLockKey(schema, profile), granted],
      )
    ).rows;
  return { ...f, store, peer, schema, observer, locks };
}
