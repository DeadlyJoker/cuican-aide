import { DeterministicFakeModelTransport } from "@crewon/agent-kernel";

// Subprocess-only fault injection: exercise the actual CLI shutdown branch.
Object.defineProperty(DeterministicFakeModelTransport.prototype, "close", {
  value() {
    throw new Error("fixture_model_close_failed");
  },
});
