# Pinned novel-script validators

Source: https://github.com/eternityspring/shuohao-skills/tree/ef4ac0c313c7eeb1f918db5f0f0eb319745900bc/skills/novel-script

Revision: `ef4ac0c313c7eeb1f918db5f0f0eb319745900bc`, Apache-2.0. Original `scripts/novel-script.mjs` SHA256: `833511f3dcc01373687f12065cb8c843e505958fb344d015535ffb4c928bc7bc`.

`core.mjs` retains the original pure default parameters, timing, statistics, ten quality gates and validation functions verbatim, with a provenance header. Node imports, file access, CLI, seed, and Markdown/HTML rendering are omitted. `core.d.mts` supplies CrewON's types without modifying the original evaluator.

`ferry-script.fixture.json` retains the pinned `examples/渡口-script.json` bytes. `ferry-art.fixture.json` retains the pinned `references/test-fixtures/upstream/渡口-art.json` bytes. Both are licensed reference fixtures; neither is a user project or proof of a real model execution.

CrewON's adapter supplies detached, immutable v2 screenplay content. Original episode, scene occurrence, art entity and flow beat identities are retained. Only the temporary validation view maps art scene IDs to the Skill's S labels and stable hook beat IDs to scene/beat positions. Outline beats are checked by their original IDs as well as the Skill's type-based check. Missing upstream data is explicitly skipped; a partial check cannot report all gates passed.

This module does not read original books, grant permissions, save/select artifacts, generate media or run an Agent. The document and validators are not yet connected to the persisted script service or plugin UI. Qualitative writing guidance and original-source evidence still require separate review.
