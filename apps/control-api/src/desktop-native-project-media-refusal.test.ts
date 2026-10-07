import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { nativeMediaFlowFixture } from "./desktop-native-project-media-flow.test-support.ts";
import {
  PROJECT_MEDIA_GENERATE_UI_ACTION,
  PROJECT_MEDIA_RECOVERY_V2_UI_ACTION,
} from "@crewon/contracts/project-media-generations";
import { parseProjectMediaGenerationRecoveryResponse } from "@crewon/contracts/project-media-generation-recovery";

test(
  "Native Short28: verified pre-admission refusal survives database reopen and a corrected explicit request admits one original Run",
  { skip: process.platform === "win32", timeout: 180_000 },
  async (t) => {
    const f = await nativeMediaFlowFixture(t, {
      kind: "T10",
      packageDirectory: resolve(
        "output/extensions/installable-plugins/short-drama-media-refusal-20261007/short-drama/28.0.0",
      ),
    });
    const invalid = {
      ...f.body,
      projectId: f.query.projectId,
      mediaInputId: "missing-input",
      idempotencyKey: "native-refused-input",
    };
    await assert.rejects(f.invoke(PROJECT_MEDIA_GENERATE_UI_ACTION, invalid));
    const refused = parseProjectMediaGenerationRecoveryResponse(
      await f.invoke(PROJECT_MEDIA_RECOVERY_V2_UI_ACTION, null),
    );
    assert.equal(refused.intent?.phase, "refused");
    assert.equal(
      refused.intent?.reasonCode,
      "project_media_generation_not_admitted",
    );
    assert.equal(refused.intent?.retryable, false);
    assert.equal(f.provider.state.uploads, 0);
    await f.app.close();
    await f.runtime.close();
    const next = await f.reopen();
    const cold = await next.app.inject({
      method: "GET",
      url: `/api/v1/creative-projects/${f.query.projectId}/threads/${f.binding.threadId}/media-generation-recovery`,
      headers: next.headers,
    });
    assert.equal(cold.statusCode, 200, cold.body);
    assert.deepEqual(cold.json(), refused);
    const accepted = await next.app.inject({
      method: "POST",
      url: `/api/v1/creative-projects/${f.query.projectId}/media-generations`,
      headers: { ...next.headers, "idempotency-key": "native-fixed-input" },
      payload: { ...f.body, executionId: "native-fixed-execution" },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().threadId, f.binding.threadId);
    assert.equal(accepted.json().disposition, "committed");
    assert.equal(f.provider.state.uploads, 1);
  },
);
