import test, { type TestContext } from "node:test";
import { workflowDeploymentFixture } from "./workflow-deployment.test-support.ts";
import { sqliteWorkflowDeploymentFixture } from "./sqlite-workflow-deployment.test-support.ts";

export type WorkflowDeploymentFixtureFactory =
  | typeof workflowDeploymentFixture
  | typeof sqliteWorkflowDeploymentFixture;
export function workflowStorageIntegrationTest(
  name: string,
  run: (context: TestContext, backend: "sqlite" | "postgres") => Promise<void>,
  options: { timeout?: number } = {},
) {
  for (const backend of ["sqlite", "postgres"] as const)
    test(
      `${backend}: ${name}`,
      {
        ...options,
        skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
      },
      (context) => run(context, backend),
    );
}

/** The same acceptance assertions run against each real storage/host adapter. */
export function workflowDeploymentIntegrationTest(
  name: string,
  run: (
    context: TestContext,
    fixture: WorkflowDeploymentFixtureFactory,
  ) => Promise<void>,
) {
  workflowStorageIntegrationTest(name, (context, backend) =>
    run(
      context,
      backend === "sqlite"
        ? sqliteWorkflowDeploymentFixture
        : workflowDeploymentFixture,
    ),
  );
}
