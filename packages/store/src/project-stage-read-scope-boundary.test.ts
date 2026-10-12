import assert from "node:assert/strict";
import test from "node:test";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnOptions,
} from "@crewon/application";
import { captureProjectStageTurn } from "./project-stage-run-store-support.ts";
// Malformed backend options only; no SQL, migration, task or authority fixture.
test("Stage read source requires its actual Stage authority and rejects accessors without executing them", () => {
  const empty = {} as CommitExtensionTurnInput;
  assert.throws(
    () =>
      captureProjectStageTurn(empty, {
        projectStageReadScope: {
          version: "crewon.plugin-project-read-scope.v1",
        },
      }),
    /project_stage_admission_required/u,
  );
  let calls = 0;
  const accessor = Object.defineProperty({}, "projectStageReadScope", {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  assert.throws(
    () =>
      captureProjectStageTurn(empty, accessor as CommitExtensionTurnOptions),
    /project_foundation_stage_read_scope_invalid/u,
  );
  assert.equal(calls, 0);
  assert.throws(
    () => captureProjectStageTurn(empty, { projectStageReadScope: undefined }),
    /project_foundation_stage_read_scope_invalid/u,
  );
});
