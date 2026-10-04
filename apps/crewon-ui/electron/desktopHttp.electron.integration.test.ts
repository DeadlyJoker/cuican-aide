import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { it } from "vitest";
import { trackDesktopTestChildren } from "./desktopPluginTestChildren.test-support.ts";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDirectory, "../../..");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Real hidden Electron/Chromium, original preload and transport modules; only the
 * three IPC registrations are test-owned. Not formal Main/Control/real task proof.
 * Like the other native integration suites, explicit opt-in avoids launching a GUI
 * runtime in ordinary/headless UI tests. Run on a desktop with Node24:
 * CREWON_TEST_ELECTRON_HTTP_EOF=1 pnpm --filter @crewon/ui exec vitest run electron/desktopHttp.electron.integration.test.ts
 */
it.runIf(process.env.CREWON_TEST_ELECTRON_HTTP_EOF === "1")(
  "original hidden Electron preload and Chromium global fetch complete owned JSON GET/POST responses through real IPC including EOF within the 5s caller deadline",
  async () => {
    assert.match(process.version, /^v24\./u);
    const directory = await mkdtemp(
      join(tmpdir(), "crewon-electron-http-eof-"),
    );
    const evidence = process.env.CREWON_ELECTRON_HTTP_EOF_EVIDENCE_DIRECTORY
      ? resolve(process.env.CREWON_ELECTRON_HTTP_EOF_EVIDENCE_DIRECTORY)
      : join(directory, "evidence");
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const userData = join(directory, "profile");
    await mkdir(userData, { mode: 0o700 });
    const sockets = new Set<Socket>();
    const socketJoins: Promise<void>[] = [];
    const http: Array<Record<string, unknown>> = [];
    const failures: unknown[] = [];
    const requestTasks = new Set<Promise<void>>();
    const small = JSON.stringify({ fixture: "owned-ipc", complete: true });
    const postBody = JSON.stringify({
      kind: "named-test-ack",
      idempotencyKey: "owned-loopback-key",
      input: { prompt: "fixture-only" },
    });
    const ack = JSON.stringify({
      disposition: "replayed",
      threadId: "named-loopback-thread",
      threadRevision: 4,
      runId: "named-loopback-run",
      messageId: "named-loopback-message",
      configurationRevision: 1,
      // ACK-sized transport fixture, not a real receipt or a public DTO assertion.
      fixtureOnlyPayload: "x".repeat(2048),
    });
    const unicode = JSON.stringify({ text: "分片🙂响应", fixture: true });
    const server = createServer((request, response) => {
      const task = (async () => {
        const started = performance.now();
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          assert.ok(bytes <= 4096);
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const path = request.url;
        assert.ok(["/small", "/ack", "/utf8", "/empty"].includes(path!));
        assert.equal(request.method, path === "/ack" ? "POST" : "GET");
        assert.equal(body, path === "/ack" ? postBody : "");
        const text =
          path === "/ack"
            ? ack
            : path === "/utf8"
              ? unicode
              : path === "/empty"
                ? ""
                : small;
        const record: Record<string, unknown> = {
          method: request.method,
          path,
          requestBytes: bytes,
          responseBytes: Buffer.byteLength(text),
          status: 200,
          requestBodyCompleteMs: performance.now() - started,
        };
        http.push(record);
        response.on("finish", () => {
          record.responseFinishMs = performance.now() - started;
        });
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        if (path === "/utf8") {
          const buffer = Buffer.from(text);
          const split = buffer.indexOf(Buffer.from("🙂")) + 2;
          response.write(buffer.subarray(0, split));
          await new Promise((done) => setTimeout(done, 20));
          response.end(buffer.subarray(split));
        } else {
          response.setHeader("Content-Length", Buffer.byteLength(text));
          response.end(text);
        }
      })().catch((error) => {
        failures.push(error);
        response.destroy();
      });
      requestTasks.add(task);
      void task.finally(() => requestTasks.delete(task));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socketJoins.push(
        new Promise((done) =>
          socket.once("close", () => {
            sockets.delete(socket);
            done();
          }),
        ),
      );
    });
    let child: ChildProcess | undefined;
    let tracked: ReturnType<typeof trackDesktopTestChildren> | undefined;
    let completion: Promise<void> | undefined;
    let mainClosed = false;
    let code: number | null = null;
    let output = "";
    let primaryFailure: unknown;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let retired = false;
    try {
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const preload = join(directory, "preload.cjs");
      const launcher = join(directory, "hidden-electron-http.mjs");
      const renderer = join(directory, "renderer-http.mjs");
      const document = join(directory, "index.html");
      const configPath = join(directory, "config.json");
      const proofPath = join(evidence, "electron-http-proof.json");
      const originalSources = [
        join(sourceDirectory, "preload.ts"),
        join(sourceDirectory, "desktopHttp.ts"),
        join(sourceDirectory, "desktopHttpReply.ts"),
        join(sourceDirectory, "desktopHttpLifetime.ts"),
        join(sourceDirectory, "../src/lib/desktop/desktopFetch.ts"),
        join(sourceDirectory, "../src/lib/desktop/desktopHttpClientBudget.ts"),
      ];
      const preserved = await Promise.all(
        originalSources.map(async (path) => ({
          path,
          sha256: sha256(await readFile(path)),
        })),
      );
      try {
        await build({
          entryPoints: [join(sourceDirectory, "preload.ts")],
          outfile: preload,
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node24",
          external: ["electron"],
          legalComments: "none",
          logLevel: "silent",
        });
        await build({
          entryPoints: [
            join(
              sourceDirectory,
              "desktopHttp.electron.native.test-support.ts",
            ),
          ],
          outfile: launcher,
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node24",
          external: ["electron"],
          legalComments: "none",
          logLevel: "silent",
        });
        await build({
          stdin: {
            contents: `export {installDesktopFetch,desktopBridgeFetch} from './apps/crewon-ui/src/lib/desktop/desktopFetch.ts'; export {acquireDesktopHttpRequest} from './apps/crewon-ui/src/lib/desktop/desktopHttpClientBudget.ts';`,
            resolveDir: repositoryRoot,
            sourcefile: "owned-electron-http-renderer.ts",
          },
          outfile: renderer,
          bundle: true,
          platform: "browser",
          format: "esm",
          target: "chrome150",
          legalComments: "none",
          logLevel: "silent",
        });
      } finally {
        await stop();
      }
      await writeFile(
        document,
        "<!doctype html><meta charset=utf-8><title>Owned hidden Electron HTTP fixture</title>",
        { mode: 0o600 },
      );
      await writeFile(
        configPath,
        JSON.stringify({
          userData,
          preload,
          document,
          rendererModule: pathToFileURL(renderer).href,
          proof: proofPath,
          cases: [
            {
              name: "get-json",
              url: origin + "/small",
              method: "GET",
              body: null,
              expected: small,
            },
            {
              name: "post-json-ack",
              url: origin + "/ack",
              method: "POST",
              body: postBody,
              expected: ack,
            },
            {
              name: "fragmented-utf8",
              url: origin + "/utf8",
              method: "GET",
              body: null,
              expected: unicode,
            },
            {
              name: "empty200",
              url: origin + "/empty",
              method: "GET",
              body: null,
              expected: "",
            },
          ],
        }),
        { mode: 0o600 },
      );
      const environment = { ...process.env };
      for (const name of Object.keys(environment))
        if (
          name.startsWith("CREWON_") ||
          name.startsWith("ELECTRON_") ||
          name === "AICUICAN_API_KEY" ||
          name === "NODE_OPTIONS"
        )
          delete environment[name];
      child = spawn(
        createRequire(import.meta.url)("electron"),
        [launcher, configPath, `--user-data-dir=${userData}`],
        { env: environment, stdio: ["ignore", "pipe", "pipe"] },
      );
      tracked = trackDesktopTestChildren(child);
      completion = new Promise<void>((done) => {
        child!.once("error", (error) => {
          failures.push(error);
        });
        child!.once("close", (exitCode) => {
          mainClosed = true;
          code = exitCode;
          done();
        });
      });
      for (const stream of [child.stdout!, child.stderr!])
        stream.on("data", (bytes: Buffer) => {
          output += bytes.toString();
          if (output.length > 256 * 1024) {
            failures.push(new Error("owned_electron_output_limit"));
            child?.kill("SIGTERM");
          }
        });
      timeout = setTimeout(() => {
        failures.push(new Error("owned_electron_timeout"));
        child?.kill("SIGTERM");
      }, 25_000);
      await completion;
      clearTimeout(timeout);
      assert.equal(code, 0, output);
      assert.deepEqual(failures, []);
      const proof = JSON.parse(await readFile(proofPath, "utf8"));
      assert.equal(proof.renderer.cases.length, 4);
      assert.equal(proof.renderer.chromiumGlobalDelegate, true);
      assert.equal(proof.formalMainRegistrationCovered, false);
      assert.match(proof.electronVersion, /^43\./u);
      assert.match(proof.renderer.userAgent, /Chrome\//u);
      assert.ok(
        proof.renderer.cases.every(
          (row: { totalMs: number }) => row.totalMs < 5000,
        ),
      );
      assert.equal(http.length, 4);
      for (const file of preserved)
        assert.equal(
          sha256(await readFile(file.path)),
          file.sha256,
          "production_transport_source_unchanged",
        );
      await writeFile(
        join(evidence, "electron-http-results.json"),
        JSON.stringify(
          {
            scope:
              "hidden test-owned IPC registration; original preload/HTTP modules/Chromium delegate",
            formalMainCovered: false,
            originalRequestCovered: false,
            proof,
            http,
            originalSources: preserved,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    } catch (error) {
      primaryFailure = error;
    } finally {
      const cleanup: unknown[] = [];
      if (timeout) clearTimeout(timeout);
      if (child && !mainClosed) {
        child.kill("SIGTERM");
        const force = setTimeout(() => child?.kill("SIGKILL"), 1500);
        try {
          await completion;
        } catch (error) {
          cleanup.push(error);
        } finally {
          clearTimeout(force);
        }
      }
      let forcedChildren: readonly number[] = [];
      try {
        forcedChildren = (await tracked?.close()) ?? [];
      } catch (error) {
        cleanup.push(error);
      }
      const serverClose = server.listening
        ? new Promise<void>((done, reject) =>
            server.close((error) => (error ? reject(error) : done())),
          )
        : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      try {
        await serverClose;
        await Promise.all(socketJoins);
        await Promise.all([...requestTasks]);
      } catch (error) {
        cleanup.push(error);
      }
      retired =
        (!child || mainClosed) &&
        cleanup.length === 0 &&
        sockets.size === 0 &&
        !server.listening;
      await writeFile(join(evidence, "electron-http-app.log"), output, {
        mode: 0o600,
      });
      await writeFile(
        join(evidence, "electron-http-retirement.json"),
        JSON.stringify(
          {
            mainClosed,
            mainPid: child?.pid,
            forcedChildren,
            serverClosed: !server.listening,
            socketsRemaining: sockets.size,
            requestTasksRemaining: requestTasks.size,
            retired,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      if (
        retired &&
        primaryFailure === undefined &&
        forcedChildren.length === 0
      )
        await rm(directory, { recursive: true });
      if (cleanup.length || primaryFailure !== undefined)
        throw new AggregateError(
          [
            ...(primaryFailure === undefined ? [] : [primaryFailure]),
            ...cleanup,
          ],
          "owned_electron_http_failed",
        );
      assert.ok(retired);
      assert.deepEqual(
        forcedChildren,
        [],
        "normal hidden Electron retirement must not need forced child kills",
      );
    }
  },
  40_000,
);
