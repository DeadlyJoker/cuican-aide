// Derived from shuohao-skills novel-outline at ef4ac0c313c7eeb1f918db5f0f0eb319745900bc.
// Copyright 2026 烁皓. Apache-2.0; see LICENSE and NOTICE.
// Only pure constants and validators are retained. CLI, file IO, chunking, reports and asset rendering are omitted.

export const ADAPT_MODES = ['忠实', '抽核', '借壳'];
export const BEAT_WEIGHTS = ['major', 'minor'];

/*
 * 角色分档。一刀切的「有名字角色 ≤ 6」混淆了两件事：观众要记住谁、
 * 制作要维护多少张脸。分档把它拆开——每一档的一致性投入完全不同。
 * 无名背景人不进表、不追踪、不限量。
 *
 * 从 novel-characters 的 cast.json 喂进来时按 importance 映射：
 * protagonist/major → lead，supporting → support，minor → functional。
 */
export const CHARACTER_TIERS = ['lead', 'support', 'functional'];
export const TIER_LABELS = { lead: '主角组', support: '重要配角', functional: '功能性角色' };
/** AI 短剧的角色资产量折算——资产清单按这个自动汇总，不让模型写。 */
export const TIER_ASSET_SPEC = {
  lead: '全套角色设定图 + 逐镜一致性核对',
  support: '半身参考图，关键戏核对',
  functional: '提示词直出，松散一致即可',
};

export const DEFAULT_THRESHOLDS = {
  maxLeads: 5,          // 主角组上限（男女主 + 主反派）
  maxSupport: 10,       // 有名字的重要配角上限
  maxFunctional: 10,    // 功能性角色上限（占脸不占名，name 用称呼标签）
  maxBeatGap: 3,        // 相邻爽点最大间隔（集）
  maxProps: 8,          // 叙事道具上限。跟主角数量一个量级——收多了就不是叙事道具，
                        //   是场景陈设，那归 novel-art 的场景锚点管
  // maxPrimaryScenes 不在这里——它随集数动态，见 primarySceneCap()
};

/**
 * 主场景上限随集数走。
 *
 * 这是给 **AI 短剧**定的数，不是实景剧组的数——场景是生成的，没有搭景钱，
 * 「≤ 5」那种实景经济学在这里不成立。上限守的只剩两件事：每个主场景的
 * **跨集一致性资产**（环境参考图、光照基调），以及观众的空间认知负担。
 * 所以放得宽：观赏性直接吃场景多样性，别为省不存在的钱把戏憋在一个屋里。
 *
 *   上限 = clamp(4 + ⌈集数 / 10⌉, 5, 15)
 *
 * 锚点：6 集微型剧 5 个；60 集 10 个；110 集以上封顶 15。
 * `params.thresholds.maxPrimaryScenes` 显式给了就用给的，动态值只是缺省。
 */
export function primarySceneCap(episodes) {
  if (!Number.isInteger(episodes) || episodes < 1) return 8; // 没有集数信息给个居中值
  return Math.max(5, Math.min(15, 4 + Math.ceil(episodes / 10)));
}

/**
 * 生成难点关键词表：梗概里扫到就必须进该集的 warnings。
 * 宁可多报不可漏报——预警清单的意义就是拍摄前有人看过一眼。
 */
export const RISK_PATTERNS = {
  雨戏: /雨/,
  肢体接触: /吻|拥抱|相拥|牵手|贴身|扭打|搂/,
  人群: /人群|围观|众人|满堂|满座|集市|人山/,
  手部特写: /手部|指尖|十指|特写.{0,4}手/,
};

/** 梗概必须是叙述体——出现引号对白就是在写剧本，越界。 */
const DIALOGUE_RE = /「|」|『|』|“|”/;


const thText = (s) => typeof s === 'string' && s.trim();

