// Apache-2.0: shuohao-skills novel-script, revision ef4ac0c313c7eeb1f918db5f0f0eb319745900bc.
// Verbatim pure timing, statistics and validation functions. I/O, CLI, seed and render omitted.
export const DEFAULT_PARAMS = {
  charsPerSecond: 4.5, // 中文口语偏快档
  actionSeconds: 2.5,  // 每个动作节拍的估时
  tolerance: 0.15,     // 时长容差 ±15%
  maxLineChars: 35,    // 单句台词上限——一口气说不完的台词也生成不了
  hookWindow: 3,       // 开场钩子必须在全集前几拍内兑现——短剧开场 3 秒定生死
};

export function paramsOf(doc) {
  return { ...DEFAULT_PARAMS, ...(doc?.params ?? {}) };
}

/** 台词计秒用的字符数：去空白，标点算时间（停顿也是时间）。 */
export const lineChars = (line) => String(line ?? '').replace(/\s+/g, '').length;

const r1 = (n) => Math.round(n * 10) / 10;

/** 一场戏的估秒。flow 里台词按语速折算，动作节拍按固定秒数。 */
export function sceneSeconds(scene, params = DEFAULT_PARAMS) {
  let dlg = 0;
  let act = 0;
  for (const b of scene?.flow ?? []) {
    if (typeof b?.line === 'string') dlg += lineChars(b.line) / params.charsPerSecond;
    else if (typeof b?.action === 'string') act += params.actionSeconds;
  }
  return { dialogue: r1(dlg), action: r1(act), total: r1(dlg + act) };
}

/* ------------------------------------------------------------------ */
/* stats — 报告与质量门共用的确定性统计                                   */
/* ------------------------------------------------------------------ */

export function computeStats(doc) {
  const params = paramsOf(doc);
  const episodes = [];
  const sceneTable = [];
  const byCharacter = new Map(); // C01 → { lines: [...], chars }

  for (const ep of doc?.episodes ?? []) {
    let dlg = 0;
    let act = 0;
    let lines = 0;
    (ep?.scenes ?? []).forEach((sc, idx) => {
      const sec = sceneSeconds(sc, params);
      dlg += sec.dialogue;
      act += sec.action;
      let lineCount = 0;
      for (const b of sc?.flow ?? []) {
        if (typeof b?.line !== 'string') continue;
        lineCount++;
        lines++;
        const key = b.speaker ?? '?';
        if (!byCharacter.has(key)) byCharacter.set(key, { lines: [], chars: 0 });
        const entry = byCharacter.get(key);
        entry.lines.push({ ep: ep.ep, sceneIndex: idx + 1, sceneId: sc.sceneId, line: b.line, delivery: b.delivery ?? '' });
        entry.chars += lineChars(b.line);
      }
      sceneTable.push({
        ep: ep.ep, index: idx + 1, sceneId: sc.sceneId, lighting: sc.lighting ?? '',
        characters: sc.characters ?? [], props: sc.props ?? [],
        lineCount, estSeconds: sec.total,
      });
    });
    episodes.push({
      ep: ep.ep,
      target: ep.targetSeconds,
      est: r1(dlg + act),
      dialogueSeconds: r1(dlg),
      actionSeconds: r1(act),
      lines,
      sceneCount: (ep?.scenes ?? []).length,
    });
  }

  const totals = {
    episodes: episodes.length,
    scenes: sceneTable.length,
    lines: episodes.reduce((n, e) => n + e.lines, 0),
    estSeconds: r1(episodes.reduce((n, e) => n + e.est, 0)),
    targetSeconds: episodes.reduce((n, e) => n + (e.target ?? 0), 0),
    dialogueSeconds: r1(episodes.reduce((n, e) => n + e.dialogueSeconds, 0)),
  };

  const castLines = [...byCharacter.entries()]
    .map(([id, v]) => ({ id, count: v.lines.length, chars: v.chars, lines: v.lines }))
    .sort((a, b) => b.count - a.count);

  return { params, episodes, sceneTable, castLines, totals };
}

/* ------------------------------------------------------------------ */
/* 质量门                                                               */
/* ------------------------------------------------------------------ */
/*
 * 与仓库里其他 skill 同一主张：checklist 是代码，不是给模型读的文字。
 * 需要上游对账的门（角色 / 场景与光照 / 爽点认领）在没给上游文件时
 * 明说跳过——静默通过和撒谎只差一步。
 */

const thText = (s) => typeof s === 'string' && s.trim();
/** 动作描述必须是叙述体——台词只能进 dialogue 字段，混进 action 就没法计秒。 */
const QUOTE_RE = /「|」|『|』|“|”/;

