import { expect, it } from "vitest";
import { runtimeStartupFailureCode } from "./runtimeStartupFailure.ts";

it("retains stable startup reason codes and removes paths, payloads and hostile accessors", () => {
  expect(
    runtimeStartupFailureCode(
      new Error("desktop_installed_plugin_peer_deadline_exceeded"),
    ),
  ).toBe("desktop_installed_plugin_peer_deadline_exceeded");
  for (const value of [
    new Error("https://service.invalid/?secret=key"),
    new Error("/private/profile/token"),
    new Error("x".repeat(129)),
    { message: "fake_code" },
  ]) {
    expect(runtimeStartupFailureCode(value)).toBe("runtime_startup_failed");
  }
  const error = new Error();
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("must_not_read");
    },
  });
  expect(runtimeStartupFailureCode(error)).toBe("runtime_startup_failed");
  expect(
    runtimeStartupFailureCode(
      new Proxy(error, {
        getOwnPropertyDescriptor() {
          throw new Error("must_not_trap");
        },
      }),
    ),
  ).toBe("runtime_startup_failed");
});
