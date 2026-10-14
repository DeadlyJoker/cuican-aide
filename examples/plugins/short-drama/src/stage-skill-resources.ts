/** Verbatim excerpts from reviewed, immutable upstream Skill documents.
 * Generated metadata does not grant tools or execute upstream frontmatter.
 */
export const SHUOHAO_SKILLS_REVISION =
  "dd1adef5c8189b489f6b901e8ab8d7c394c81a3e";
export const SHUOHAO_STAGE_DOCUMENTS = {
  "novel-outline": {
    path: "skills/novel-outline/SKILL.md",
    sha256:
      "sha256:055e2fb2ad76462635cc82fe78a68ab65f613e68cd8b88a9570c9880ff522427",
    byteLength: 8991,
    lines: [64, 70],
    excerpt:
      "材料优先级，写死：\n\n1. 用户点名的**精读章节**\n2. **章节目录 + 简介**\n3. 全文**分卷摘要**（Step 2）\n\n**禁止凭书名脑补内容**——一切判断基于给到的文本。落地手段：`adaptation.keep` 的关键取舍要附 `evidence`（原文逐字片段）。",
  },
  "novel-script": {
    path: "skills/novel-script/SKILL.md",
    sha256:
      "sha256:689e28a0824dafad65eec3b0948fd9ffa12e369d74a2e07eeeb946ada711da58",
    byteLength: 9204,
    lines: [86, 88],
    excerpt:
      "- 该集的 seed 骨架 + 大纲里这一集的梗概/爽点/人群方案\n- 该集用到的场景卡（art.json 里的锚点、光照状态）与角色信息（性情、说话方式——有 cast.json 更好）\n- **前一集的结尾悬念**（这一集的开场要接得上）",
  },
  "novel-characters": {
    path: "skills/novel-characters/SKILL.md",
    sha256:
      "sha256:cda2bc652a24548a68f4ae632f47380b7d275134769a9495feb7891b0ed5ab44",
    byteLength: 11764,
    lines: [92, 96],
    excerpt:
      "两处口径要守住：\n\n- **大纲定的分档不要推翻**。谁重要是改编阶段拍板的事，这一层只负责把定下来的人做深。真觉得分档不对，回去改大纲，别在这里悄悄改一个不一样的\n- **主角组内部可以细分**。outline 的 `lead` 是「男女主 + 主反派」一整组，对应 `protagonist` 与 `major` 两档，seed 一律给 `protagonist`；照 `seedNote` 里的定位把主角之外的改成 `major`，这不算推翻分档\n",
  },
  "novel-art": {
    path: "skills/novel-art/SKILL.md",
    sha256:
      "sha256:688116bcb868ad68f0bfbe5d029f1d65b2f1ce2918b98734f653cea0216a1377",
    byteLength: 8297,
    lines: [87, 87],
    excerpt:
      "核心要求都在 scene-pass.md 里，最重的三条：锚点要**可画可认可核对**（「补丁船篷」是锚点，「陈旧的氛围」是形容词）；光照状态**从分集反推**，不写用不上的全家桶；**能做变体就别开新景**。",
  },
  "novel-storyboard": {
    path: "skills/novel-storyboard/SKILL.md",
    sha256:
      "sha256:2af3bb17fa9719976fe9f2486ba09f26bdc4397aa45f13a18884408e2a7fe857",
    byteLength: 14449,
    lines: [72, 74],
    excerpt:
      "**一次切几集**：跟剧本的批次走（剧本写到哪就分到哪），默认一批 ≤ 3 集。\n\n**先定画幅**：storyboard.json 顶层 `aspectRatio` 是分镜与下游出图共同遵守的正式合同，只接受 `16:9` 或 `9:16`。没有特别要求时使用 `16:9`；竖屏短剧明确写 `9:16`。",
  },
  "character-refs": {
    path: "skills/character-refs/SKILL.md",
    sha256:
      "sha256:16f39d589dbf727b90ef5d218447e1de5469bbd892e0b1a025340c5e050bc448",
    byteLength: 13071,
    lines: [48, 50],
    excerpt:
      "- **一组图只有一个根：正面全身锚点。**只有它是文生图，其余全是「锚点 + 一句改图指令」。\n  头发、脸、领口三类细节额外挂确认过的正脸大头照。图与图之间不再互相参考——\n  所以任何一张出坏了，单独重出这一张就行，不会连锁。",
  },
} as const;
export type ShortDramaStageSkill = keyof typeof SHUOHAO_STAGE_DOCUMENTS;
export const SHUOHAO_RESOURCE_FILES = [
  {
    skill: "novel-outline",
    path: "skills/novel-outline/SKILL.md",
    byteLength: 8991,
    sha256:
      "sha256:055e2fb2ad76462635cc82fe78a68ab65f613e68cd8b88a9570c9880ff522427",
  },
  {
    skill: "novel-outline",
    path: "skills/novel-outline/references/episode-pass.md",
    byteLength: 1627,
    sha256:
      "sha256:33b2a3f75e1a0cf1c5ce48d41b7097988c4c65fb5745bd90189a517bcf26936a",
  },
  {
    skill: "novel-outline",
    path: "skills/novel-outline/references/outline-pass.md",
    byteLength: 3515,
    sha256:
      "sha256:9ca4c4a5b98eb2eb6e366549fbd0709387fbb7e679b49da8cef08dba9b8f3a71",
  },
  {
    skill: "novel-outline",
    path: "skills/novel-outline/references/report-style.md",
    byteLength: 5311,
    sha256:
      "sha256:f491d22ee8ec32441fa5c8af360fee44e331ef5f8c2febcebf4c6fbf8d7e2549",
  },
  {
    skill: "novel-outline",
    path: "skills/novel-outline/references/schema.md",
    byteLength: 7464,
    sha256:
      "sha256:3411cab8074f304870f58421ccd11c98237e6b5c84ceb9647d9d43397635ea53",
  },
  {
    skill: "novel-outline",
    path: "skills/novel-outline/references/volume-pass.md",
    byteLength: 1392,
    sha256:
      "sha256:35eb510c39fc9e5c9c83a47114854a4f306cc6dd2ea21e8747570d5e557ddef8",
  },
  {
    skill: "novel-script",
    path: "skills/novel-script/SKILL.md",
    byteLength: 9204,
    sha256:
      "sha256:689e28a0824dafad65eec3b0948fd9ffa12e369d74a2e07eeeb946ada711da58",
  },
  {
    skill: "novel-script",
    path: "skills/novel-script/references/report-style.md",
    byteLength: 3192,
    sha256:
      "sha256:582818c595f23fca69de4a4224200413cb761828563461961dfefdd2eb6e1a01",
  },
  {
    skill: "novel-script",
    path: "skills/novel-script/references/schema.md",
    byteLength: 3589,
    sha256:
      "sha256:610e4131dae47fc534ec5b075d68351abe6982890c44fedfb296d39c3fadf4aa",
  },
  {
    skill: "novel-script",
    path: "skills/novel-script/references/script-pass.md",
    byteLength: 5515,
    sha256:
      "sha256:825aea57b0118dc3ef1b470bf5a7db7f0f94b7dccfa1135549bac5abbe85dfc0",
  },
  {
    skill: "novel-characters",
    path: "skills/novel-characters/SKILL.md",
    byteLength: 11764,
    sha256:
      "sha256:cda2bc652a24548a68f4ae632f47380b7d275134769a9495feb7891b0ed5ab44",
  },
  {
    skill: "novel-characters",
    path: "skills/novel-characters/references/profile-pass.md",
    byteLength: 18726,
    sha256:
      "sha256:25350002e6543de3ea565c73a4d2ad650e3c71405ec1bd27cf961f93792bb0ff",
  },
  {
    skill: "novel-characters",
    path: "skills/novel-characters/references/report-style.md",
    byteLength: 8771,
    sha256:
      "sha256:c550951b591152bc490ecb3af587ce2d3fea9663847b34648316ee437f0ce14e",
  },
  {
    skill: "novel-characters",
    path: "skills/novel-characters/references/roster-pass.md",
    byteLength: 1944,
    sha256:
      "sha256:c2f9716f4bcb0b3c39038da9526ed60cda3af48119320561e7fe4944f1dc0bd8",
  },
  {
    skill: "novel-characters",
    path: "skills/novel-characters/references/schema.md",
    byteLength: 5992,
    sha256:
      "sha256:f6c62bbe5f424f10cc52ca2e9c1d2c162b5bcefd7eebea67f1c1b88a28c1e4de",
  },
  {
    skill: "novel-characters",
    path: "skills/novel-characters/references/sheet.md",
    byteLength: 3912,
    sha256:
      "sha256:a9a6175a660f1e3f59f499b792c7b5422cf10d4bcb566985461e5d9d192c7972",
  },
  {
    skill: "novel-art",
    path: "skills/novel-art/SKILL.md",
    byteLength: 8297,
    sha256:
      "sha256:688116bcb868ad68f0bfbe5d029f1d65b2f1ce2918b98734f653cea0216a1377",
  },
  {
    skill: "novel-art",
    path: "skills/novel-art/references/prop-pass.md",
    byteLength: 3527,
    sha256:
      "sha256:20f9e6593be435b1cec84f86c120d5d1bb6505f6b9ab21448c4afeaf1208f18d",
  },
  {
    skill: "novel-art",
    path: "skills/novel-art/references/report-style.md",
    byteLength: 2512,
    sha256:
      "sha256:291c83df686938afe1b9f802ce9bde2ffb2166d7f04e25ae6f099bc8d6bef472",
  },
  {
    skill: "novel-art",
    path: "skills/novel-art/references/scene-pass.md",
    byteLength: 6793,
    sha256:
      "sha256:93de7cfb1c9cc720b3ee5507ac9d30a1fd0dec15a0192424ed9a57a0edd166d7",
  },
  {
    skill: "novel-art",
    path: "skills/novel-art/references/schema.md",
    byteLength: 5592,
    sha256:
      "sha256:92573bc6fae465ac82a01a1d7fc2b3e15cce8a8a19c37a76ca0ff82a3222da09",
  },
  {
    skill: "novel-art",
    path: "skills/novel-art/references/sheet.md",
    byteLength: 3858,
    sha256:
      "sha256:a3caff5173a15af62ad73d11c08bd479d1f624481793708d880775114a9a1ed4",
  },
  {
    skill: "novel-storyboard",
    path: "skills/novel-storyboard/SKILL.md",
    byteLength: 14449,
    sha256:
      "sha256:2af3bb17fa9719976fe9f2486ba09f26bdc4397aa45f13a18884408e2a7fe857",
  },
  {
    skill: "novel-storyboard",
    path: "skills/novel-storyboard/references/frame.md",
    byteLength: 3729,
    sha256:
      "sha256:8932f811350fd816d95206db2bccefe8450ad3a65216cba6bf822f7f73a93790",
  },
  {
    skill: "novel-storyboard",
    path: "skills/novel-storyboard/references/h3-prompt.md",
    byteLength: 4094,
    sha256:
      "sha256:a8764ab72b76c13563d053d86f40ace30357e197a5738e4a22811f6a9a30702e",
  },
  {
    skill: "novel-storyboard",
    path: "skills/novel-storyboard/references/report-style.md",
    byteLength: 3619,
    sha256:
      "sha256:75bf9bbf5d0385a6e7e2db33a12e3446c674fa6d61ef984c347f195c15095cc6",
  },
  {
    skill: "novel-storyboard",
    path: "skills/novel-storyboard/references/schema.md",
    byteLength: 8189,
    sha256:
      "sha256:7eff862c9cae2f0be00a5d6f45393994754148bcc91970cddbc69dca6ff4fbd9",
  },
  {
    skill: "novel-storyboard",
    path: "skills/novel-storyboard/references/seedance-prompt.md",
    byteLength: 7466,
    sha256:
      "sha256:d5d44809846d8d96ace57c22f83f47681c2206e84076aa4c80aab5ba955a723a",
  },
  {
    skill: "novel-storyboard",
    path: "skills/novel-storyboard/references/shot-writing.md",
    byteLength: 6188,
    sha256:
      "sha256:501fea6f027b356a0e314b9ef7b0b6ab896287c2b754eeeeac5c59548511fd0c",
  },
  {
    skill: "novel-storyboard",
    path: "skills/novel-storyboard/references/storyboard-pass.md",
    byteLength: 6557,
    sha256:
      "sha256:909e66aca5b5f1a4a8f96b3bbc45cc162346fddbe16f2892dac85ce155f4e6d8",
  },
  {
    skill: "character-refs",
    path: "skills/character-refs/SKILL.md",
    byteLength: 13071,
    sha256:
      "sha256:16f39d589dbf727b90ef5d218447e1de5469bbd892e0b1a025340c5e050bc448",
  },
  {
    skill: "character-refs",
    path: "skills/character-refs/references/intake.md",
    byteLength: 5845,
    sha256:
      "sha256:e7bcc2ed0251cbd065ea2ebe6a166d951d97edc3125360dd9aa8ac4f948b1aff",
  },
  {
    skill: "character-refs",
    path: "skills/character-refs/references/models.md",
    byteLength: 5215,
    sha256:
      "sha256:9e4e304289f5c38762c2a2fccaa17aba10d599b4ddd86995e26afe9c55c4627a",
  },
  {
    skill: "character-refs",
    path: "skills/character-refs/references/prompting.md",
    byteLength: 8156,
    sha256:
      "sha256:be4572cb6a23552376eee10fdb1a4e7705d54a8fe5a602855786dfa279f08839",
  },
  {
    skill: "character-refs",
    path: "skills/character-refs/references/schema.md",
    byteLength: 4491,
    sha256:
      "sha256:a37e8ad68ce5e36468869f95dc06d3c18d2f024da3ada085690e9ee963cadd28",
  },
] as const;
