import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseBrowserActInput,
  parseBrowserObserveInput,
  parseBrowserTarget,
} from "./browser-execution.ts";

const scope = {
  sessionId: "session-1",
  generation: 0,
  observationId: "observation-1",
};

test("C05 parses discovery and each bounded browser action without changing its identity", () => {
  assert.deepEqual(parseBrowserObserveInput({}), {});
  assert.deepEqual(parseBrowserObserveInput({ sessionId: "session-1" }), {
    sessionId: "session-1",
  });
  const actions = [
    { ...scope, action: "navigate", url: "https://example.test/report?a=1" },
    { ...scope, action: "click", target: { targetId: "target-1" } },
    {
      ...scope,
      action: "fill",
      target: { role: "textbox", name: "查询" },
      value: "",
    },
    {
      ...scope,
      action: "select",
      target: { targetId: "target-2" },
      value: "月度",
    },
    { ...scope, action: "download", target: { role: "link", name: "下载" } },
  ];
  for (const action of actions) {
    const parsed = parseBrowserActInput(action);
    assert.deepEqual(parsed, action);
    assert.notEqual(parsed, action);
  }
});

test("C05 rejects authority, arbitrary code/path/selectors, ambiguous targets and unknown fields", () => {
  for (const input of [
    null,
    [],
    "{}",
    { sessionId: null },
    { runId: "run-1" },
    { sessionId: "" },
  ]) {
    assert.throws(
      () => parseBrowserObserveInput(input),
      ContractValidationError,
    );
  }
  for (const target of [
    {},
    { css: "#submit" },
    { path: "/tmp/file" },
    { targetId: "x", role: "button", name: "Send" },
    { role: "button" },
    { role: "button", name: "" },
    { role: "button", name: "x", index: 1 },
  ]) {
    assert.throws(() => parseBrowserTarget(target), ContractValidationError);
  }
  for (const input of [
    { ...scope, action: "evaluate", value: "document.cookie" },
    { ...scope, action: "click" },
    { ...scope, action: "click", target: { targetId: "x" }, runId: "run-1" },
    { ...scope, action: "click", target: { targetId: "x" }, value: "extra" },
    { ...scope, action: "fill", target: { targetId: "x" } },
    {
      ...scope,
      action: "select",
      target: { targetId: "x" },
      value: "x",
      url: "https://example.test",
    },
    {
      ...scope,
      action: "navigate",
      url: "https://example.test",
      target: { targetId: "x" },
    },
    {
      ...scope,
      generation: -1,
      action: "navigate",
      url: "https://example.test",
    },
    {
      ...scope,
      generation: 0.5,
      action: "navigate",
      url: "https://example.test",
    },
    {
      ...scope,
      observationId: "",
      action: "navigate",
      url: "https://example.test",
    },
  ]) {
    assert.throws(() => parseBrowserActInput(input), ContractValidationError);
  }
});

test("C05 navigation excludes non-Web schemes, credential authorities and ambiguous URL encodings", () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,x",
    "//example.test",
    "/report",
    "https://user:secret@example.test",
    "https://user@example.test",
    "https://example.test\\@other.test",
    " https://example.test",
    "https://example.\ntest",
    "https://",
    "https://example.test/" + "x".repeat(2048),
  ]) {
    assert.throws(
      () => parseBrowserActInput({ ...scope, action: "navigate", url }),
      ContractValidationError,
    );
  }
});

test("C05 fill has a bounded ordinary-value channel and generation must be a safe integer", () => {
  const fill = {
    ...scope,
    action: "fill",
    target: { targetId: "x" },
    value: "字".repeat(512),
  };
  assert.deepEqual(parseBrowserActInput(fill), fill);
  for (const value of ["字".repeat(513), "a\0b", 1, null]) {
    assert.throws(
      () => parseBrowserActInput({ ...fill, value }),
      ContractValidationError,
    );
  }
  assert.throws(
    () =>
      parseBrowserActInput({
        ...fill,
        generation: Number.MAX_SAFE_INTEGER + 1,
      }),
    ContractValidationError,
  );
});
