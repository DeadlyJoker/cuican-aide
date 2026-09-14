import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesProtocolDecoder } from "./responses-protocol.ts";

for (const status of ["failed", "incomplete"] as const) {
  test(`${status} responses preserve validated usage and response identity, including unknown cache reporting`, () => {
    for (const cached of [undefined, 0, 80]) {
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy: "required",
        completedCheckpoint: () => null,
      });
      decoder.accept({
        type: "response.created",
        sequence_number: 0,
        response: { id: "response-1" },
      });
      const projected = decoder.accept({
        type: `response.${status}`,
        sequence_number: 1,
        response: {
          id: "response-1",
          status,
          error: { code: "server_error" },
          incomplete_details: { reason: "max_output_tokens" },
          usage: {
            input_tokens: 100,
            ...(cached === undefined
              ? {}
              : { input_tokens_details: { cached_tokens: cached } }),
            output_tokens: 10,
            total_tokens: 110,
          },
        },
      });
      assert.deepEqual(projected[0], {
        type: "usage",
        providerResponseId: "response-1",
        responseStatus: status,
        inputTokens: 100,
        cachedInputTokens: cached ?? 0,
        cachedInputTokensReported: cached !== undefined,
        outputTokens: 10,
        totalTokens: 110,
      });
      assert.equal(projected[1]?.type, "failed");
      decoder.finish();
    }
  });
  test(`${status} responses reject contradictory usage and foreign response identity`, () => {
    for (const response of [
      {
        id: "response-1",
        status,
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens: 0,
          total_tokens: 1,
        },
      },
      {
        id: "other-response",
        status,
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      },
    ]) {
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy: "required",
        completedCheckpoint: () => null,
      });
      decoder.accept({
        type: "response.created",
        sequence_number: 0,
        response: { id: "response-1" },
      });
      assert.throws(() =>
        decoder.accept({
          type: `response.${status}`,
          sequence_number: 1,
          response,
        }),
      );
    }
  });
}
