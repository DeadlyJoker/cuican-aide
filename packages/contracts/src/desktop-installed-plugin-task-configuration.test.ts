import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_SCHEMA,
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES,
  DesktopInstalledPluginTaskConfigurationError,
  parseDesktopInstalledPluginTaskConfiguration as parse,
  parseDesktopInstalledPluginTaskExecutionSettings as parseSettings,
  type DesktopInstalledPluginTaskExecutionSettings,
  type DesktopInstalledPluginTaskAuthorityReference,
  type DesktopInstalledPluginTaskUiPublication,
} from "./plugins.ts";

const digest = `sha256:${"a".repeat(64)}`;
const authorityFields = [
  "taskPolicyAuthority",
  "uiPolicyAuthority",
  "packageAuthority",
  "quoteAuthority",
] as const;

function fixture() {
  return {
    schemaVersion: DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_SCHEMA,
    actor: {
      principalId: "principal",
      actorId: "actor",
      tenantId: "tenant",
      spaceId: "space",
    },
    scope: { tenantId: "tenant", spaceId: "space", profileId: "profile" },
    authorityEpoch: "epoch_" + "a".repeat(32),
    installRoot: "/private/native/plugins",
    activationDigest: digest,
    uiPublications: [
      {
        pluginId: "example.workbench",
        packageDigest: digest,
        contributionId: "workspace",
      },
    ],
    taskPolicyAuthority: {
      url: "https://authority.example/tasks",
      serviceTokenEnvironmentVariable: "NATIVE_TASK_POLICY_TOKEN",
    },
    uiPolicyAuthority: {
      url: "https://authority.example/ui",
      serviceTokenEnvironmentVariable: "NATIVE_UI_POLICY_TOKEN",
    },
    packageAuthority: {
      url: "https://authority.example/packages",
      serviceTokenEnvironmentVariable: "NATIVE_PACKAGE_AUTHORITY_TOKEN",
    },
    quoteAuthority: {
      url: "https://authority.example/quotes",
      serviceTokenEnvironmentVariable: "NATIVE_QUOTE_AUTHORITY_TOKEN",
    },
    timeoutMs: 20000,
    maximumPackages: 32,
  };
}

function rejects(input: unknown) {
  assert.throws(
    () => parse(input),
    (error: unknown) => {
      assert.ok(error instanceof DesktopInstalledPluginTaskConfigurationError);
      assert.equal(
        error.code,
        "desktop_installed_plugin_task_configuration_invalid",
      );
      return true;
    },
  );
}

function settingsFixture() {
  const {
    uiPublications,
    taskPolicyAuthority,
    uiPolicyAuthority,
    packageAuthority,
    quoteAuthority,
    timeoutMs,
    maximumPackages,
  } = fixture();
  return {
    uiPublications,
    taskPolicyAuthority,
    uiPolicyAuthority,
    packageAuthority,
    quoteAuthority,
    timeoutMs,
    maximumPackages,
  };
}
function rejectsSettings(input: unknown) {
  assert.throws(
    () => parseSettings(input),
    (error: unknown) => {
      assert.ok(error instanceof DesktopInstalledPluginTaskConfigurationError);
      assert.equal(
        error.code,
        "desktop_installed_plugin_task_configuration_invalid",
      );
      return true;
    },
  );
}

test("task execution settings export only seven detached frozen role fields", () => {
  const input = settingsFixture();
  const actual: DesktopInstalledPluginTaskExecutionSettings =
    parseSettings(input);
  assert.deepEqual(actual, input);
  assert.equal(Object.keys(actual).length, 7);
  assert.notEqual(actual.uiPublications, input.uiPublications);
  input.uiPublications[0]!.contributionId = "changed";
  input.quoteAuthority.url = "https://changed.example/quotes";
  assert.equal(actual.uiPublications[0]!.contributionId, "workspace");
  assert.equal(actual.quoteAuthority.url, "https://authority.example/quotes");
  for (const value of [
    actual,
    actual.uiPublications,
    ...actual.uiPublications,
    ...authorityFields.map((field) => actual[field]),
  ])
    assert.ok(Object.isFrozen(value));
  assert.deepEqual(parse(fixture()), {
    ...fixture(),
    ...parseSettings(settingsFixture()),
  });
});

