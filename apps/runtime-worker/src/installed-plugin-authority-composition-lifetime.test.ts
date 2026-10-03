import assert from "node:assert/strict";
import test from "node:test";
import { compositionFixture } from "./runtime-composition.test-support.ts";
import { deferred, until } from "./runtime-store-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  };

  test(
    `${backend}: transferred plugin authority drains before storage and shutdown joins its closer`,
    options,
    async (t) => {
      const fixture = compositionFixture(t, backend);
      await fixture.activate();
      fixture.observeStoreClose();
      const physicalRequest = deferred();
      let closed = 0;
      const runtime = await fixture.create({
        installedPluginAuthorityOwner: {
          async close() {
            closed++;
            assert.equal(fixture.counts.stores, 0);
            await physicalRequest.promise;
          },
        },
      });
      try {
        const closing = runtime.close();
        assert.equal(runtime.close(), closing);
        await until(() => closed === 1);
        assert.equal(fixture.counts.stores, 0);
        physicalRequest.resolve();
        await closing;
        await runtime.close();
        assert.equal(closed, 1);
        assert.equal(fixture.counts.stores, 1);
      } finally {
        physicalRequest.resolve();
        await runtime.close().catch(() => {});
      }
    },
  );

  test(
    `${backend}: startup failure closes the transferred authority without masking the original error`,
    options,
    async (t) => {
      const fixture = compositionFixture(t, backend);
      let closed = 0;
      await assert.rejects(
        fixture.create(
          {
            installedPluginAuthorityOwner: {
              async close() {
                closed++;
                throw new Error("fixture_authority_cleanup_failed");
              },
            },
          },
          { failOpen: true },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.notEqual(error.message, "fixture_authority_cleanup_failed");
          return true;
        },
      );
      assert.equal(closed, 1);
      assert.equal(fixture.counts.models, 1);
      assert.equal(fixture.counts.tools, 1);
    },
  );
}
