import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const paths = new Map([
  ["/", new URL("./index.html", import.meta.url)],
  ["/ui.mjs", new URL("../dist/0.2.3/ui.mjs", import.meta.url)],
]);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const path = paths.get(pathname);
  if (!path || request.method !== "GET") {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    const bytes = await readFile(fileURLToPath(path));
    response.writeHead(200, {
      "Content-Type": pathname.endsWith(".mjs")
        ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  } catch {
    response.writeHead(503);
    response.end("请先执行 pnpm build");
  }
});
server.listen(4318, "127.0.0.1", () =>
  console.log("演示预览 http://127.0.0.1:4318"),
);
