import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { serviceShutdownFixture } from "./service-shutdown-fixture.test-support.ts";

for (const service of ["control-api", "device-gateway", "web-bff"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(
      `${service}: repeated signals wait for physical listener closure and ${outcome} settlement`,
      { timeout: 15_000 },
      async (context) => {
        const fixture = await serviceShutdownFixture(context, service, outcome);
        fixture.child.kill("SIGTERM");
        await fixture.waitFor("fixture close pending");
        for (const signal of ["SIGTERM", "SIGINT", "SIGTERM"] as const) {
          fixture.child.kill(signal);
          await delay(20);
        }
        await delay(100);
        assert.equal(fixture.child.exitCode, null, fixture.stderr());
        assert.equal(fixture.child.signalCode, null, fixture.stderr());
        assert.equal(
          fixture.stdout().match(/fixture close called/g)?.length,
          1,
        );
        fixture.child.kill("SIGUSR2");
        assert.deepEqual(await fixture.completion, {
          code: outcome === "resolve" ? 0 : 1,
          signal: null,
        });
        assert.equal(
          fixture.stdout().match(/fixture close released/g)?.length,
          1,
        );
        assert.doesNotMatch(fixture.stderr(), /fixture-private-close-failure/);
        if (outcome === "reject")
          assert.equal(fixture.stderr().match(/shutdown failed/g)?.length, 1);
        else assert.equal(fixture.stderr(), "");
      },
    );
  }
}

test(
  "Control API activation failure shares pending signal cleanup and cannot become successful exit",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await serviceShutdownFixture(
      context,
      "control-api",
      "resolve",
    );
    fixture.child.kill("SIGTERM");
    await fixture.waitFor("fixture close pending");
    fixture.child.stdin.write("invalid activation\n");
    await delay(100);
    assert.equal(fixture.child.exitCode, null, fixture.stderr());
    assert.equal(fixture.child.signalCode, null, fixture.stderr());
    fixture.child.kill("SIGINT");
    await delay(20);
    fixture.child.kill("SIGUSR2");
    assert.deepEqual(await fixture.completion, { code: 1, signal: null });
    assert.equal(fixture.stdout().match(/fixture close called/g)?.length, 1);
    assert.equal(fixture.stderr(), "");
  },
);
