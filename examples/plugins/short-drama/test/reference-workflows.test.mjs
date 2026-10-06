import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(
    `../dist/${process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.2"}/`,
    import.meta.url,
  ).pathname;
const {
  renderReferenceWorkflow: render,
  referenceWorkflowCatalog: catalog,
  observeReferenceWorkflow: observe,
} = await import(pathToFileURL(join(directory, "node.mjs")).href);
const id = "019fa0ca-9059-7147-83c2-ccf7b433a4ef";
const origin = "https://comfy.reference.fixture.example:8443/";
const image = (filename = "角色.png") => ({
  filename,
  subfolder: "selected",
  type: "output",
});
const request = (workflowId = "krea2-reference-four-view") => ({
  workflowId,
  prompt: "  保留同一成年人物的外观\n四视图  ",
  operationId: id,
  sourceServiceOrigin: origin,
  targetServiceOrigin: origin,
  images:
    workflowId === "krea2-reference-four-view"
      ? { character: image() }
      : {
          scene: image("客厅.png"),
          characterOne: image("男主.png"),
          characterTwo: image("女主.png"),
        },
});
const source = async (file) =>
  JSON.parse(
    await readFile(new URL(`../src/templates/${file}`, import.meta.url)),
  );
function assertOnlySlots(actual, original, changed) {
  assert.deepEqual(Object.keys(actual), Object.keys(original));
  for (const [nodeId, node] of Object.entries(original)) {
    const copy = structuredClone(actual[nodeId]);
    for (const [id, input] of changed)
      if (id === nodeId) copy.inputs[input] = node.inputs[input];
    assert.deepEqual(copy, node, nodeId);
  }
}
test("T10 renders exactly the reviewed positive, output and reference slots, preserving negative conditioning and every original node", async () => {
  const original = await source("krea2-reference-four-view.api.json");
  const input = request();
  const out = render(input);
  assert.equal(out.graph["143"].inputs.prompt, input.prompt);
  assert.equal(out.graph["133"].inputs.prompt, "");
  assert.deepEqual(out.graph["142"].inputs.positive, ["143", 0]);
  assert.deepEqual(out.graph["142"].inputs.negative, ["133", 0]);
  assert.equal(out.graph["146"].inputs.image, "selected/角色.png [output]");
  assert.equal(out.graph["129"].inputs.filename_prefix, `crewon-${id}`);
  assert.equal(out.outputNodeId, "129");
  assertOnlySlots(out.graph, original, [
    ["143", "prompt"],
    ["146", "image"],
    ["129", "filename_prefix"],
  ]);
  input.images.character.filename = "changed.png";
  assert.equal(out.sourceImages.character.filename, "角色.png");
  assert.equal(Object.isFrozen(out.graph["142"].inputs.positive), true);
  assert.equal(Object.isFrozen(out.sourceImages.character), true);
});
test("D18 freezes the scene and ordered two characters, supplies disabled file slots and changes no flags, seeds or wiring", async () => {
  const original = await source("flux2-three-reference-storyboard.api.json");
  const input = request("flux2-three-reference-storyboard");
  const out = render(input);
  for (const nodeId of ["240", "277", "548"])
    assert.equal(out.graph[nodeId].inputs.image, "selected/客厅.png [output]");
  assert.equal(out.graph["278"].inputs.image, "selected/男主.png [output]");
  assert.equal(out.graph["279"].inputs.image, "selected/女主.png [output]");
  assert.equal(out.graph["277"].inputs.enabled, false);
  assert.equal(out.graph["548"].inputs.enabled, false);
  assert.equal(out.graph["235:231"].inputs.text, input.prompt);
  assert.equal(out.outputNodeId, "17");
  assertOnlySlots(out.graph, original, [
    ["235:231", "text"],
    ["17", "filename_prefix"],
    ...["240", "277", "548", "278", "279"].map((n) => [n, "image"]),
  ]);
});
test("the catalog declares image output and immutable template digests, without publishing execution permission", () => {
  assert.deepEqual(
    catalog.map((x) => [x.workflowId, x.outputNodeId, x.imageRoles]),
    [
      ["krea2-reference-four-view", "129", ["character"]],
      [
        "flux2-three-reference-storyboard",
        "17",
        ["scene", "characterOne", "characterTwo"],
      ],
    ],
  );
  for (const entry of catalog) {
    assert.match(entry.workflowDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(entry.outputKind, "image");
    assert.equal(entry.preparation, "verified-same-service-output");
    assert.equal(
      render(request(entry.workflowId)).workflowDigest,
      entry.workflowDigest,
    );
    assert.equal(Object.isFrozen(entry.imageRoles), true);
  }
});
for (const [name, change] of [
  [
    "different supplier origins",
    (r) => {
      r.targetServiceOrigin = "https://other.fixture.example/";
    },
  ],
  [
    "HTTP source",
    (r) => {
      r.sourceServiceOrigin = "http://comfy.reference.fixture.example/";
    },
  ],
  [
    "origin credentials",
    (r) => {
      r.sourceServiceOrigin =
        "https://user:secret@comfy.reference.fixture.example/";
    },
  ],
  [
    "origin path",
    (r) => {
      r.sourceServiceOrigin = origin + "path";
    },
  ],
  [
    "origin query",
    (r) => {
      r.sourceServiceOrigin = origin + "?key=secret";
    },
  ],
  [
    "input directory result",
    (r) => {
      r.images.character.type = "input";
    },
  ],
  [
    "arbitrary URL reference",
    (r) => {
      r.images.character.filename = "https://example.com/image.png";
    },
  ],
  [
    "subfolder traversal",
    (r) => {
      r.images.character.subfolder = "../private";
    },
  ],
  [
    "absolute filename",
    (r) => {
      r.images.character.filename = "/tmp/image.png";
    },
  ],
  [
    "annotation injection",
    (r) => {
      r.images.character.filename = "image [input]";
    },
  ],
  [
    "empty path component",
    (r) => {
      r.images.character.subfolder = "nested//folder";
    },
  ],
  [
    "Windows path",
    (r) => {
      r.images.character.subfolder = "C:\\private";
    },
  ],
  [
    "extra image role",
    (r) => {
      r.images.scene = image();
    },
  ],
  [
    "missing image role",
    (r) => {
      delete r.images.character;
    },
  ],
  [
    "extra operation field",
    (r) => {
      r.owner = "invented";
    },
  ],
  [
    "unsupported workflow",
    (r) => {
      r.workflowId = "video";
    },
  ],
  [
    "invalid operation identity",
    (r) => {
      r.operationId = "not-an-id";
    },
  ],
  [
    "blank prompt",
    (r) => {
      r.prompt = " \n ";
    },
  ],
  [
    "oversized prompt",
    (r) => {
      r.prompt = "x".repeat(2001);
    },
  ],
])
  test(`reference adapter rejects ${name} before any IO`, () => {
    const input = request();
    change(input);
    assert.throws(() => render(input));
  });
test("reference adapter snapshots data descriptors and rejects proxy/getter input without executing model-controlled code", () => {
  let reads = 0;
  const r = request();
  Object.defineProperty(r.images.character, "filename", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("must not run");
    },
  });
  assert.throws(() => render(r));
  assert.equal(reads, 0);
  assert.throws(() =>
    render(
      new Proxy(request(), {
        ownKeys() {
          reads++;
          throw new Error("must not run");
        },
      }),
    ),
  );
  assert.equal(reads, 0);
});
for (const [workflowId, nodeId] of [
  ["krea2-reference-four-view", "129"],
  ["flux2-three-reference-storyboard", "17"],
]) {
  test(`${workflowId} observes only its own declared output, preserving exact file reference`, async () => {
    const paths = [];
    const out = await observe(workflowId, id, async (path) => {
      paths.push(path);
      return {
        [id]: {
          status: { completed: true, status_str: "success" },
          outputs: {
            29: { images: [image("wrong.png")] },
            [nodeId]: { images: [image("actual.png")] },
          },
        },
      };
    });
    assert.deepEqual(paths, ["/history/" + id]);
    assert.deepEqual(out, {
      status: "succeeded",
      images: [image("actual.png")],
    });
  });
}
test("missing target output never falls back to another image node", async () => {
  await assert.rejects(
    observe("krea2-reference-four-view", id, async () => ({
      [id]: {
        status: { completed: true, status_str: "success" },
        outputs: { 29: { images: [image()] } },
      },
    })),
  );
});
test("unknown original reference generation only reads history and queue, never prepares another submission", async () => {
  const calls = [];
  const out = await observe(
    "flux2-three-reference-storyboard",
    id,
    async (path) => {
      calls.push(path);
      return path.startsWith("/history/")
        ? {}
        : { queue_running: [], queue_pending: [] };
    },
  );
  assert.deepEqual(calls, ["/history/" + id, "/queue"]);
  assert.deepEqual(out, { status: "unknownOutcome", images: [] });
});