export function gateReport(doc, ctx = {}) {
  const gates = [];
  const add = (id, label, ok, detail = '') => gates.push({ id, label, ok, detail });
  const eps = Array.isArray(doc?.episodes) ? doc.episodes : [];
  const params = paramsOf(doc);
  const stats = computeStats(doc);
  const bad = { duration: [], lineLen: [], speaker: [], hook: [], hookOpen: [], noAction: [], prose: [], beats: [], chars: [], scenes: [] };

  for (const [i, ep] of eps.entries()) {
    const st = stats.episodes[i];
    const label = `第 ${ep?.ep} 集`;

    // 时长预算：写超写欠都在这层拦，别流到生成环节才发现
    if (ep?.targetSeconds > 0) {
      const lo = ep.targetSeconds * (1 - params.tolerance);
      const hi = ep.targetSeconds * (1 + params.tolerance);
      if (st.est < lo) bad.duration.push(`${label}欠 ${r1(lo - st.est)} 秒（估 ${st.est}s / 目标 ${ep.targetSeconds}s）`);
      if (st.est > hi) bad.duration.push(`${label}超 ${r1(st.est - hi)} 秒（估 ${st.est}s / 目标 ${ep.targetSeconds}s）`);
    }

    // 开场钩子与结尾悬念：说明必须落在纸面
    if (!thText(ep?.hook) || !thText(ep?.cliff)) bad.hook.push(label);

    // 钩子不是标签是第一拍：hookBeat 认领具象落在哪一拍，必须在全集前几拍内。
    // 只有说明没有认领，就会出现「钩子说皮箱、开场拍了八拍雾」的衔接断裂
    {
      const hb = ep?.hookBeat;
      if (!Array.isArray(hb) || hb.length !== 2 || !Number.isInteger(hb[0]) || !Number.isInteger(hb[1])) {
        bad.hookOpen.push(`${label}缺 hookBeat（[场, 拍]，认领钩子具象的位置）`);
      } else {
        const scene = ep?.scenes?.[hb[0] - 1];
        if (!scene || hb[1] < 1 || hb[1] > (scene.flow ?? []).length) {
          bad.hookOpen.push(`${label}的 hookBeat [${hb[0]}, ${hb[1]}] 指向不存在的节拍`);
        } else {
          let pos = hb[1];
          for (let i = 0; i < hb[0] - 1; i++) pos += (ep.scenes[i]?.flow ?? []).length;
          if (pos > params.hookWindow) {
            bad.hookOpen.push(`${label}的钩子落在全集第 ${pos} 拍，超出前 ${params.hookWindow} 拍——冷开场先给钩子的具象`);
          }
        }
      }
    }

    for (const sc of ep?.scenes ?? []) {
      const cast = new Set(sc?.characters ?? []);
      let hasAction = false;
      for (const b of sc?.flow ?? []) {
        if (typeof b?.action === 'string') {
          hasAction = true;
          if (QUOTE_RE.test(b.action)) bad.prose.push(`${label} ${sc?.sceneId ?? '?'}`);
        }
        if (typeof b?.line === 'string') {
          if (lineChars(b.line) > params.maxLineChars) {
            bad.lineLen.push(`${label}「${b.line.slice(0, 12)}…」${lineChars(b.line)} 字`);
          }
          if (b.speaker !== 'VO' && !cast.has(b.speaker)) {
            bad.speaker.push(`${label} ${sc?.sceneId ?? '?'} 的「${b.speaker}」不在本场人物里`);
          }
        }
      }
      // 纯对白无动作的场 = 广播剧，生成时没有画面可写
      if ((sc?.flow ?? []).length > 0 && !hasAction) bad.noAction.push(`${label} ${sc?.sceneId ?? '?'}`);
    }
  }

  // ---- 需要上游对账的门 ----
  const outline = ctx.outline ?? null;
  const art = ctx.art ?? null;

  if (outline) {
    const charIds = new Set((outline.characters ?? []).map((c) => c.id));
    for (const ep of eps) {
      for (const sc of ep?.scenes ?? []) {
        for (const id of sc?.characters ?? []) {
          if (!charIds.has(id)) bad.chars.push(`第 ${ep.ep} 集 ${sc.sceneId ?? '?'} 的 ${id}`);
        }
      }
      // 爽点认领：大纲说这一集有的爆点，剧本必须认领
      const due = [...new Set((outline.beats ?? []).filter((b) => b.episode === ep.ep).map((b) => b.type))];
      const claimed = new Set(ep?.beatsClaimed ?? []);
      for (const t of due) if (!claimed.has(t)) bad.beats.push(`第 ${ep.ep} 集缺「${t}」`);
    }
  }

  if (art) {
    const sceneMap = new Map((art.scenes ?? []).map((s) => [s.id, s]));
    const propIds = new Set((art.props ?? []).map((p) => p.id));
    for (const ep of eps) {
      for (const sc of ep?.scenes ?? []) {
        const ref = sceneMap.get(sc?.sceneId);
        if (!ref) {
          bad.scenes.push(`第 ${ep.ep} 集引用了不存在的场景 ${sc?.sceneId}`);
        } else if (thText(sc?.lighting) && !(ref.lighting ?? []).some((l) => l.state === sc.lighting)) {
          bad.scenes.push(`第 ${ep.ep} 集 ${sc.sceneId} 的光照「${sc.lighting}」没在美术设定里登记`);
        }
        for (const pid of sc?.props ?? []) {
          if (!propIds.has(pid)) bad.scenes.push(`第 ${ep.ep} 集引用了不存在的道具 ${pid}`);
        }
      }
    }
  }

  const SKIP_OUTLINE = '未提供 outline.json，本门跳过（视为通过）';
  const SKIP_ART = '未提供 art.json，本门跳过（视为通过）';

  add('duration', `每集时长在目标 ±${Math.round(params.tolerance * 100)}% 内`, eps.length > 0 && bad.duration.length === 0, bad.duration.join('；'));
  add('line-length', `单句台词 ≤ ${params.maxLineChars} 字`, bad.lineLen.length === 0, bad.lineLen.join('；'));
  add('speaker', '说话人在本场人物里，或明确标画外音 VO', bad.speaker.length === 0, bad.speaker.join('；'));
  add('hook-cliff', '每集开场钩子与结尾悬念都落在纸面', eps.length > 0 && bad.hook.length === 0, bad.hook.join('；'));
  add('hook-open', `钩子的具象在全集前 ${params.hookWindow} 拍内兑现（hookBeat 认领）`, eps.length > 0 && bad.hookOpen.length === 0, bad.hookOpen.join('；'));
  add('has-action', '每场至少一个动作节拍——纯对白的场是广播剧', eps.length > 0 && bad.noAction.length === 0, bad.noAction.join('；'));
  add('action-prose', '动作描述叙述体，台词只进 dialogue 字段', bad.prose.length === 0, bad.prose.join('；'));
  add('beats-claimed', '大纲爽点逐集认领', bad.beats.length === 0, outline ? bad.beats.join('；') : SKIP_OUTLINE);
  add('refs-characters', '角色引用对账大纲', bad.chars.length === 0, outline ? bad.chars.join('；') : SKIP_OUTLINE);
  add('refs-scenes', '场景／光照／道具对账美术设定', bad.scenes.length === 0, art ? bad.scenes.join('；') : SKIP_ART);

  return gates;
}

