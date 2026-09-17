import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installProcessShutdown } from "./process-shutdown.ts";

for (const first of ["signal", "failure"] as const) {
  test(`failure cannot be downgraded by repeated shutdown requests, first=${first}`, async (context) => {
    const signals = new EventEmitter();
    let resolve!: () => void;
    const closing = new Promise<void>((yes) => {
      resolve = yes;
    });
    context.after(async () => {
      resolve();
      await closing;
    });
    let closes = 0,
      reports = 0;
    const exits: number[] = [];
    const controller = installProcessShutdown({
      host: {
        on: signals.on.bind(signals),
        exit: (code) => {
          exits.push(code);
        },
      },
      close: () => {
        closes++;
        return closing;
      },
      reportFailure: () => {
        reports++;
      },
    });
    assert.equal(controller.isRequested(), false);
    if (first === "signal") signals.emit("SIGTERM");
    controller.request("failure");
    for (let index = 0; index < 20_000; index++) {
      controller.request("requested");
      signals.emit("SIGINT");
    }
    assert.equal(controller.isRequested(), true);
    assert.equal(closes, 1);
    assert.deepEqual(exits, []);
    resolve();
    await closing;
    assert.deepEqual(exits, [1]);
    assert.equal(
      reports,
      0,
      "an application-requested exit 1 is not a cleanup failure",
    );
  });
}
