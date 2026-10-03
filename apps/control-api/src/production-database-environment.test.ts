import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCTION_DATABASE_MAX_POOL_SIZE_ENV as setting,
  resolveProductionDatabaseMaxPoolSize,
} from "./production-database-environment.ts";

test("unconfigured production and standalone keep the original pool default", () => {
  for (const mode of ["production", "standalone"] as const) {
    assert.equal(resolveProductionDatabaseMaxPoolSize({}, mode), undefined);
    assert.equal(
      resolveProductionDatabaseMaxPoolSize({ [setting]: undefined }, mode),
      undefined,
    );
    assert.equal(
      resolveProductionDatabaseMaxPoolSize(
        Object.create({ [setting]: "1" }),
        mode,
      ),
      undefined,
    );
  }
});

test("production captures an explicit bounded pool size before asynchronous startup", () => {
  const environment = { [setting]: "1" };
  const captured = resolveProductionDatabaseMaxPoolSize(
    environment,
    "production",
  );
  environment[setting] = "64";
  assert.equal(captured, 1);
  assert.equal(
    resolveProductionDatabaseMaxPoolSize(environment, "production"),
    64,
  );
});

test("invalid or unsupported opt-ins are rejected instead of silently changing defaults", () => {
  for (const value of [
    "",
    "0",
    "-1",
    "65",
    "999999999999999999999",
    "01",
    "1.0",
    "1e1",
    "0x10",
    " 1",
    "1 ",
    "1\n",
    "1\u200b",
  ])
    assert.throws(
      () =>
        resolveProductionDatabaseMaxPoolSize(
          { [setting]: value },
          "production",
        ),
      /production_database_max_pool_size_invalid/u,
    );
  assert.throws(
    () =>
      resolveProductionDatabaseMaxPoolSize({ [setting]: "1" }, "standalone"),
    /production_database_max_pool_size_invalid/u,
  );
});

test("startup never evaluates environment accessors or non-enumerable overrides", () => {
  let getterCalls = 0;
  const getter = Object.defineProperty({}, setting, {
    enumerable: true,
    get() {
      getterCalls++;
      return "1";
    },
  });
  const hidden = Object.defineProperty({}, setting, { value: "1" });
  for (const environment of [getter, hidden])
    assert.throws(
      () => resolveProductionDatabaseMaxPoolSize(environment, "production"),
      /production_database_max_pool_size_invalid/u,
    );
  assert.equal(getterCalls, 0);
});