test("settings require their exact shape and cannot carry publication identity or an implicit grant", () => {
  for (const field of Object.keys(settingsFixture())) {
    const input: Record<string, unknown> = { ...settingsFixture() };
    delete input[field];
    rejectsSettings(input);
  }
  for (const field of [
    "schemaVersion",
    "actor",
    "scope",
    "authorityEpoch",
    "installRoot",
    "activationDigest",
    "peer",
    "activationAuthority",
    "walletId",
    "credits",
    "priceRevision",
    "serviceToken",
  ])
    rejectsSettings({ ...settingsFixture(), [field]: "not-issued" });
  rejectsSettings(fixture());
  rejects(settingsFixture());
  for (const input of [null, undefined, [], "{}", 1, true])
    rejectsSettings(input);
});

test("settings reuse the same four explicit HTTPS and protected environment reference guards", () => {
  for (const field of authorityFields) {
    for (const override of [
      { url: "http://authority.example/tasks" },
      { url: "https://user@authority.example/tasks" },
      { url: "https://authority.example/tasks?token=secret" },
      { url: "https://authority.example/tasks#" },
      { serviceTokenEnvironmentVariable: "CREWON_CONTROL_SESSION_TOKEN" },
      { serviceTokenEnvironmentVariable: "NODE_OPTIONS" },
      { serviceToken: "raw-secret" },
    ])
      rejectsSettings({
        ...settingsFixture(),
        [field]: { ...fixture()[field], ...override },
      });
  }
  const reference = settingsFixture().taskPolicyAuthority;
  const sameRoles = parseSettings({
    ...settingsFixture(),
    taskPolicyAuthority: reference,
    uiPolicyAuthority: reference,
    packageAuthority: reference,
    quoteAuthority: reference,
  });
  assert.deepEqual(sameRoles.quoteAuthority, reference);
  const literal = "https://AUTHORITY.example:443/tasks";
  assert.equal(
    parseSettings({
      ...settingsFixture(),
      taskPolicyAuthority: { ...reference, url: literal },
    }).taskPolicyAuthority.url,
    literal,
  );
});

test("settings apply the original dense tuple, timeout and package bounds", () => {
  const publication = settingsFixture().uiPublications[0]!;
  for (const uiPublications of [
    [],
    Array(1),
    Array(33).fill(publication),
    [publication, { ...publication }],
  ])
    rejectsSettings({ ...settingsFixture(), uiPublications });
  for (const timeoutMs of [999, 30001, 1000.5, NaN, Infinity])
    rejectsSettings({ ...settingsFixture(), timeoutMs });
  for (const maximumPackages of [0, 33, 1.5])
    rejectsSettings({ ...settingsFixture(), maximumPackages });
  for (const timeoutMs of [1000, 30000])
    for (const maximumPackages of [1, 32])
      assert.equal(
        parseSettings({ ...settingsFixture(), timeoutMs, maximumPackages })
          .maximumPackages,
        maximumPackages,
      );
});

test("settings reject nondata shapes without invoking getters or serializers", () => {
  let calls = 0;
  const getter = () => {
    calls++;
    throw new Error("must not run");
  };
  for (const field of Object.keys(settingsFixture())) {
    const input = settingsFixture();
    Object.defineProperty(input, field, { enumerable: true, get: getter });
    rejectsSettings(input);
  }
  const tuple = settingsFixture();
  Object.defineProperty(tuple.uiPublications[0]!, "packageDigest", {
    enumerable: true,
    get: getter,
  });
  rejectsSettings(tuple);
  const symbol = settingsFixture();
  Object.defineProperty(symbol, Symbol("grant"), { value: "allow" });
  rejectsSettings(symbol);
  const hidden = settingsFixture();
  Object.defineProperty(hidden, "maximumPackages", {
    value: 32,
    enumerable: false,
  });
  rejectsSettings(hidden);
  rejectsSettings(
    Object.assign(
      Object.create({ inherited: true }) as object,
      settingsFixture(),
    ),
  );
  rejectsSettings({ ...settingsFixture(), toJSON: getter });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  rejectsSettings({ ...settingsFixture(), quoteAuthority: cycle });
  rejectsSettings({
    ...settingsFixture(),
    oversized: "x".repeat(
      DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES,
    ),
  });
  assert.equal(calls, 0);
  assert.deepEqual(
    parseSettings(
      Object.assign(Object.create(null) as object, settingsFixture()),
    ),
    settingsFixture(),
  );
});

