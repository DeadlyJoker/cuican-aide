import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const uiRoot = `${repository}apps/crewon-ui`;
const require = createRequire(`${uiRoot}/package.json`);
const { createServer } = await import(require.resolve("vite"));
const script = `/@fs${repository}artifacts/short-drama-workbench-preview/preview.tsx`;
const previewPath = "/plugin-preview.html";
// Match `pnpm --filter @crewon/ui dev` when Vite reads the original configuration.
process.chdir(uiRoot);
const server = await createServer({
  // The shared entry must boot the real application, including its account and settings.
  // Keep the isolated design preview available only at an explicit preview URL.
  configFile: `${uiRoot}/vite.config.ts`,
  root: uiRoot,
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 5719,
    strictPort: true,
    fs: { allow: [repository] },
    // Warm the preview module graph at startup so first clicks don't pay
    // per-file transform cost in the dev server.
    warmup: {
      clientFiles: [
        `${repository}artifacts/short-drama-workbench-preview/preview.tsx`,
        `${uiRoot}/src/components/short-drama/ShortDramaWorkbenchPreview.tsx`,
      ],
    },
  },
  plugins: [
    {
      name: "short-drama-page-preview",
      configureServer(instance) {
        instance.middlewares.use(async (request, response, next) => {
          if (request.url?.split("?")[0] !== previewPath) return next();
          const html = await instance.transformIndexHtml(
            previewPath,
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
console.log("CrewON application: http://127.0.0.1:5719/");
console.log(`Short drama design preview: http://127.0.0.1:5719${previewPath}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
