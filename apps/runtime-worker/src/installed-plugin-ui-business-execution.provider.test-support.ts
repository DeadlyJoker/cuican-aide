import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";

type Report = {
  status: "succeeded";
  executionId: string;
  report: string;
  pluginVersion: string;
};

/** Real HTTP supplier fixture. Receipts and effects survive closing both server and database. */
export async function professionalProviderFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-report-provider-"));
  await mkdir(join(directory, "receipts"));
  const databasePath = join(directory, "receipts", "provider.sqlite");
  let database: DatabaseSync;
  let server: Server;
  let port = 0;
  let closed = false;

  function openDatabase() {
    database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE IF NOT EXISTS reports(execution_id TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(sequence INTEGER PRIMARY KEY, method TEXT NOT NULL, execution_id TEXT NOT NULL, body TEXT);
    `);
  }
  async function start() {
    openDatabase();
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, "http://fixture.invalid");
        const method = request.method!;
        let executionId: string;
        let body: Record<string, unknown> | null = null;
        if (method === "POST" && url.pathname === "/reports") {
          body = await requestBody(request);
          assert.deepEqual(Object.keys(body).sort(), [
            "executionId",
            "organization",
            "pluginVersion",
            "subject",
          ]);
          for (const field of Object.values(body))
            assert.equal(typeof field, "string");
          executionId = body.executionId as string;
          const result: Report = {
            status: "succeeded",
            executionId,
            report: `professional:${body.pluginVersion}:${body.organization}:${body.subject}`,
            pluginVersion: body.pluginVersion as string,
          };
          database
            .prepare("INSERT OR IGNORE INTO reports VALUES(?, ?)")
            .run(executionId, JSON.stringify(result));
        } else {
          assert.ok(method === "GET" || method === "DELETE");
          assert.ok(url.pathname.startsWith("/reports/"));
          executionId = decodeURIComponent(
            url.pathname.slice("/reports/".length),
          );
        }
        database
          .prepare(
            "INSERT INTO requests(method, execution_id, body) VALUES(?, ?, ?)",
          )
          .run(
            method,
            executionId,
            body === null ? null : JSON.stringify(body),
          );
        const saved = database
          .prepare("SELECT result FROM reports WHERE execution_id = ?")
          .get(executionId) as { result: string } | undefined;
        response.setHeader("content-type", "application/json");
        response.end(
          saved?.result ??
            JSON.stringify({ status: "unknownOutcome", executionId }),
        );
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    port = address.port;
    closed = false;
  }
  async function stop() {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async restart() {
      await stop();
      await start();
    },
    requests: () =>
      database
        .prepare(
          "SELECT method, execution_id AS executionId, body FROM requests ORDER BY sequence",
        )
        .all() as Array<{
        method: string;
        executionId: string;
        body: string | null;
      }>,
    reports: () =>
      database
        .prepare("SELECT result FROM reports ORDER BY execution_id")
        .all()
        .map((row) => JSON.parse(row.result as string) as Report),
  };
}

async function requestBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    assert.ok(bytes <= 16 * 1024);
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
