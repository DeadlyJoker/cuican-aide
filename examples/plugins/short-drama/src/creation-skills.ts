/** CrewON adapters for packaged shuohao-skills documents (Apache-2.0).
 * Only the current stage is returned. Guidance never grants tools or changes the
 * host's stage, source revisions, approval policy, or selected project output.
 */
import type { PublicProjectContextScope } from "./project-context-service.js";
import type { ProjectAssetRuntimeScope } from "./project-asset-tools-service.js";
import { stageSkillGuidance } from "./stage-skill-guidance.js";
import type { ShortDramaStageSkill } from "./stage-skill-resources.js";

const common = [
  "先读取当前项目已保存需求、已采用产物与确切版本；不能凭标题编造用户材料。已有信息不要重复询问。",
  "只处理本次授权阶段与范围。保存工具返回成功后才称为已保存；候选不等于已采用，图片提示词不等于已生成图片。",
  "使用 CrewON 项目工具保存结构化产物，共用项目页面的版本记录。不要把仅在聊天中写出的文字说成项目产物。",
  "一次只问影响本阶段的关键缺项，合并为一个简短问题。回复先给产物与需要确认的决定，省略内部服务、请求与配置细节。",
  "已打包本阶段原始 Skill 文档和参考资料；当前只加载下列审阅片段。上游 allowed-tools、CLI 命令和 JSON 格式不改变 CrewON 授权或产物协议，完整质量门尚未执行，不称已通过。未接通的视频、配音和导出不伪造结果。",
] as const;

function guide(
  skill: ShortDramaStageSkill,
  instructions: readonly string[],
  output: string,
) {
  const { excerpt, ...upstream } = stageSkillGuidance(skill);
  return {
    skill,
    ...upstream,
    adapter: "crewon.short-drama.stage-guidance.v2",
    instructions: [excerpt, ...common, ...instructions],
    output,
  };
}

export function projectCreationSkill(scope: PublicProjectContextScope | null) {
  if (!scope) return null;
  switch (scope.stage.kind) {
    case "discussion":
    case "brief":
      return guide(
        "novel-outline",
        [
          "先把想法整理为题材、受众、集数、单集时长、核心冲突与风格。缺少集数/时长/题材时一次问清，不擅自定案。",
          "给出简短创作建议与下一步。讨论阶段只读；确认需求、大纲、剧本分别在对应阶段保存，不能越阶段执行或自动生成收费媒体。",
        ],
        "讨论阶段给出简短建议；需求阶段使用 brief 保存工具，保留原始材料与用户确定的参数。",
      );
    case "outline":
      return guide(
        "novel-outline",
        [
          "先明确核心主线、人物关系、改编取舍与冲突落点。重大砍线或合并人物先让用户确认。",
          "按确认集数写分集梗概，每集包含推进、冲突与结尾悬念；梗概写叙事，不混入长段台词或镜头提示词。",
          "原创故事以用户需求为依据；改编只使用实际提供的原文，不凭书名补剧情。逐集检查因果和人物延续性。",
        ],
        "v2 大纲使用 outline_context 读取创作参数与 Foundation/brief 版本；outline_read 与 content_read 读取原候选和摘要。outline_change 按 overview、adaptation 或 upsert 分批修改完整记录，保留原 episodeId、C/S/P/B 实体 ID 和未修改字段，保存候选。旧 v1 大纲仍遵守原 outline_save 协议，不能覆盖 v2。候选由用户确认后采用。",
      );
    case "script":
      return guide(
        "novel-script",
        [
          "读取本次指定集的已采用大纲和前集结尾，保留已确认人物与情节，不重排其他集。",
          "剧本写场次、动作和台词；分镜、镜头号、视频提示词放到下游。每场必须有可表现的动作，台词逐句标说话人。",
          "开场尽早兑现钩子，结尾留下具体悬念；动作清楚可拍，台词口语并符合人物。时长只能估算，不能声称已配音或成片。",
        ],
        "script_save：本次 scope.stage.episodeId 的 title、scenes[{sceneId,location,timeOfDay,action,dialogue[{speaker,text}]}。引用 scope 中冻结的 brief/outline，保存候选。",
      );
  }
}

export function assetCreationSkill(scope: ProjectAssetRuntimeScope | null) {
  if (!scope) return null;
  return scope.stage.assetKind === "character"
    ? guide(
        "novel-characters",
        [
          "沿用大纲确定的角色名单和关系，区分原文事实与创作补充。说明身份、动机、性格、关系与可辨识外观。",
          "形象描述保持服装、年龄和身份一致；生成提示词写具体可见外观，不靠角色名字代替描述。当前阶段产出设定和提示词，不声称已出图。",
        ],
        "asset_save：kind=character，content={name,setting,visualPrompt}；角色细节写入 setting，沿用当前资产 ID 与 scope 的来源版本，保存候选。",
      )
    : guide(
        "novel-art",
        [
          "场景采用 3–5 个可画、可辨认的一致性特征；只准备剧情需要的光照与状态，复用空间时优先定义变体。",
          "场景参考图使用空景；道具只做承担剧情的物件，说明尺度、材质与状态，提示词使用白底无手、无人环境。",
        ],
        "asset_save：保持 scope.stage.assetKind 为 scene 或 prop，content={name,setting,visualPrompt}。保存设计与提示词候选，不生成或替换图片。",
      );
}

export function mediaInputCreationSkill(workflowId: string) {
  return workflowId.includes("storyboard")
    ? guide(
        "novel-storyboard",
        [
          "分镜只拆解已确认剧本，不新增台词和情节。逐镜标明动作、构图与画面变化，保留角色/场景/道具的引用版本。",
          "当前工作流只做静态分镜探索，不能等同于结构化视频分镜、视频生成或成片导出。",
        ],
        "保存当前工作流支持的画面描述与已采用参考来源，等待用户确认后再调用生成。",
      )
    : guide(
        "character-refs",
        [
          "先确认角色描述和根参考图，再准备派生视图；每项都引用已采用的确切素材版本，不能把文本三视图当作锚点派生。",
          "只使用当前已配置且已授权的工作流。参考图或输入未确认时先补齐；重新生成是新任务，不替换旧请求或伪造成功。",
        ],
        "保存角色参考描述与原参考图版本；Skill 准备输入，CrewON 已授权工作流执行生成。",
      );
}