test("independent Native task publication exports detached, deeply frozen data", () => {
  const input = fixture();
  const actual = parse(input);
  assert.deepEqual(actual, input);
  assert.notEqual(actual, input);
  assert.notEqual(actual.actor, input.actor);
  assert.notEqual(actual.scope, input.scope);
  assert.notEqual(actual.uiPublications, input.uiPublications);
  input.actor.actorId = "changed";
  input.scope.profileId = "changed";
  input.uiPublications[0]!.contributionId = "changed";
  input.taskPolicyAuthority.url = "https://changed.example/tasks";
  assert.equal(actual.actor.actorId, "actor");
  assert.equal(actual.scope.profileId, "profile");
  assert.equal(actual.uiPublications[0]!.contributionId, "workspace");
  assert.equal(
    actual.taskPolicyAuthority.url,
    "https://authority.example/tasks",
  );
  for (const value of [
    actual,
    actual.actor,
    actual.scope,
    actual.uiPublications,
    ...actual.uiPublications,
    ...authorityFields.map((field) => actual[field]),
  ])
    assert.ok(Object.isFrozen(value));
  const publication: DesktopInstalledPluginTaskUiPublication =
    actual.uiPublications[0]!;
  const authority: DesktopInstalledPluginTaskAuthorityReference =
    actual.quoteAuthority;
  assert.equal(publication.packageDigest, digest);
  assert.equal(
    authority.serviceTokenEnvironmentVariable,
    "NATIVE_QUOTE_AUTHORITY_TOKEN",
  );
});

test("requires the independent v1 schema and every exact root field", () => {
  for (const schemaVersion of [
    "crewon.desktop-installed-plugin-activation.v1",
    "crewon.desktop-plugin-bootstrap.v2",
    "crewon.installed-plugin-control-tasks.v1",
    "crewon.desktop-installed-plugin-tasks.v2",
    undefined,
  ])
    rejects({ ...fixture(), schemaVersion });
  for (const field of Object.keys(fixture())) {
    const missing = { ...fixture() } as Record<string, unknown>;
    delete missing[field];
    rejects(missing);
  }
  for (const field of [
    "peer",
    "entries",
    "activationAuthority",
    "projects",
    "projectExecution",
    "creditPoolId",
    "priceVersion",
    "serviceToken",
    "filePins",
  ])
    rejects({ ...fixture(), [field]: {} });
});

test("actor and scope require complete pure values in the same tenant and space", () => {
  for (const field of ["tenantId", "spaceId"] as const)
    rejects({
      ...fixture(),
      scope: { ...fixture().scope, [field]: "foreign" },
    });
  for (const field of Object.keys(fixture().actor)) {
    const actor = { ...fixture().actor } as Record<string, unknown>;
    delete actor[field];
    rejects({ ...fixture(), actor });
  }
  for (const field of Object.keys(fixture().scope)) {
    const scope = { ...fixture().scope } as Record<string, unknown>;
    delete scope[field];
    rejects({ ...fixture(), scope });
  }
  for (const id of [
    "",
    " principal",
    "principal ",
    "a\0",
    "a\u200b",
    "a".repeat(129),
    "界".repeat(43),
  ])
    rejects({ ...fixture(), actor: { ...fixture().actor, principalId: id } });
  rejects({ ...fixture(), actor: { ...fixture().actor, role: "admin" } });
  rejects({ ...fixture(), scope: { ...fixture().scope, walletId: "wallet" } });
  assert.equal(
    parse({
      ...fixture(),
      actor: { ...fixture().actor, principalId: "本地用户" },
    }).actor.principalId,
    "本地用户",
  );
});

test("authority epoch follows the original Native bootstrap token bounds", () => {
  for (const authorityEpoch of [
    "a".repeat(31),
    "a".repeat(129),
    "a".repeat(32) + " ",
    "a".repeat(32) + "/",
    "界".repeat(32),
    123,
  ])
    rejects({ ...fixture(), authorityEpoch });
  for (const length of [32, 128])
    assert.equal(
      parse({ ...fixture(), authorityEpoch: "A_0-".repeat(length / 4) })
        .authorityEpoch.length,
      length,
    );
});

test("activation publication is bound by a complete lowercase SHA-256 digest", () => {
  for (const activationDigest of [
    "a".repeat(64),
    `sha256:${"a".repeat(63)}`,
    `sha256:${"A".repeat(64)}`,
    `sha512:${"a".repeat(64)}`,
    null,
    { digest },
  ])
    rejects({ ...fixture(), activationDigest });
});

