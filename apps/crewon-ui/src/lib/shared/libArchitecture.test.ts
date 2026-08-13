import { describe, expect, it } from "vitest";

const ALLOWED_ROOT_LIB_MODULES = [
  "i18n.ts",
  "platform.ts",
  "theme.ts",
  "workMode.ts",
];

const FORBIDDEN_APP_COMPOSITION_SNIPPETS = [
  'from "react"',
  'from "./lib/app/',
  "useState",
  "useRef",
  "useMemo",
  "createAppConnectionHandlers",
  "createAppServerEventCoordinator",
  "defaultServerUrl",
  "detectPlatform",
  "shouldUseDemoPreview",
  "threadTitle",
];

const FORBIDDEN_APP_PUBLIC_API_SNIPPETS = [
  "createAppConnectionHandlers",
  "createAppServerEventHandlers",
  'from "./handlers"',
];

const LEGACY_ROOT_LIB_MODULES = [
  "agentConfigDefaults",
  "appRouting",
  "appServer",
  "crewonDomain",
  "demoContent",
  "demoData",
  "domainAutomationContent",
  "domainTypes",
  "libraryPanelFormatters",
  "mcpConfigFormatters",
  "pathUtils",
  "settingsActions",
  "settingsCatalog",
  "text",
];

function importsAppCoordination(source: string): boolean {
  return [
    'from "../app"',
    'from "../app/',
    'from "../../app"',
    'from "../../app/',
    'from "../../lib/app"',
    'from "../../lib/app/',
    'from "../lib/app"',
    'from "../lib/app/',
    'from "../../../lib/app"',
    'from "../../../lib/app/',
  ].some((snippet) => source.includes(snippet));
}

function importsLegacyRootLibModule(path: string, source: string): boolean {
  return LEGACY_ROOT_LIB_MODULES.some((moduleName) => {
    const snippets = [
      `from "./lib/${moduleName}"`,
      `from "../lib/${moduleName}"`,
      `from "../../lib/${moduleName}"`,
      `from "../../../lib/${moduleName}"`,
      `from "../${moduleName}"`,
      `from "../../${moduleName}"`,
      `from "../../../${moduleName}"`,
    ];

    return snippets.some((snippet) => {
      const isAllowedAppRoutingImport =
        path.startsWith("../app/") &&
        moduleName === "appRouting" &&
        snippet === `from "../${moduleName}"`;

      return !isAllowedAppRoutingImport && source.includes(snippet);
    });
  });
}

function importsBackendImplementation(source: string): boolean {
  return [
    "lib/app-server/",
    "lib/backend/",
    "lib/server-request/",
  ].some((snippet) => source.includes(snippet));
}

describe("lib architecture", () => {
  it("keeps feature modules out of the lib root", () => {
    const rootModuleFiles = Object.keys(
      import.meta.glob("../*.ts", {
        eager: true,
        import: "default",
        query: "?raw",
      }),
    )
      .map((path) => path.replace("../", ""))
      // The rule is about feature modules landing in the lib root, so a test
      // beside an already-allowed module is not a new root module.
      .filter((file) => !file.endsWith(".test.ts"))
      .sort();

    expect(rootModuleFiles).toEqual(ALLOWED_ROOT_LIB_MODULES);
  });

  it("keeps domain modules independent from library presentation modules", () => {
    const domainSources = import.meta.glob("../domain/*.ts", {
      eager: true,
      import: "default",
      query: "?raw",
    }) as Record<string, string>;

    const offenders = Object.entries(domainSources)
      .filter(([, source]) => source.includes('from "../library/'))
      .map(([path]) => path.replace("../domain/", "domain/"))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("keeps domain modules independent from app coordination modules", () => {
    const domainSources = import.meta.glob("../domain/*.ts", {
      eager: true,
      import: "default",
      query: "?raw",
    }) as Record<string, string>;

    const offenders = Object.entries(domainSources)
      .filter(([, source]) => importsAppCoordination(source))
      .map(([path]) => path.replace("../domain/", "domain/"))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("keeps feature modules independent from app coordination modules", () => {
    const libSources = import.meta.glob("../**/*.ts", {
      eager: true,
      import: "default",
      query: "?raw",
    }) as Record<string, string>;

    const offenders = Object.entries(libSources)
      .filter(([path]) => !path.startsWith("../app/"))
      .filter(([path]) => path !== "../shared/libArchitecture.test.ts")
      .filter(([, source]) => importsAppCoordination(source))
      .map(([path]) => path.replace("../", ""))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("keeps App.tsx focused on composition instead of implementation details", () => {
    const appSource = import.meta.glob("../../App.tsx", {
      eager: true,
      import: "default",
      query: "?raw",
    })["../../App.tsx"] as string;

    const offenders = FORBIDDEN_APP_COMPOSITION_SNIPPETS.filter((snippet) =>
      appSource.includes(snippet)
    );

    expect(offenders).toEqual([]);
  });

  it("keeps components independent from app coordination modules", () => {
    const componentSources = import.meta.glob("../../components/**/*.tsx", {
      eager: true,
      import: "default",
      query: "?raw",
    }) as Record<string, string>;

    const offenders = Object.entries(componentSources)
      .filter(([, source]) => importsAppCoordination(source))
      .map(([path]) => path.replace("../../", ""))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("keeps components independent from backend implementation modules", () => {
    const componentSources = import.meta.glob("../../components/**/*.tsx", {
      eager: true,
      import: "default",
      query: "?raw",
    }) as Record<string, string>;

    const offenders = Object.entries(componentSources)
      .filter(([, source]) => importsBackendImplementation(source))
      .map(([path]) => path.replace("../../", ""))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("keeps app public exports focused on composition APIs", () => {
    const appPublicApiSource = import.meta.glob("../app/index.ts", {
      eager: true,
      import: "default",
      query: "?raw",
    })["../app/index.ts"] as string;

    const offenders = FORBIDDEN_APP_PUBLIC_API_SNIPPETS.filter((snippet) =>
      appPublicApiSource.includes(snippet)
    );

    expect(offenders).toEqual([]);
  });

  it("keeps imports off legacy root lib module paths", () => {
    const sources = {
      ...import.meta.glob("../**/*.ts", {
        eager: true,
        import: "default",
        query: "?raw",
      }),
      ...import.meta.glob("../../App.tsx", {
        eager: true,
        import: "default",
        query: "?raw",
      }),
      ...import.meta.glob("../../components/**/*.tsx", {
        eager: true,
        import: "default",
        query: "?raw",
      }),
    } as Record<string, string>;

    const offenders = Object.entries(sources)
      .filter(([path]) => path !== "../shared/libArchitecture.test.ts")
      .filter(([path, source]) => importsLegacyRootLibModule(path, source))
      .map(([path]) => path.replace("../../", "").replace("../", "lib/"))
      .sort();

    expect(offenders).toEqual([]);
  });
});