function thresholdsOf(outline) {
  const explicit = outline?.params?.thresholds ?? {};
  const th = { ...DEFAULT_THRESHOLDS, ...explicit };
  if (explicit.maxPrimaryScenes === undefined) th.maxPrimaryScenes = primarySceneCap(outline?.params?.episodes);
  return th;
}

/** 每集的正文字段，关键词扫描和对白检查都扫这三栏。 */
const EP_TEXT_FIELDS = ['synopsis', 'hook', 'suspense'];

export function gateReport(outline) {
  const th = thresholdsOf(outline);
  const gates = [];
  // enKey：中文标签会随条件变化的门（目前只有 refs），英文查表要另给一个键。
  // 门 id 保持稳定不动——它是日志与下游对账的凭据。
  const add = (id, label, ok, detail = '', enKey = null) =>
    gates.push({ id, label, ok, detail, ...(enKey ? { enKey } : {}) });

  const chars = Array.isArray(outline?.characters) ? outline.characters : [];
  const scenes = Array.isArray(outline?.scenes) ? outline.scenes : [];
  const beats = Array.isArray(outline?.beats) ? outline.beats : [];
  const eps = Array.isArray(outline?.episodes) ? outline.episodes : [];
  const total = outline?.params?.episodes ?? eps.length;
  // props 是后加的字段。**没有这个字段的旧大纲要照常通过**——两道相关的门
  // 都明说跳过而不是报错，否则每一份存量 outline.json 一升级就全红。
  const hasProps = Array.isArray(outline?.props);
  const props = hasProps ? outline.props : [];

  // G1a–G1c 角色分档上限。主角组还要求至少 1 人——没有主角的剧不成立
  const tierCap = { lead: th.maxLeads, support: th.maxSupport, functional: th.maxFunctional };
  for (const tier of CHARACTER_TIERS) {
    const n = chars.filter((c) => c?.tier === tier).length;
    const needMin = tier === 'lead';
    add(
      `${tier}-cap`,
      `${TIER_LABELS[tier]} ${needMin ? `1–${tierCap[tier]}` : `≤ ${tierCap[tier]}`} 人`,
      (needMin ? n >= 1 : true) && n <= tierCap[tier],
      `${n} 位`,
    );
  }

  // G2 主场景上限
  const primary = scenes.filter((s) => s?.primary);
  add('scene-cap', `主场景 ≤ ${th.maxPrimaryScenes}`, scenes.length > 0 && primary.length <= th.maxPrimaryScenes, `${primary.length} 个`);

  // G2b 叙事道具上限。只收有特写、跨集、承载剧情的那几件；数量失控说明把场景
  // 陈设也收进来了。没有 props 字段的旧大纲明说跳过，不判失败。
  add(
    'prop-cap',
    `叙事道具 ≤ ${th.maxProps} 件`,
    !hasProps || props.length <= th.maxProps,
    hasProps ? `${props.length} 件` : '大纲没有 props 字段，跳过',
  );

  // 场景/角色使用统计（G3、G10 共用）。
  // 只给已登记的 id 计数——未知 id 塞进索引会让「引用不存在」那道门形同虚设。
  const sceneUse = new Map(scenes.map((s) => [s?.id, 0]));
  const charUse = new Map(chars.map((c) => [c?.id, 0]));
  const propUse = new Map(props.map((pr) => [pr?.id, 0]));
  for (const e of eps) {
    for (const id of e?.sceneIds ?? []) if (sceneUse.has(id)) sceneUse.set(id, sceneUse.get(id) + 1);
    for (const id of e?.characterIds ?? []) if (charUse.has(id)) charUse.set(id, charUse.get(id) + 1);
    for (const id of e?.propIds ?? []) if (propUse.has(id)) propUse.set(id, propUse.get(id) + 1);
  }

  // G3 一次性场景要有规避方案
  const onceNoPlan = scenes.filter((s) => sceneUse.get(s?.id) === 1 && !thText(s?.reusePlan));
  add(
    'once-scene',
    '一次性场景已标注规避方案',
    eps.length > 0 && onceNoPlan.length === 0,
    onceNoPlan.length ? `缺：${onceNoPlan.map((s) => s.name ?? s.id).join('、')}` : '',
  );

  // G4 爽点间隔 ≤ N，首尾无真空
  const beatEps = [...new Set(beats.map((b) => b?.episode).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  let gapOk = beatEps.length > 0 && total > 0;
  let gapDetail = '';
  if (gapOk) {
    if (beatEps[0] > th.maxBeatGap) {
      gapOk = false;
      gapDetail = `开头 ${beatEps[0] - 1} 集真空`;
    }
    for (let i = 1; i < beatEps.length && gapOk; i++) {
      if (beatEps[i] - beatEps[i - 1] > th.maxBeatGap) {
        gapOk = false;
        gapDetail = `第 ${beatEps[i - 1]}–${beatEps[i]} 集之间断档`;
      }
    }
    if (gapOk && total - beatEps[beatEps.length - 1] >= th.maxBeatGap) {
      gapOk = false;
      gapDetail = `结尾 ${total - beatEps[beatEps.length - 1]} 集真空`;
    }
  }
  add('beat-gap', `爽点间隔 ≤ ${th.maxBeatGap} 集，无真空区`, gapOk, gapDetail);

  // G5 第 1 集有钩子
  add('ep1-hook', '第 1 集有钩子', eps.length > 0 && thText(eps[0]?.hook), '');

  // G6 大爆点不能到最后一集才第一次出现
  const majors = beats.filter((b) => (b?.weight ?? 'minor') === 'major').map((b) => b.episode);
  add(
    'major-early',
    '大爆点不在最后一集才首次出现',
    majors.length > 0 && Math.min(...majors) < total,
    majors.length ? `最早在第 ${Math.min(...majors)} 集` : '没有 major 爽点',
  );

  // G7 每集三栏齐全（钩子/悬念必填）
  const incomplete = eps.filter((e) => !EP_TEXT_FIELDS.every((f) => thText(e?.[f])));
  add(
    'ep-fields',
    '每集梗概三栏齐全（含【钩子】【悬念】）',
    eps.length > 0 && incomplete.length === 0,
    incomplete.length ? `缺栏：第 ${incomplete.map((e) => e.ep).join('、')} 集` : '',
  );

  // G8 三人以上同框要有拆解方案
  const crowdBad = eps.filter((e) => (e?.characterIds?.length ?? 0) >= 3 && !thText(e?.crowdPlan));
  add(
    'crowd-plan',
    '三人以上同框已标注拆解方案',
    crowdBad.length === 0,
    crowdBad.length ? `缺：第 ${crowdBad.map((e) => e.ep).join('、')} 集` : '',
  );

  // G9 生成难点进预警清单（关键词扫描，宁可多报）
  const riskBad = [];
  for (const e of eps) {
    const text = EP_TEXT_FIELDS.map((f) => e?.[f] ?? '').join(' ');
    for (const [risk, re] of Object.entries(RISK_PATTERNS)) {
      if (re.test(text) && !(e?.warnings ?? []).includes(risk)) riskBad.push(`第 ${e.ep} 集缺「${risk}」`);
    }
  }
  add('risk-flag', '生成难点已进预警清单', eps.length > 0 && riskBad.length === 0, riskBad.join('；'));

  // G10 引用完整：ID 都存在、没有失业角色、没有空转场景
  const refBad = [];
  for (const e of eps) {
    for (const id of e?.sceneIds ?? []) if (!sceneUse.has(id)) refBad.push(`第 ${e.ep} 集引用了不存在的场景 ${id}`);
    for (const id of e?.characterIds ?? []) if (!charUse.has(id)) refBad.push(`第 ${e.ep} 集引用了不存在的角色 ${id}`);
    if (hasProps) {
      for (const id of e?.propIds ?? []) if (!propUse.has(id)) refBad.push(`第 ${e.ep} 集引用了不存在的道具 ${id}`);
    }
  }
  for (const b of beats) {
    if (Number.isInteger(b?.episode) && (b.episode < 1 || b.episode > total)) {
      refBad.push(`爽点 ${b.id} 落在不存在的第 ${b.episode} 集`);
    }
  }
  for (const [id, n] of charUse) if (n === 0) refBad.push(`角色 ${id} 从未在任何一集出现`);
  for (const [id, n] of sceneUse) if (n === 0) refBad.push(`场景 ${id} 从未被用到`);
  if (hasProps) {
    for (const [id, n] of propUse) if (n === 0) refBad.push(`道具 ${id} 从未在任何一集出现`);
    // 道具关联的爽点必须真的存在——beatIds 指错等于这件道具没有戏剧理由
    const beatIds = new Set(beats.map((b) => b?.id));
    for (const pr of props) {
      for (const bid of pr?.beatIds ?? []) {
        if (!beatIds.has(bid)) refBad.push(`道具 ${pr.id} 关联了不存在的爽点 ${bid}`);
      }
    }
  }
  add(
    'refs',
    hasProps ? '场景/角色/道具引用完整，无失业角色、无空转场景、无零集道具' : '场景/角色引用完整，无失业角色、无空转场景',
    eps.length > 0 && refBad.length === 0,
    refBad.join('；'),
    hasProps ? 'refs-props' : null,
  );

  // G11 梗概是叙述体
  const dlgBad = eps.filter((e) => EP_TEXT_FIELDS.some((f) => DIALOGUE_RE.test(e?.[f] ?? '')));
  add(
    'no-dialogue',
    '梗概是叙述体，无引号对白',
    dlgBad.length === 0,
    dlgBad.length ? `第 ${dlgBad.map((e) => e.ep).join('、')} 集出现引号` : '',
  );

  return gates;
}

/* ------------------------------------------------------------------ */
/* validate                                                            */
/* ------------------------------------------------------------------ */
/*
 * 三档 stage 就是流程门：
 *   skeleton — 改编说明 + 人物 + 场景（快版拍板前）
 *   beats    — skeleton + 爽点表（写分集之前必须过这档）
 *   full     — 全部（默认）
 * 「步骤 4 完成前不允许写分集梗概」靠这个变成可执行的，而不是一句话。
 */

export const STAGES = ['skeleton', 'beats', 'full'];

export function validateOutline(outline, stage = 'full') {
  const problems = [];
  const p = (msg) => problems.push(msg);
  if (!outline || typeof outline !== 'object') return ['outline 不是对象'];
  const th = thresholdsOf(outline);

  // --- params ---
  const params = outline.params;
  if (!params || typeof params !== 'object') {
    p('缺少 params（总集数/单集时长/题材/改编幅度）');
  } else {
    if (!Number.isInteger(params.episodes) || params.episodes < 1) p('params.episodes 必须是正整数');
    if (!(params.minutesPerEpisode > 0)) p('params.minutesPerEpisode 必须大于 0');
    if (!thText(params.genre)) p('params.genre 缺失——题材决定爽点类型，不能缺');
    if (!ADAPT_MODES.includes(params.adaptMode)) {
      p(`params.adaptMode 必须是 ${ADAPT_MODES.join('/')}，实际是 ${JSON.stringify(params.adaptMode)}`);
    }
  }

  // --- adaptation 改编说明 ---
  const ad = outline.adaptation;
  if (!ad || typeof ad !== 'object') {
    p('缺少 adaptation（改编说明）');
  } else {
    if (!thText(ad.core)) p('adaptation.core 缺失——一句话核心是整份大纲的锚');
    for (const key of ['keep', 'cut', 'merge', 'risks']) {
      if (!Array.isArray(ad[key])) p(`adaptation.${key} 必须是数组`);
    }
    if (Array.isArray(ad.keep) && ad.keep.length === 0) p('adaptation.keep 至少要有一条——什么都不保还改编什么');
    if (params?.adaptMode && params.adaptMode !== '忠实' && Array.isArray(ad.cut) && ad.cut.length === 0) {
      p(`adaptMode=${params.adaptMode} 却一条线都没砍，说不过去`);
    }
    for (const [key, fields] of [['keep', ['what', 'why']], ['cut', ['what', 'why']], ['merge', ['what', 'why']], ['risks', ['what', 'plan']]]) {
      for (const item of ad[key] ?? []) {
        for (const f of fields) if (!thText(item?.[f])) p(`adaptation.${key} 里有条目缺 ${f}`);
      }
    }
    // 决策补注（可选）：给了就不能是空壳
    for (const f of ['cutNote', 'mergeNote']) {
      if (ad[f] !== undefined && !thText(ad[f])) p(`adaptation.${f} 给了但是空的——要么写结论，要么删掉这个键`);
    }
  }

  // --- characters 人物表 ---
  const chars = outline.characters;
  if (!Array.isArray(chars) || chars.length === 0) {
    p('characters 为空');
  } else {
    const tierCap = { lead: th.maxLeads, support: th.maxSupport, functional: th.maxFunctional };
    for (const tier of CHARACTER_TIERS) {
      const n = chars.filter((c) => c?.tier === tier).length;
      if (n > tierCap[tier]) p(`${TIER_LABELS[tier]} ${n} 位，超过上限 ${tierCap[tier]}`);
    }
    if (!chars.some((c) => c?.tier === 'lead')) p('没有主角组（tier=lead）角色');
    const seen = new Set();
    for (const c of chars) {
      const label = c?.name ?? c?.id ?? '(无名)';
      if (!/^C\d{2,}$/.test(c?.id ?? '')) p(`[${label}] 角色 id 必须是 C01 这种格式`);
      if (seen.has(c?.id)) p(`角色 id ${c.id} 重复`);
      seen.add(c?.id);
      if (!CHARACTER_TIERS.includes(c?.tier)) {
        p(`[${label}] tier 必须是 ${CHARACTER_TIERS.join('/')}（主角组/重要配角/功能性角色）`);
      }
      for (const f of ['name', 'role']) if (!thText(c?.[f])) p(`[${label}] 缺 ${f}`);
      // 功能性角色没有弧光是正常的——医生就是来缝针的
      if (c?.tier !== 'functional' && !thText(c?.arc)) p(`[${label}] 缺 arc（主角组和重要配角必须有人物弧）`);
      if (!Array.isArray(c?.from) || c.from.length === 0 || !c.from.every(thText)) {
        p(`[${label}] 缺 from（← 改动记录：原著对应谁、合并了谁）`);
      }
    }
  }

  // --- scenes ---
  const scenes = outline.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    p('scenes 为空');
  } else {
    const primaryN = scenes.filter((s) => s?.primary).length;
    if (primaryN > th.maxPrimaryScenes) p(`主场景 ${primaryN} 个，超过上限 ${th.maxPrimaryScenes}`);
    const seen = new Set();
    for (const s of scenes) {
      const label = s?.name ?? s?.id ?? '(无名)';
      if (!/^S\d{2,}$/.test(s?.id ?? '')) p(`[${label}] 场景 id 必须是 S01 这种格式`);
      if (seen.has(s?.id)) p(`场景 id ${s.id} 重复`);
      seen.add(s?.id);
      if (!thText(s?.name)) p(`[${s?.id}] 场景缺 name`);
      if (typeof s?.primary !== 'boolean') p(`[${label}] 场景缺 primary（是不是主场景）`);
    }
  }

  // --- props 叙事道具 ---
  // 可选字段：旧大纲没有 props 照常通过。写了就按结构查。
  if (Array.isArray(outline?.props)) {
    if (outline.props.length > th.maxProps) p(`叙事道具 ${outline.props.length} 件，超过上限 ${th.maxProps}`);
    const seenP = new Set();
    for (const pr of outline.props) {
      const label = pr?.name ?? pr?.id ?? '(无名)';
      if (!/^P\d{2,}$/.test(pr?.id ?? '')) p(`[${label}] 道具 id 必须是 P01 这种格式`);
      if (seenP.has(pr?.id)) p(`道具 id ${pr.id} 重复`);
      seenP.add(pr?.id);
      if (!thText(pr?.name)) p(`[${pr?.id}] 道具缺 name`);
      // function 是这一层唯一要拍板的东西：这件物件在戏里承载什么。
      // 填不出来说明它不是叙事道具，是场景陈设——那归 novel-art 的场景锚点管。
      if (!thText(pr?.function)) p(`[${label}] 道具缺 function（它在戏里承载什么；填不出来就不该进这张表）`);
      if (pr?.beatIds !== undefined && !Array.isArray(pr.beatIds)) p(`[${label}] beatIds 必须是数组`);
    }
  }

  if (stage === 'skeleton') return problems;

  // --- beats 爽点表 ---
  const beats = outline.beats;
  if (!Array.isArray(beats) || beats.length === 0) {
    p('beats 为空——爽点表是排片的骨架');
  } else {
    const seen = new Set();
    for (const b of beats) {
      const label = b?.id ?? '(无 id)';
      if (!/^B\d{2,}$/.test(b?.id ?? '')) p(`[${label}] 爽点 id 必须是 B01 这种格式`);
      if (seen.has(b?.id)) p(`爽点 id ${b.id} 重复`);
      seen.add(b?.id);
      if (!thText(b?.type)) p(`[${label}] 缺 type（打脸/揭破/反转……）`);
      if (b?.weight !== undefined && !BEAT_WEIGHTS.includes(b.weight)) p(`[${label}] weight 只能是 ${BEAT_WEIGHTS.join('/')}`);
      if (!Number.isInteger(b?.episode) || b.episode < 1) p(`[${label}] episode 必须是正整数`);
      for (const f of ['setup', 'payoff']) if (!thText(b?.[f])) p(`[${label}] 缺 ${f}`);
    }
    // 间隔与 major 时机在 beats 档就要卡住——这两条错了，分集写完全废
    for (const g of gateReport(outline)) {
      if ((g.id === 'beat-gap' || g.id === 'major-early') && !g.ok) {
        p(`质量门未过：${g.label}${g.detail ? `（${g.detail}）` : ''}`);
      }
    }
  }

  if (stage === 'beats') return problems;

  // --- episodes 分集梗概 ---
  const eps = outline.episodes;
  if (!Array.isArray(eps) || eps.length === 0) {
    p('episodes 为空');
  } else {
    if (params?.episodes && eps.length !== params.episodes) {
      p(`分集写了 ${eps.length} 集，params.episodes 说好 ${params.episodes} 集`);
    }
    eps.forEach((e, i) => {
      if (e?.ep !== i + 1) p(`第 ${i + 1} 个条目的 ep 是 ${e?.ep}，编号必须从 1 连续`);
      if (!Array.isArray(e?.sceneIds) || e.sceneIds.length === 0) p(`第 ${e?.ep} 集缺 sceneIds`);
      if (!Array.isArray(e?.characterIds) || e.characterIds.length === 0) p(`第 ${e?.ep} 集缺 characterIds`);
      if (e?.warnings !== undefined && !Array.isArray(e.warnings)) p(`第 ${e?.ep} 集 warnings 必须是数组`);
    });
    // 其余全部质量门（beats 档已报过的两条不再重复）
    for (const g of gateReport(outline)) {
      if (g.id === 'beat-gap' || g.id === 'major-early') continue;
      if (!g.ok) p(`质量门未过：${g.label}${g.detail ? `（${g.detail}）` : ''}`);
    }
  }

  return problems;
}

