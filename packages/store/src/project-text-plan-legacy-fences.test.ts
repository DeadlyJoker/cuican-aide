import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import { planFixture } from "./project-text-plan.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: the new final actual-project SQL still precedes original live policy fence`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await planFixture(t, backend);
      const m = await foundationMetadataFixture(t, {
        backend,
        path: f.databasePath,
        schema: f.prefix.slice(1, -2),
        prefix: f.prefix,
      });
      await m.migrate();
      let inserted = false,
        guarded = false;
      const observe = (sql: string) => {
        if (
          sql.startsWith("INSERT INTO") &&
          sql.includes("project_text_plan_receipts")
        )
          inserted = true;
        if (
          inserted &&
          sql.includes("SELECT 1 FROM") &&
          sql.includes("plugin_project_metadata_owners")
        ) {
          guarded = true;
          f.state.live = false;
        }
      };
      const prototype =
          backend === "sqlite" ? DatabaseSync.prototype : Client.prototype,
        key = backend === "sqlite" ? "prepare" : "query";
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
      Object.defineProperty(prototype, key, {
        ...descriptor,
        value: function (this: unknown, ...args: unknown[]) {
          const sql = String(args[0]),
            result: unknown = Reflect.apply(descriptor.value, this, args);
          if (backend === "postgres")
            return Promise.resolve(result).then((value) => {
              observe(sql);
              return value;
            });
          return new Proxy(result as object, {
            get(target, property) {
              const value: unknown = Reflect.get(target, property, target);
              if (typeof value !== "function") return value;
              return (...values: unknown[]) => {
                const out: unknown = Reflect.apply(value, target, values);
                observe(sql);
                return out;
              };
            },
          });
        },
      });
      try {
        await assert.rejects(f.start(), /named_plan_owner_withdrawn/);
      } finally {
        Object.defineProperty(prototype, key, descriptor);
      }
      assert.equal(guarded, true);
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plans`,
            )
          )[0]?.n,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plan_receipts`,
            )
          )[0]?.n,
        ),
        0,
      );
    },
  );
