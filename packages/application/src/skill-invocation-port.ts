import type {
  SkillInvocationSpec,
  SkillVersion,
  SkillVersionRef,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { RunRoute } from "./run-commands.ts";

export type SkillAdmissionPurpose = "schedule" | "execute" | "trial";
export type SkillAdmission = Readonly<{
  invocation: SkillInvocationSpec;
  version: SkillVersion;
  context: string;
  agentVersionId: string;
}>;
/** A fresh check is mandatory at each execution. An admission is not a permission grant. */
export interface SkillInvocationPort {
  resolveVersion(
    actor: ActorContext,
    ref: SkillVersionRef,
  ): Promise<SkillVersion>;
  admitInvocation(
    actor: ActorContext,
    spec: SkillInvocationSpec,
    options: {
      purpose: SkillAdmissionPurpose;
      route: RunRoute;
    },
  ): Promise<SkillAdmission>;
}
export interface SkillExecutionAuthorizationPort {
  authorize(input: {
    actor: ActorContext;
    skillId: string;
    purpose: SkillAdmissionPurpose | "read" | "write";
    requiredToolRefs: readonly string[];
    route: RunRoute | null;
  }): Promise<{ outcome: "allow" } | { outcome: "deny"; reasonCode: string }>;
}