test("UI grants require exact valid package and contribution tuples", () => {
  const publication = fixture().uiPublications[0]!;
  for (const field of [
    "pluginId",
    "packageDigest",
    "contributionId",
  ] as const) {
    const missing = { ...publication } as Record<string, unknown>;
    delete missing[field];
    rejects({ ...fixture(), uiPublications: [missing] });
  }
  for (const pluginId of ["", "Uppercase", "a/b", "a".repeat(129)])
    rejects({ ...fixture(), uiPublications: [{ ...publication, pluginId }] });
  for (const contributionId of ["", "Uppercase", "a/b", "a".repeat(129)])
    rejects({
      ...fixture(),
      uiPublications: [{ ...publication, contributionId }],
    });
  rejects({
    ...fixture(),
    uiPublications: [{ ...publication, packageDigest: "a" }],
  });
  rejects({
    ...fixture(),
    uiPublications: [{ ...publication, actions: ["extension:run"] }],
  });
});

test("UI grants are bounded, dense and deduplicated by the complete tuple", () => {
  const publication = fixture().uiPublications[0]!;
  rejects({ ...fixture(), uiPublications: [] });
  rejects({ ...fixture(), uiPublications: Array(1) });
  rejects({ ...fixture(), uiPublications: Array(33).fill(publication) });
  rejects({
    ...fixture(),
    uiPublications: [
      publication,
      {
        contributionId: publication.contributionId,
        packageDigest: digest,
        pluginId: publication.pluginId,
      },
    ],
  });
  const actual = parse({
    ...fixture(),
    uiPublications: [
      publication,
      { ...publication, contributionId: "second" },
      { ...publication, packageDigest: `sha256:${"b".repeat(64)}` },
      { ...publication, pluginId: "example.second" },
    ],
  });
  assert.equal(actual.uiPublications.length, 4);
  assert.equal(
    parse({
      ...fixture(),
      uiPublications: Array.from({ length: 32 }, (_, index) => ({
        ...publication,
        contributionId: `workspace-${index}`,
      })),
    }).uiPublications.length,
    32,
  );
});

test("each authority independently requires HTTPS without credentials, query, fragment or controls", () => {
  for (const field of authorityFields) {
    for (const url of [
      "",
      "not-a-url",
      "http://authority.example/authorize",
      "https://user:pass@authority.example/authorize",
      "https://authority.example/authorize?",
      "https://authority.example/authorize#",
      "https://authority.example/authorize?token=x",
      "https://authority.example/auth\norize",
      "https://authority.example/auth\u200borize",
      "https://authority.example\\authorize",
      " https://authority.example/authorize",
      "https://authority.example/" + "a".repeat(2048),
    ])
      rejects({ ...fixture(), [field]: { ...fixture()[field], url } });
    rejects({ ...fixture(), [field]: { url: fixture()[field].url } });
    rejects({
      ...fixture(),
      [field]: { ...fixture()[field], audience: "activation" },
    });
    rejects({
      ...fixture(),
      [field]: { ...fixture()[field], serviceToken: "raw-secret" },
    });
  }
});

test("each authority accepts only the original activation-safe secret environment references", () => {
  for (const field of authorityFields) {
    for (const serviceTokenEnvironmentVariable of [
      "",
      "raw-secret-token",
      "lowercase",
      "A".repeat(129),
      "HOME",
      "PATH",
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "ELECTRON_RUN_AS_NODE",
      "DYLD_INSERT_LIBRARIES",
      "LD_PRELOAD",
      "PNPM_HOME",
      "VITE_SECRET",
      "CREWON_CONTROL_SESSION_TOKEN",
      "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "CODEX_HOME",
    ])
      rejects({
        ...fixture(),
        [field]: { ...fixture()[field], serviceTokenEnvironmentVariable },
      });
    for (const serviceTokenEnvironmentVariable of [
      "A",
      "A".repeat(128),
      "NATIVE_SEPARATE_AUTHORITY_TOKEN",
      "CREWON_INSTALLED_PLUGIN_AUTHORITY_",
      "CREWON_INSTALLED_PLUGIN_AUTHORITY_TASKS",
    ])
      assert.equal(
        parse({
          ...fixture(),
          [field]: { ...fixture()[field], serviceTokenEnvironmentVariable },
        })[field].serviceTokenEnvironmentVariable,
        serviceTokenEnvironmentVariable,
      );
  }
});

