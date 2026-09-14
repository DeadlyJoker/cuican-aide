import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { load, JSON_SCHEMA } from "js-yaml";
import test from "node:test";
import {
  createSkillVersion,
  parseSkillInvocationSpec,
  parseSkillMethod,
  parseSkillVersion,
  parseSkillVersionSnapshot,
  skillMethodJsonSchema,
  type SkillMethod,
} from "./demonstrated-skill.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const method: SkillMethod = {
  name: "Monthly export",
  purpose: "Download the selected month and verify rows",
  steps: ["Select {{date}} and download"],
  parameters: [
    { name: "date", label: "New month", type: "string", required: true },
    { name: "count", label: "Rows", type: "number", required: false },
  ],
  requiredToolRefs: ["browser"],
  completionCriteria: ["Downloaded rows match count"],
  knownExceptions: ["Login: request runtime authorization"],
  runtimeRequirements: ["browser session"],
};
function version(input: SkillMethod = method) {
  return createSkillVersion(
    {
      skillId: "skill-1",
      versionId: "v1",
      method: input,
      source: {
        recordingId: "r1",
        revision: 1,
        contentDigest: digester.sha256("r"),
        provenance: "contract-fixture",
      },
      createdAt: "2026-09-14T00:00:00Z",
    },
    digester,
  );
}

test("F03-R03 Zod/YAML adoption preserves exact previously generated v1 bytes and digests", () => {
  // Frozen before the refactor; changing formatting must never silently change a v1 identity.
  for (const [input, contentDigest, markdownDigest] of [
    [
      method,
      "sha256:442c7c3bfccf776ba0de4c424b63a72a9e90fd2f5fc7d61502d55fb72caa36e7",
      "sha256:9f99e6b3d2736521d1c2a1be56df9a0515d61515032b6b84e4b832a7b4fe35b3",
    ],
    [
      {
        ...method,
        name: '报告: "yes"\n下一行',
        purpose: "2026-09-14: no # 注释 \\ path\n---\nemoji 📅",
      },
      "sha256:550774c8d4a9e1a324b9579aba6e94af0ca9a172414d15f694a6e356b66ea3ab",
      "sha256:7c0ab810cb75a6734aa43700609f103dc757c47ff339b026a6a1ac27e7b188fb",
    ],
  ] as const) {
    const saved = version(input);
    assert.equal(saved.ref.contentDigest, contentDigest);
    assert.equal(digester.sha256(saved.markdown), markdownDigest);
    assert.deepEqual(parseSkillVersion(saved, digester), saved);
    const frontmatter = saved.markdown.split("\n").slice(1, 3).join("\n");
    assert.deepEqual(load(frontmatter, { schema: JSON_SCHEMA }), {
      name: input.name,
      description: input.purpose,
    });
  }
});

test("F03-R02 generated model schema describes strict method objects and bounded typed inputs", () => {
  const schema = JSON.parse(JSON.stringify(skillMethodJsonSchema));
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(method).sort());
  assert.equal(schema.properties.name.maxLength, 160);
  assert.equal(schema.properties.steps.maxItems, 40);
  assert.equal(schema.properties.parameters.maxItems, 24);
  assert.equal(schema.properties.parameters.items.additionalProperties, false);
  assert.deepEqual(schema.properties.parameters.items.properties.type.enum, [
    "string",
    "number",
    "boolean",
  ]);
  assert.deepEqual(
    parseSkillMethod(JSON.parse(JSON.stringify(method))),
    method,
  );
});

test("F03-R06 Zod rejects unknown keys, credential fields, invalid enums and inherited objects", () => {
  for (const name of [
    "password",
    "accessToken",
    "api_key",
    "secret",
    "cookie",
    "authorization",
    "credential",
    "constructor",
    "__proto__",
  ]) {
    assert.throws(
      () =>
        parseSkillMethod({
          ...method,
          parameters: [{ name, label: name, type: "string", required: true }],
        }),
      /skill_parameter_name_invalid/,
    );
  }
  for (const label of [
    "Website password",
    "Session token",
    "API key",
    "API_key",
    "账户密码",
    "访问令牌",
    "服务密钥",
  ]) {
    assert.throws(
      () =>
        parseSkillMethod({
          ...method,
          parameters: [
            { name: "input_1", label, type: "string", required: true },
          ],
        }),
      /skill_parameter_label_invalid/,
    );
  }
  assert.equal(
    parseSkillMethod({
      ...method,
      runtimeRequirements: ["密码由用户在运行时授权提供，不保存到参数。"],
    }).runtimeRequirements[0],
    "密码由用户在运行时授权提供，不保存到参数。",
  );
  for (const candidate of [
    { ...method, unexpected: true },
    { ...method, parameters: [{ ...method.parameters[0], unexpected: true }] },
    { ...method, parameters: [{ ...method.parameters[0], type: "secret" }] },
    {
      ...method,
      parameters: [{ ...method.parameters[0], type: "number", enum: ["1"] }],
    },
    { ...method, parameters: [method.parameters[0], method.parameters[0]] },
    { ...method, requiredToolRefs: ["browser", "browser"] },
    Object.assign(Object.create({ inherited: true }), method),
    JSON.parse(
      JSON.stringify(method).replace('{"name"', '{"__proto__":{},"name"'),
    ),
  ])
    assert.throws(() => parseSkillMethod(candidate));
});

test("F03-R03 snapshot shapes are strict and persisted digest verification remains mandatory", () => {
  const saved = version();
  for (const changed of [
    { ...saved, unexpected: "extra" },
    { ...saved, ref: { ...saved.ref, unexpected: true } },
    { ...saved, source: { ...saved.source, unexpected: true } },
    { ...saved, source: { ...saved.source, revision: 1.5 } },
    { ...saved, method: { ...saved.method, steps: [42] } },
    { ...saved, markdown: "unreviewed replacement" },
    { ...saved, createdAt: "invalid timestamp" },
  ])
    assert.throws(() => parseSkillVersionSnapshot(changed));
  const wrongDigest = {
    ...saved,
    ref: { ...saved.ref, contentDigest: digester.sha256("different content") },
  };
  assert.deepEqual(parseSkillVersionSnapshot(wrongDigest), wrongDigest);
  assert.throws(
    () => parseSkillVersion(wrongDigest, digester),
    /skill_digest_mismatch/,
  );
});

test("F03-R08 byte budgets and unsafe invocation values survive schema migration", () => {
  const spec = {
    schemaVersion: "crewon.skill-invocation.v1",
    skill: version().ref,
    parameters: { date: "2026-10" },
    requiredToolRefs: ["browser"],
  };
  for (const parameters of [
    { date: Infinity },
    { date: NaN },
    { date: { nested: true } },
    { date: "中".repeat(683) },
    { date: "a".repeat(2048), count: "b".repeat(2048) },
    JSON.parse('{"__proto__":"bad"}'),
    Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`key${i}`, true])),
  ])
    assert.throws(() => parseSkillInvocationSpec({ ...spec, parameters }));
  assert.throws(() => parseSkillInvocationSpec({ ...spec, unexpected: true }));
  assert.throws(() => parseSkillMethod({ ...method, name: "中".repeat(54) }));
  assert.throws(
    () =>
      parseSkillMethod({
        ...method,
        steps: Array.from({ length: 20 }, () => "中".repeat(300)),
      }),
    /skill_method_too_large/,
  );
});
