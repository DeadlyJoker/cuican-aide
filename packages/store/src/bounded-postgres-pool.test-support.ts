import assert from "node:assert/strict";
import { createConnection, createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";

/** A real TCP fault boundary. Dropped response bytes are discarded, never buffered. */
export async function postgresResponseGate(
  context: TestContext,
  connectionString: string,
) {
  const target = new URL(connectionString);
  const host = target.searchParams.get("host") ?? target.hostname;
  const port = Number(target.searchParams.get("port") ?? (target.port || 5432));
  const sockets = new Set<Socket>();
  let blocked = false;
  const server = createServer((incoming) => {
    const upstream = host.startsWith("/")
      ? createConnection({ path: `${host}/.s.PGSQL.${port}` })
      : createConnection({ host, port });
    sockets.add(incoming);
    sockets.add(upstream);
    incoming.pipe(upstream);
    upstream.on("data", (chunk) => {
      if (blocked) return;
      if (!incoming.write(chunk)) upstream.pause();
    });
    incoming.on("drain", () => upstream.resume());
    incoming.on("close", () => {
      sockets.delete(incoming);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      incoming.destroy();
    });
    incoming.on("error", () => upstream.destroy());
    upstream.on("error", () => incoming.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  target.hostname = "127.0.0.1";
  target.port = String(address.port);
  target.searchParams.delete("host");
  target.searchParams.delete("port");
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    connectionString: target.toString(),
    block: (value: boolean) => {
      blocked = value;
    },
  };
}
