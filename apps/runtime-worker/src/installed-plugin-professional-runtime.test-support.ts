import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  installLocalPluginPackage,
  PluginExecutionPackage,
  type PluginExecutionPackageBorrow,
} from "@crewon/plugin-host";
import type {
  PluginToolExecutionCommand,
  PluginToolExecutionResolution,
  PluginToolExecutionResultAcknowledgement,
  PluginToolRuntime,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";

const digest = (value: string) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ReportBody = Readonly<{
  executionId: string;
  organization: string;
  pluginVersion: string;
  subject: string;
}>;
type Plan = Readonly<{
  kind: "success" | "unknown" | "hold" | "errorStream";
  started: ReturnType<typeof deferred>;
  released: ReturnType<typeof deferred>;
  connectionClosed: ReturnType<typeof deferred>;
}>;

/** Real HTTP and a durable supplier ledger. Plans control physical responses, never mock fetch. */
async function providerFixture(directory: string) {
  const database = new DatabaseSync(join(directory, "provider.sqlite"));
  database.exec(`
    CREATE TABLE requests(sequence INTEGER PRIMARY KEY, method TEXT NOT NULL, execution_id TEXT NOT NULL, body TEXT);
    CREATE TABLE reports(execution_id TEXT PRIMARY KEY, result TEXT NOT NULL);
  `);
  const plans: Plan[] = [];
  const active = new Set<Plan>();
  const failures: unknown[] = [];
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      failures.push(error);
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url!, "http://fixture.invalid");
    const method = request.method!;
    let executionId: string;
    let body: ReportBody | null = null;
    let plan: Plan | undefined;
    if (method === "POST" && url.pathname === "/reports") {
      body = await requestBody(request);
      executionId = body.executionId;
      plan = plans.shift();
    } else {
      assert.ok(method === "GET" || method === "DELETE");
      assert.ok(url.pathname.startsWith("/reports/"));
      executionId = decodeURIComponent(url.pathname.slice("/reports/".length));
    }
    database
      .prepare(
        "INSERT INTO requests(method, execution_id, body) VALUES(?, ?, ?)",
      )
      .run(method, executionId, body === null ? null : JSON.stringify(body));
    response.setHeader("content-type", "application/json");
    if (plan) {
      active.add(plan);
      request.socket.once("close", () => plan!.connectionClosed.resolve());
      plan.started.resolve();
      if (plan.kind === "errorStream") {
        response.statusCode = 503;
        response.write('{"unfinished":');
        const interval = setInterval(() => response.write(" "), 10);
        intervals.add(interval);
        response.once("close", () => {
          clearInterval(interval);
          intervals.delete(interval);
          active.delete(plan!);
        });
        return;
      }
      if (plan.kind === "hold") await plan.released.promise;
    }
    if (body && plan?.kind !== "unknown") save(body);
    const saved = database
      .prepare("SELECT result FROM reports WHERE execution_id = ?")
      .get(executionId) as { result: string } | undefined;
    response.end(
      saved?.result ??
        JSON.stringify({ status: "unknownOutcome", executionId }),
    );
    if (plan) active.delete(plan);
  }

  function save(body: ReportBody) {
    database.prepare("INSERT OR IGNORE INTO reports VALUES(?, ?)").run(
      body.executionId,
      JSON.stringify({
        status: "succeeded",
        executionId: body.executionId,
        report: `professional:${body.pluginVersion}:${body.organization}:${body.subject}`,
        pluginVersion: body.pluginVersion,
      }),
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    plan(kind: Plan["kind"]) {
      const plan: Plan = {
        kind,
        started: deferred(),
        released: deferred(),
        connectionClosed: deferred(),
      };
      plans.push(plan);
      return {
        started: plan.started.promise,
        connectionClosed: plan.connectionClosed.promise,
        release: plan.released.resolve,
      };
    },
    resolve(executionId: string) {
      const row = database
        .prepare(
          "SELECT body FROM requests WHERE execution_id = ? AND method = 'POST' ORDER BY sequence LIMIT 1",
        )
        .get(executionId) as { body: string } | undefined;
      assert.ok(row);
      save(JSON.parse(row.body) as ReportBody);
    },
    requests() {
      return database
        .prepare(
          "SELECT method, execution_id AS executionId, body FROM requests ORDER BY sequence",
        )
        .all()
        .map((row) => ({
          method: row.method as string,
          executionId: row.executionId as string,
          body:
            row.body === null
              ? null
              : (JSON.parse(row.body as string) as ReportBody),
        }));
    },
    releaseAll() {
      for (const plan of active) plan.released.resolve();
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const plan of active) plan.released.resolve();
      for (const interval of intervals) clearInterval(interval);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      database.close();
      if (failures.length)
        throw new AggregateError(
          failures,
          "professional_supplier_fixture_failed",
        );
    },
  };
}

async function requestBody(request: IncomingMessage): Promise<ReportBody> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    assert.ok(bytes <= 16 * 1024);
    chunks.push(buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReportBody;
  assert.deepEqual(Object.keys(body).sort(), [
    "executionId",
    "organization",
    "pluginVersion",
    "subject",
  ]);
  for (const value of Object.values(body)) assert.equal(typeof value, "string");
  return body;
}