test("authority role data does not imply separate endpoints, tokens, prices or funds", () => {
  const authority = fixture().taskPolicyAuthority;
  const actual = parse({
    ...fixture(),
    taskPolicyAuthority: authority,
    uiPolicyAuthority: authority,
    packageAuthority: authority,
    quoteAuthority: authority,
  });
  assert.deepEqual(actual.quoteAuthority, authority);
  rejects({ ...fixture(), quoteAuthority: { ...authority, credits: "100" } });
});

test("install root is an absolute normalized bounded Native path", () => {
  for (const installRoot of [
    "relative/plugins",
    "/",
    "/private/../plugins",
    "/private/./plugins",
    "/private//plugins",
    "/private/plugins/",
    "/private/plugins ",
    "/private/plugins\0",
    "/private/plugins\u200b",
    "C:\\plugins",
    "/" + "a".repeat(4096),
    "/" + "界".repeat(1366),
  ])
    rejects({ ...fixture(), installRoot });
  assert.equal(
    parse({ ...fixture(), installRoot: "/" + "a".repeat(4095) }).installRoot
      .length,
    4096,
  );
  assert.equal(
    parse({ ...fixture(), installRoot: "/private/插件目录" }).installRoot,
    "/private/插件目录",
  );
});

test("timeout and package limits require bounded finite integers", () => {
  for (const timeoutMs of [0, 999, 30001, 2000.5, NaN, Infinity, "20000", null])
    rejects({ ...fixture(), timeoutMs });
  for (const maximumPackages of [0, 33, 1.5, NaN, Infinity, "32", null])
    rejects({ ...fixture(), maximumPackages });
  for (const timeoutMs of [1000, 30000])
    for (const maximumPackages of [1, 32]) {
      const actual = parse({ ...fixture(), timeoutMs, maximumPackages });
      assert.equal(actual.timeoutMs, timeoutMs);
      assert.equal(actual.maximumPackages, maximumPackages);
    }
});

test("pure-data validation never runs getters or custom serialization", () => {
  let reads = 0;
  const getter = () => {
    reads++;
    throw new Error("getter must never run");
  };
  for (const field of Object.keys(fixture())) {
    const input = fixture();
    Object.defineProperty(input, field, { enumerable: true, get: getter });
    rejects(input);
  }
  for (const field of authorityFields) {
    const input = fixture();
    Object.defineProperty(input[field], "serviceTokenEnvironmentVariable", {
      enumerable: true,
      get: getter,
    });
    rejects(input);
  }
  const tuple = fixture();
  Object.defineProperty(tuple.uiPublications[0]!, "contributionId", {
    enumerable: true,
    get: getter,
  });
  rejects(tuple);
  const array = fixture();
  Object.defineProperty(array.uiPublications, "0", {
    enumerable: true,
    get: getter,
  });
  rejects(array);
  rejects({ ...fixture(), toJSON: getter });
  rejects({ ...fixture(), actor: { ...fixture().actor, toJSON: getter } });
  assert.equal(reads, 0);
});

test("rejects symbols, hidden fields, exotic objects and array extras", () => {
  const symbol = fixture();
  Object.defineProperty(symbol, Symbol("authority"), {
    enumerable: true,
    value: "fake",
  });
  rejects(symbol);
  const hidden = fixture();
  Object.defineProperty(hidden, "timeoutMs", {
    enumerable: false,
    value: 20000,
  });
  rejects(hidden);
  rejects(
    Object.assign(Object.create({ inherited: true }) as object, fixture()),
  );
  rejects({ ...fixture(), actor: new Date() });
  const array = fixture();
  Object.defineProperty(array.uiPublications, "extra", {
    enumerable: true,
    value: "fake",
  });
  rejects(array);
  const tuple = fixture();
  Object.defineProperty(tuple.uiPublications[0]!, "taskPermission", {
    value: "allow",
  });
  rejects(tuple);
  assert.deepEqual(
    parse(Object.assign(Object.create(null) as object, fixture())),
    fixture(),
  );
});

test("input is bounded by exact UTF-8 JSON bytes and finite pure JSON complexity", () => {
  assert.equal(
    DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES,
    64 * 1024,
  );
  rejects({
    ...fixture(),
    oversized: "a".repeat(
      DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES,
    ),
  });
  rejects({
    ...fixture(),
    oversized: "界".repeat(
      DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES / 3,
    ),
  });
  rejects({ ...fixture(), oversized: Array(8192).fill(null) });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  rejects({ ...fixture(), actor: cycle });
  for (const input of [null, undefined, [], "{}", 1, true]) rejects(input);
  rejects({ ...fixture(), actor: { ...fixture().actor, actorId: "\ud800" } });
});