/* ------------------------------------------------------------------ */
/* validate                                                            */
/* ------------------------------------------------------------------ */

export function validateScript(doc, ctx = {}) {
  const problems = [];
  const p = (msg) => problems.push(msg);
  if (!doc || typeof doc !== 'object') return ['script.json 不是对象'];

  if (!thText(doc.source)) p('缺少 source（剧名/书名）');
  const eps = doc.episodes;
  if (!Array.isArray(eps) || eps.length === 0) {
    p('episodes 为空');
    return problems;
  }

  const seen = new Set();
  for (const ep of eps) {
    const label = `第 ${ep?.ep ?? '?'} 集`;
    if (!Number.isInteger(ep?.ep) || ep.ep < 1) p(`${label}的 ep 必须是正整数`);
    if (seen.has(ep?.ep)) p(`集号 ${ep.ep} 重复`);
    seen.add(ep?.ep);
    if (!(ep?.targetSeconds > 0)) p(`${label}缺 targetSeconds（目标秒数，来自大纲的单集时长）`);
    if (!Array.isArray(ep?.beatsClaimed)) p(`${label}缺 beatsClaimed（认领的爽点，可为空数组）`);
    if (!Array.isArray(ep?.scenes) || ep.scenes.length === 0) {
      p(`${label}没有场次`);
      continue;
    }
    ep.scenes.forEach((sc, i) => {
      const sLabel = `${label}第 ${i + 1} 场`;
      if (!/^S\d{2,}$/.test(sc?.sceneId ?? '')) p(`${sLabel} sceneId 必须是 S01 这种格式`);
      if (!Array.isArray(sc?.characters)) p(`${sLabel}缺 characters（本场人物，空镜给空数组）`);
      if (!Array.isArray(sc?.flow) || sc.flow.length === 0) p(`${sLabel}的节拍流为空`);
      for (const b of sc?.flow ?? []) {
        const isAction = typeof b?.action === 'string';
        const isLine = typeof b?.line === 'string';
        if (isAction === isLine) {
          p(`${sLabel}有节拍既不是动作也不是台词（action 与 line 二选一）`);
          continue;
        }
        if (isAction && !b.action.trim()) p(`${sLabel}有空动作节拍`);
        if (isLine) {
          if (!b.line.trim()) p(`${sLabel}有空台词`);
          if (!thText(b.speaker)) p(`${sLabel}有台词缺 speaker`);
        }
      }
    });
  }

  for (const g of gateReport(doc, ctx)) {
    if (!g.ok) p(`质量门未过：${g.label}${g.detail ? `（${g.detail}）` : ''}`);
  }
  return problems;
}

