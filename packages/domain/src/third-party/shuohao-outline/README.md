# Pinned novel-outline validators

Source: https://github.com/eternityspring/shuohao-skills/tree/ef4ac0c313c7eeb1f918db5f0f0eb319745900bc/skills/novel-outline

Revision: `ef4ac0c313c7eeb1f918db5f0f0eb319745900bc`, Apache-2.0. Original script SHA256: `33f1469123333b98b5e56f4b81cd64df80b58e1878e0cf7212b585f6e8ac8597`.

`core.mjs` retains the original pure constants, `thresholdsOf`, `gateReport`, and `validateOutline` functions verbatim, with a provenance header. Node imports, file access, CLI, chunking, HTML/Markdown reports and asset rendering are omitted. The example `ferry-outline.fixture.json` is the pinned `examples/渡口-outline.json`; its original bytes and attribution are retained for behavioral tests.

CrewON's adapter in `project-outline-quality.ts` supplies a strict, detached v2 document and maps stable episode identities to the Skill's temporary ordinal view. The validators grant no permissions and do not write, adopt or generate project results. Stage omissions and the optional prop cap are displayed as skipped rather than completed checks. Source quotes are not verified by this pure evaluator.
