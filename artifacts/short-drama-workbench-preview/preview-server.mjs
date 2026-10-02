import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(`${repository}/apps/crewon-ui/package.json`);
const { createServer } = await import(require.resolve("vite"));
const { default: react } = await import(
  require.resolve("@vitejs/plugin-react")
);
const script = `/@fs${repository}artifacts/short-drama-workbench-preview/preview.tsx`;
const server = await createServer({
  configFile: false,
  root: `${repository}apps/crewon-ui`,
  envDir: `${repository}output/extensions/empty-preview-env`,
  resolve: {
    alias: { "@": `${repository}apps/crewon-ui/src` },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    entries: [
      `${repository}artifacts/short-drama-workbench-preview/preview.tsx`,
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5719,
    strictPort: true,
    fs: { allow: [repository] },
  },
  plugins: [
    react(),
    {
      name: "short-drama-page-preview",
      configureServer(instance) {
        instance.middlewares.use(async (request, response, next) => {
          if (request.url?.split("?")[0] !== "/") return next();
          const html = await instance.transformIndexHtml(
            "/",
            `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CrewON · 短剧工作台预览</title></head><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`,
          );
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(html);
        });
      },
    },
  ],
});
await server.listen();
console.log("Short drama workbench preview: http://127.0.0.1:5719/");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
