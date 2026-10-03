export type ConceptPreview = {
  version: number;
  briefVersion: number;
  prompt: string;
  state: "draft" | "queued" | "succeeded";
};

export type DramaProjectPreview = {
  id: string;
  name: string;
  summary: string;
  genre: string;
  updated: string;
  briefs: string[];
  concepts: ConceptPreview[];
  selectedVersion: number | null;
  archived: boolean;
};

export function initialDramaProjects(): DramaProjectPreview[] {
  return [
    {
      id: "window-letter",
      name: "窗边的来信",
      summary: "一间旧茶室，一封迟到的信，一次与过去的重逢。",
      genre: "都市情感",
      updated: "刚刚编辑",
      briefs: [
        "一位年轻女子回到外婆留下的旧茶室，在窗边的茶壶下发现一封十年前的信。她决定寻找收信人。故事带一点悬疑，整体采用冷色调。",
        "一位年轻女子回到外婆留下的旧茶室，在窗边的茶壶下发现一封迟到十年的信。故事偏都市情感，温暖、安静、克制。画面以柔和窗光、木质桌面与素色陶器为主，弱化悬疑，让人物在日常物件中与过去重逢。",
      ],
      concepts: [
        {
          version: 1,
          briefVersion: 1,
          prompt:
            "旧茶室，木质桌面上一只素色陶制茶壶，雨天窗光，略带冷意，写实电影质感。",
          state: "succeeded",
        },
        {
          version: 2,
          briefVersion: 2,
          prompt:
            "午后的旧茶室，素色陶制茶壶静置在木质桌面上，旁边是一枝绿叶和玻璃花瓶。柔和的窗光，温暖、安静、克制的电影质感。保留自然材质与生活的痕迹。",
          state: "succeeded",
        },
      ],
      selectedVersion: 2,
      archived: false,
    },
    {
      id: "mountain-map",
      name: "山海旧事",
      summary: "少年在旧地图上发现一座不存在的城。",
      genre: "东方奇幻",
      updated: "昨天编辑",
      briefs: [
        "山村少年在祖父留下的旧地图上发现一座不存在的城。整体偏东方奇幻，画面采用山雾、旧纸与青绿色。",
      ],
      concepts: [],
      selectedVersion: null,
      archived: false,
    },
    {
      id: "last-bus",
      name: "最后一班车",
      summary: "夜班司机与一位不愿说出目的地的乘客。",
      genre: "城市故事",
      updated: "3 天前编辑",
      briefs: [
        "一位夜班司机载着一名不愿说出目的地的乘客穿过城市。故事安静，偶有幽默。用城市夜景表现人物从疏离到理解的变化。",
      ],
      concepts: [
        {
          version: 1,
          briefVersion: 1,
          prompt:
            "夜班公交车，城市窗光，安静的车厢。电影质感，克制的蓝色与暖色灯光。",
          state: "queued",
        },
      ],
      selectedVersion: null,
      archived: false,
    },
  ];
}