/** Uses the separately built, installed SDK package. Context values are explicit host test ports. */
export async function professionalRuntimeFixture(t: TestContext) {
  const packageDirectory = process.env.CREWON_TEST_BUSINESS_PLUGIN_V1_DIR;
  assert.ok(
    packageDirectory,
    "Run the installed-plugin example bootstrap, or provide its built V1 package directory",
  );
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-professional-runtime-"),
  );
  const provider = await providerFixture(directory);
  let owner: PluginExecutionPackage | null = null;
  let borrow: PluginExecutionPackageBorrow | null = null;
  let runtime: PluginToolRuntime | null = null;
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    provider.releaseAll();
    const failures: unknown[] = [];
    for (const close of [
      async () => {
        await runtime?.close?.();
      },
      async () => {
        borrow?.release();
        await owner?.close();
      },
      () => provider.close(),
      () => removeOwnedDirectory(directory),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "professional_runtime_fixture_cleanup_failed",
      );
  }
  t.after(cleanup);
  try {
    await mkdir(join(directory, "installed"));
    const installed = await installLocalPluginPackage({
      directory: packageDirectory,
      installRoot: join(directory, "installed"),
      authorization: async () => ({ outcome: "allow" }),
    });
    owner = await PluginExecutionPackage.open({
      activation: {
        installRoot: join(directory, "installed"),
        expectedPluginId: installed.descriptor.pluginId,
        expectedPackageDigest: installed.packageDigest,
        authorizeActivation: () => "allow",
      },
      commit: { authorizeCommit: () => "allow" },
    });
    borrow = owner.acquire({
      purpose: "newOperation",
      authorizeBorrow: () => "allow",
    });
    const context: PluginToolRuntimeContext = {
      identity: borrow.identity,
      scope: {
        tenantId: "tenant_professional",
        spaceId: "space_professional",
        profileId: "profile_professional",
      },
      run: {
        runId: "run_professional",
        threadId: "thread_professional",
        bindingDigest: digest("binding"),
        inputDigest: digest("run input"),
        source: null,
      },
      configuration: {
        revision: 1,
        contentDigest: digest("configuration"),
        parameters: {
          organization: "专业公司",
          providerBaseUrl: provider.baseUrl,
        },
        credentialBindings: [],
      },
      target: {
        executionAuthority: "crewonKernel",
        agentVersionId: "agent_professional",
        agentVersionContentDigest: digest("agent"),
        materializationDigest: digest("materialization"),
        authorityId: "authority_professional",
        runtimeGeneration: "generation_professional",
        policySnapshotId: "policy_professional",
        workspaceBindingId: null,
      },
    };
    runtime = await borrow.factory.create(context);
    const actual = runtime;
    function command(
      executionId: string,
      subject = `subject:${executionId}`,
    ): PluginToolExecutionCommand {
      const kind = "function";
      const name = "example_professional__generate";
      const policy = actual.executionPolicy(kind, name);
      assert.ok(policy);
      const input = JSON.stringify({ subject });
      const actionIntent: PluginToolExecutionCommand["actionIntent"] = {
        schemaVersion: "crewon.action-intent.v0" as const,
        runId: context.run.runId,
        segmentId: "segment_professional",
        callId: "call_" + executionId,
        tool: { kind, name, inputDigest: digest(input) },
        policySnapshotId: context.target.policySnapshotId,
        workspaceBindingId: context.target.workspaceBindingId,
        ...policy,
      };
      return {
        schemaVersion: "crewon.tool-invocation.v0",
        idempotencyKey: "key_" + executionId,
        runId: context.run.runId,
        segmentId: actionIntent.segmentId,
        callId: actionIntent.callId,
        kind,
        name,
        input,
        executionId,
        actionIntent,
        actionDigest: digest(canonicalActionIntent(actionIntent)),
        approvalProof: null,
        executionLease: {
          workItemId: "work_" + executionId,
          stepId: "step_" + executionId,
          attemptId: "attempt_" + executionId,
          leaseId: "lease_" + executionId,
          leaseEpoch: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      };
    }
    return { runtime: actual, context, provider, command };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function removeOwnedDirectory(directory: string) {
  // Installation seals package directories read-only; only this fixture's owned tree is reopened.
  async function writable(path: string) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await writable(join(path, entry.name));
  }
  await writable(directory);
  await rm(directory, { recursive: true, force: true });
}

export function acknowledgement(
  command: PluginToolExecutionCommand,
  resolution: PluginToolExecutionResolution,
): PluginToolExecutionResultAcknowledgement {
  return {
    executionId: command.executionId,
    idempotencyKey: command.idempotencyKey,
    actionDigest: command.actionDigest,
    actionIntent: command.actionIntent,
    status: resolution.status,
    providerReceiptId: resolution.providerReceiptId,
  };
}

export function lookup(command: PluginToolExecutionCommand) {
  return {
    executionId: command.executionId,
    idempotencyKey: command.idempotencyKey,
    actionDigest: command.actionDigest,
    actionIntent: command.actionIntent,
  };
}

export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("professional_fixture_physical_timeout")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
