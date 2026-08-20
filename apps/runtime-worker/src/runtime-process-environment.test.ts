import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelTransport,
  validateResponsesTransportSecurity,
} from "./runtime-process-environment.ts";

test("production Responses transports require TLS and durable retrieval", () => {
  assert.doesNotThrow(() =>
    validateResponsesTransportSecurity(
      {
        endpoint: "https://provider.example/v1/responses",
        storeResponses: true,
      },
      "production",
    ),
  );
  assert.throws(
    () =>
      validateResponsesTransportSecurity(
        {
          endpoint: "http://provider.example/v1/responses",
          storeResponses: true,
        },
        "production",
      ),
    /production_responses_https_required/u,
  );
  assert.throws(
    () =>
      validateResponsesTransportSecurity(
        {
          endpoint: "https://provider.example/v1/responses",
          storeResponses: false,
        },
        "production",
      ),
    /production_response_retrieval_required/u,
  );
  assert.doesNotThrow(() =>
    validateResponsesTransportSecurity(
      {
        endpoint: "http://127.0.0.1:8080/v1/responses",
        storeResponses: false,
      },
      "standalone",
    ),
  );
});

test("production ambient transport rejects disabled response storage", () => {
  withEnvironment(
    {
      CREWON_MODEL_ID: "provider-model",
      CREWON_RESPONSES_ENDPOINT: "https://provider.example/v1/responses",
      CREWON_RESPONSES_STORE: "false",
    },
    () =>
      assert.throws(
        () => createModelTransport({ securityMode: "production" }),
        /production_response_retrieval_required/u,
      ),
  );
});

test("production ambient transport exposes retrieval when storage is enabled", () => {
  withEnvironment(
    {
      CREWON_MODEL_ID: "provider-model",
      CREWON_RESPONSES_ENDPOINT: "https://provider.example/v1/responses",
      CREWON_RESPONSES_STORE: "true",
    },
    () => {
      const transport = createModelTransport({ securityMode: "production" });
      assert.equal(transport.supportsResponseRetrieve, true);
    },
  );
});

test("standalone loopback transport may opt out of response storage", () => {
  withEnvironment(
    {
      CREWON_MODEL_ID: "local-model",
      CREWON_RESPONSES_ENDPOINT: "http://127.0.0.1:8080/v1/responses",
      CREWON_RESPONSES_STORE: "false",
    },
    () => {
      const transport = createModelTransport({ securityMode: "standalone" });
      assert.equal(transport.supportsResponseRetrieve, false);
    },
  );
});

function withEnvironment(
  values: Readonly<Record<string, string>>,
  action: () => void,
): void {
  const previous = new Map(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, values);
    action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
