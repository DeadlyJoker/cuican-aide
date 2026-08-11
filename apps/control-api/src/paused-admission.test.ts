import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  ACTIVATION_CONFIRMED_LINE,
  PAUSED_ADMISSION_ENV,
  ProcessLocalActivationGate,
  candidateReadinessLine,
  resolvePausedAdmission,
  watchActivationInput,
} from "./paused-admission.ts";

test("paused admission is explicit standalone-only configuration", () => {
  assert.equal(resolvePausedAdmission({}, "standalone"), null);
  assert.ok(
    resolvePausedAdmission(
      { [PAUSED_ADMISSION_ENV]: "1" },
      "standalone",
    ) instanceof ProcessLocalActivationGate,
  );
  for (const value of ["", "0", "true", " 1"] as const) {
    assert.throws(
      () =>
        resolvePausedAdmission({ [PAUSED_ADMISSION_ENV]: value }, "standalone"),
      /CREWON_CONTROL_PAUSED_ADMISSION_invalid/u,
    );
  }
  assert.throws(
    () => resolvePausedAdmission({ [PAUSED_ADMISSION_ENV]: "1" }, "production"),
    /CREWON_CONTROL_PAUSED_ADMISSION_forbidden/u,
  );
});

test("fenced admission allows only exact live and ready GET or HEAD requests", () => {
  const gate = new ProcessLocalActivationGate();
  assert.deepEqual(
    [
      gate.admitRequest("GET", "/api/v1/health/live"),
      gate.admitRequest("HEAD", "/api/v1/health/live"),
      gate.admitRequest("GET", "/api/v1/health/ready"),
      gate.admitRequest("HEAD", "/api/v1/health/ready"),
      gate.admitRequest("POST", "/api/v1/health/live"),
      gate.admitRequest("GET", "/api/v1/health/live?probe=1"),
      gate.admitRequest("GET", "/api/v1/threads"),
    ],
    [true, true, true, true, false, false, false],
  );
});

test("activation consumes one exact bounded record without waiting for EOF", () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  const controller = watchActivationInput(gate, input, output, () => {
    invalid += 1;
  });
  input.write("acti");
  assert.equal(gate.isActive(), false);
  input.write("vate\n");
  assert.deepEqual(
    {
      active: gate.isActive(),
      confirmation: output.read()?.toString("utf8"),
      invalid,
      inputEnded: input.writableEnded,
    },
    {
      active: true,
      confirmation: `${ACTIVATION_CONFIRMED_LINE}\n`,
      invalid: 0,
      inputEnded: false,
    },
  );
  controller.close();
  input.destroy();
  output.destroy();
});

test("malformed, oversized, additional, and truncated activation fail closed", async () => {
  for (const bytes of [
    "activate\r\n",
    "activate\nextra\n",
    "activate-now\n",
    "x".repeat(128),
  ]) {
    const gate = new ProcessLocalActivationGate();
    const input = new PassThrough();
    const output = new PassThrough();
    let invalid = 0;
    watchActivationInput(gate, input, output, () => {
      invalid += 1;
    });
    input.write(bytes);
    assert.deepEqual(
      { active: gate.isActive(), invalid, confirmation: output.read() },
      { active: false, invalid: 1, confirmation: null },
    );
    input.destroy();
    output.destroy();
  }

  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  let invalidated: (() => void) | undefined;
  const invalidation = new Promise<void>((resolve) => {
    invalidated = resolve;
  });
  watchActivationInput(gate, input, output, () => {
    invalid += 1;
    invalidated?.();
  });
  input.end("activate");
  await invalidation;
  assert.deepEqual(
    { active: gate.isActive(), invalid },
    { active: false, invalid: 1 },
  );
  output.destroy();
});

test("a second record after activation fails closed exactly once", () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  watchActivationInput(gate, input, output, () => {
    invalid += 1;
  });
  input.write("activate\n");
  assert.equal(gate.isActive(), true);
  input.write("activate\n");
  input.write("activate\n");
  assert.deepEqual(
    { active: gate.isActive(), invalid },
    { active: false, invalid: 1 },
  );
  input.destroy();
  output.destroy();
});

test("stream error before activation fails closed exactly once", () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  watchActivationInput(gate, input, output, () => {
    invalid += 1;
  });
  input.write("acti");
  input.emit("error", new Error("activation input failed"));
  input.emit("close");
  assert.deepEqual(
    { active: gate.isActive(), invalid },
    { active: false, invalid: 1 },
  );
  input.destroy();
  output.destroy();
});

test("stream close before activation fails closed exactly once", async () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  watchActivationInput(gate, input, output, () => {
    invalid += 1;
  });
  input.write("acti");
  const closed = new Promise<void>((resolve) => input.once("close", resolve));
  input.destroy();
  await closed;
  assert.deepEqual(
    { active: gate.isActive(), invalid },
    { active: false, invalid: 1 },
  );
  output.destroy();
});

test("closing the controller detaches input without activating or invalidating", () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  const controller = watchActivationInput(gate, input, output, () => {
    invalid += 1;
  });
  input.write("acti");
  controller.close();
  input.write("vate\n");
  input.end();
  assert.deepEqual(
    { active: gate.isActive(), invalid, confirmation: output.read() },
    { active: false, invalid: 0, confirmation: null },
  );
  input.destroy();
  output.destroy();
});

test("candidate readiness requires a concrete bounded port", () => {
  assert.equal(
    candidateReadinessLine(3210),
    "CrewON Control API candidate ready on 127.0.0.1:3210",
  );
  for (const port of [0, 65_536, Number.NaN]) {
    assert.throws(
      () => candidateReadinessLine(port),
      /control_candidate_port_invalid/u,
    );
  }
});
