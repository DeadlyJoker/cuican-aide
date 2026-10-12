// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createServer as httpServer } from "node:http";
import { createServer } from "vite";
import viteConfig from "../vite.config";

afterEach(() => vi.unstubAllEnvs());
it("forwards both Control versions with the same authenticated origin", async () => {
  const requests: { path: string; authorization?: string; origin?: string }[] =
    [];
  const upstream = httpServer((request, response) => {
    requests.push({
      path: request.url!,
      authorization: request.headers.authorization,
      origin: request.headers.origin,
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ view: null }));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("upstream_missing");
  vi.stubEnv("CREWON_CONTROL_TARGET", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("CREWON_CONTROL_SESSION_TOKEN", "test-session");
  vi.stubEnv("CREWON_CONTROL_CSRF_TOKEN", "test-csrf");
  vi.stubEnv("CREWON_CONTROL_ORIGIN", "http://crewon.localhost");
  const config = await viteConfig({ command: "serve", mode: "test" });
  const server = await createServer({
    ...config,
    configFile: false,
    server: { ...config.server, host: "127.0.0.1", port: 0, strictPort: false },
  });
  try {
    await server.listen();
    const uiAddress = server.httpServer!.address();
    if (!uiAddress || typeof uiAddress === "string")
      throw new Error("ui_missing");
    for (const path of [
      "/api/v1/threads/fixture/project-conversation",
      "/api/v2/creative-projects/fixture/outline",
    ]) {
      const response = await fetch(`http://127.0.0.1:${uiAddress.port}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ view: null });
    }
    expect(requests).toEqual([
      {
        path: "/api/v1/threads/fixture/project-conversation",
        authorization: "Bearer test-session",
        origin: "http://crewon.localhost",
      },
      {
        path: "/api/v2/creative-projects/fixture/outline",
        authorization: "Bearer test-session",
        origin: "http://crewon.localhost",
      },
    ]);
  } finally {
    await server.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
