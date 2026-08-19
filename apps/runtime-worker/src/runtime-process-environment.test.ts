import assert from "node:assert/strict";
import test from "node:test";

import { validateResponsesEndpointSecurity } from "./runtime-process-environment.ts";

test("production Responses endpoints require TLS before transport creation", () => {
  assert.doesNotThrow(() =>
    validateResponsesEndpointSecurity(
      "https://provider.example/v1/responses",
      "production",
    ),
  );
  assert.throws(
    () =>
      validateResponsesEndpointSecurity(
        "http://provider.example/v1/responses",
        "production",
      ),
    /production_responses_https_required/u,
  );
  assert.throws(
    () =>
      validateResponsesEndpointSecurity(
        "http://127.0.0.1:8080/v1/responses",
        "production",
      ),
    /production_responses_https_required/u,
  );
  assert.doesNotThrow(() =>
    validateResponsesEndpointSecurity(
      "http://127.0.0.1:8080/v1/responses",
      "standalone",
    ),
  );
});
