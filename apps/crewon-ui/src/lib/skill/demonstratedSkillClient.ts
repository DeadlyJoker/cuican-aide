import type {
  SkillInvocationSpec,
  SkillMethod,
  SkillRecordingSource,
  SkillVersion,
  SkillVersionRef,
} from "@crewon/domain/demonstrated-skill";

/** Read projections only. The host remains authoritative for admission. */
export type DemonstratedSkillView = {
  skillId: string;
  revision: number;
  draft: SkillMethod;
  source: SkillRecordingSource;
  disabled: boolean;
  deleted: boolean;
  activatedVersionIds: readonly string[];
};
export type SkillCoverage = "new-date" | "new-input" | "handled-exception";
export type SkillExecutionView = {
  executionId: string;
  invocation: SkillInvocationSpec;
  purpose: "trial" | "execute";
  runId: string | null;
  status: string;
  verification: "real" | "simulated" | "unknown";
  createdAt: string;
  review: {
    confirmedAt: string;
    criteria: readonly string[];
    coverage: readonly SkillCoverage[];
    resultNote?: string;
  } | null;
};
export type DemonstratedSkillDetail = {
  skill: DemonstratedSkillView;
  versions: readonly SkillVersion[];
  executions: readonly SkillExecutionView[];
};
export type SkillExecutionTarget = {
  threadId: string;
  expectedThreadRevision: number;
  agentVersionId: string | null;
};
export type SkillExecutionInput = SkillExecutionTarget & {
  executionId: string;
  purpose: "trial" | "execute";
  invocation: SkillInvocationSpec;
};
export type SkillExecutionAttempt = {
  executionId: string;
  purpose: "trial" | "execute";
  invocation: SkillInvocationSpec;
  command: SkillExecutionInput | null;
  browserChoice?: "perAction" | "authorized";
};
export type SkillExecutionAttemptStore = {
  get(): SkillExecutionAttempt | null;
  set(attempt: SkillExecutionAttempt | null): void;
};
export type SkillGenerationInput = SkillExecutionTarget & {
  generationId: string;
  expectedSkillRevision: number;
};
export type SkillGenerationView = {
  generationId: string;
  skillId: string;
  expectedSkillRevision: number;
  runId: string | null;
  status: string;
  verification: "real" | "simulated" | "unknown";
  outcome: "pending" | "candidate" | "invalid";
  candidate: SkillMethod | null;
  reasonCode: string | null;
  appliedRevision: number | null;
  createdAt: string;
};
export type SkillGenerationAttempt = {
  generationId: string;
  expectedSkillRevision: number;
  command: SkillGenerationInput | null;
};
export type SkillGenerationAttemptStore = {
  get(): SkillGenerationAttempt | null;
  set(attempt: SkillGenerationAttempt | null): void;
};
export type SkillReviewInput = {
  criteria: string[];
  coverage: SkillCoverage[];
  resultNote: string;
};
export interface DemonstratedSkillClient {
  list(query?: {
    after?: string;
    limit?: number;
  }): Promise<readonly DemonstratedSkillView[]>;
  read(skillId: string): Promise<DemonstratedSkillDetail>;
  listGenerations(skillId: string): Promise<readonly SkillGenerationView[]>;
  readGeneration(
    skillId: string,
    generationId: string,
  ): Promise<SkillGenerationView>;
  startGeneration(
    skillId: string,
    input: SkillGenerationInput,
  ): Promise<SkillGenerationView>;
  collectGeneration(
    skillId: string,
    generationId: string,
  ): Promise<SkillGenerationView>;
  applyGeneration(
    skillId: string,
    generationId: string,
    expectedSkillRevision: number,
  ): Promise<SkillGenerationView>;
  saveDraft(
    skillId: string,
    expectedRevision: number,
    method: SkillMethod,
  ): Promise<void>;
  createVersion(skillId: string, expectedRevision: number): Promise<void>;
  startExecution(skillId: string, input: SkillExecutionInput): Promise<void>;
  reviewExecution(
    skillId: string,
    executionId: string,
    review: SkillReviewInput,
  ): Promise<void>;
  activate(
    skillId: string,
    expectedRevision: number,
    version: SkillVersionRef,
  ): Promise<void>;
  setDisabled(
    skillId: string,
    expectedRevision: number,
    disabled: boolean,
  ): Promise<void>;
}

/** Inject the Control session transport; this adapter never invents credentials. */
export function createDemonstratedSkillClient(
  request: (path: string, init?: RequestInit) => Promise<Response>,
): DemonstratedSkillClient {
  const pathFor = (skillId: string) =>
    `/api/v1/skills/${encodeURIComponent(skillId)}`;
  async function call(path: string, method: string, body?: unknown) {
    const response = await request(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const envelope =
        data && typeof data === "object" && "error" in data ? data.error : null;
      const code =
        typeof envelope === "string"
          ? envelope
          : envelope &&
              typeof envelope === "object" &&
              "code" in envelope &&
              typeof envelope.code === "string"
            ? envelope.code
            : `skill_http_${response.status}`;
      throw new Error(code);
    }
    return response;
  }
  return {
    async list(query = {}) {
      const search = new URLSearchParams();
      if (query.after) search.set("after", query.after);
      if (query.limit !== undefined) search.set("limit", String(query.limit));
      const response = await call(
        `/api/v1/skills${search.size ? `?${search}` : ""}`,
        "GET",
      );
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== "object" ||
        !("skills" in data) ||
        !Array.isArray(data.skills)
      )
        throw new Error("skill_list_invalid");
      return data.skills as DemonstratedSkillView[];
    },
    async read(id) {
      return (await call(pathFor(id), "GET")).json();
    },
    async listGenerations(id) {
      const response = await call(`${pathFor(id)}/generations`, "GET");
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== "object" ||
        !("generations" in data) ||
        !Array.isArray(data.generations)
      )
        throw new Error("skill_generations_invalid");
      return data.generations as SkillGenerationView[];
    },
    async readGeneration(id, generationId) {
      return (
        await call(
          `${pathFor(id)}/generations/${encodeURIComponent(generationId)}`,
          "GET",
        )
      ).json();
    },
    async startGeneration(id, input) {
      return (await call(`${pathFor(id)}/generations`, "POST", input)).json();
    },
    async collectGeneration(id, generationId) {
      return (
        await call(
          `${pathFor(id)}/generations/${encodeURIComponent(generationId)}/collect`,
          "POST",
          {},
        )
      ).json();
    },
    async applyGeneration(id, generationId, expectedSkillRevision) {
      return (
        await call(
          `${pathFor(id)}/generations/${encodeURIComponent(generationId)}/apply`,
          "POST",
          { expectedSkillRevision },
        )
      ).json();
    },
    async saveDraft(id, expectedRevision, method) {
      await call(pathFor(id), "PATCH", { expectedRevision, method });
    },
    async createVersion(id, expectedRevision) {
      await call(`${pathFor(id)}/versions`, "POST", { expectedRevision });
    },
    async startExecution(id, input) {
      await call(`${pathFor(id)}/executions`, "POST", input);
    },
    async reviewExecution(id, executionId, review) {
      await call(
        `${pathFor(id)}/executions/${encodeURIComponent(executionId)}/review`,
        "POST",
        review,
      );
    },
    async activate(id, expectedRevision, version) {
      await call(`${pathFor(id)}/activate`, "POST", {
        expectedRevision,
        version,
      });
    },
    async setDisabled(id, expectedRevision, disabled) {
      await call(`${pathFor(id)}/disable`, "POST", {
        expectedRevision,
        disabled,
      });
    },
  };
}
