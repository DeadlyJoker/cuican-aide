import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { AuthorityTime } from "./runtime-authority-query.ts";

export function storeAccessClock() {
  let wall = 0;
  let steady = 0;
  const timers = new Map<() => void, number>();
  const time: AuthorityTime = {
    now: () => ({ wall, steady }),
    after(delay, callback) {
      timers.set(callback, steady + delay);
      return () => {
        timers.delete(callback);
      };
    },
  };
  return {
    time,
    timers,
    advance(ms: number, fire = true, sleeping = false) {
      wall += ms;
      if (!sleeping) steady += ms;
      if (fire)
        for (const [callback, due] of [...timers])
          if (due <= steady) {
            timers.delete(callback);
            callback();
          }
    },
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function until(condition: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await setImmediate();
  }
  assert.ok(condition(), "physical Store operation did not settle");
}
