/**
 * 解包结果清单（manifest.json）的类型定义
 * 播放器读取同一份清单来决定加载什么、怎么播。
 */

export interface ManifestSourceInfo {
  lpk: string;
  lpkBytes: number;
  entryCount: number;
  configFile: string | null;
  mlveEntry: string;
}

export interface ManifestPackageInfo {
  title: string | null;
  author: string | null;
  description: string | null;
  fileId: string | null;
  metaData: string | null;
  mlveType: string;
  mlveId: string | null;
  mlveName: string | null;
  preview: string | null;
  /** 未被任何角色引用的条目（依旧完整导出，不丢资源） */
  unassigned: string[];
}

export interface ManifestAnimationInfo {
  name: string;
  loop: boolean;
  label: string | null;
  /** 骨架里是否真的存在这个动画（配置里可能引用了不存在的动作） */
  available: boolean;
}

export interface ManifestInteractionInfo {
  group: string;
  groupLabel: string;
  /** 动作在组内的名字（Live2DViewerEX 的 name，start_mtn 用 "组:名字" 定位它） */
  name: string;
  label: string;
  /** 骨架里的动画名；纯命令/纯语音的动作没有动画，这里是 null */
  animation: string | null;
  sound: string | null;
  loop: boolean;
  priority: number | null;
  /** Live2DViewerEX 的指令，如 "start_mtn switch:title;slot_opacities lock BS_1,BS_2 0" */
  command: string | null;
  /** 选择支：选中后跳到 next（"组:名字"） */
  choices: { text: string | null; next: string | null; sound: string | null }[] | null;
  /** 淡入时长（毫秒，原版字段 fade_in） */
  fadeInMs: number | null;
  text: string | null;
  next: string | null;
  textDurationMs: number | null;
  /**
   * 变量指令（原版的 var_floats）：type 1 = 条件，type 2 = 赋值。
   * 同一组里的同名动作靠它区分（例如 pi=0 用 Stand、pi=1 用 Stand_s01）。
   */
  varFloats: unknown[] | null;
}

export interface ManifestSoundInfo {
  path: string;
  entry: string;
  label: string | null;
  text: string | null;
}

export interface ManifestHitAreaInfo {
  name: string;
  bone: string;
  width: number;
  height: number;
  motion: string | null;
}

export interface ManifestTexturePage {
  /** 图集文本里引用的页名（重名改写过的话是改写后的名字） */
  name: string;
  /**
   * 包内相对路径；**null 表示解包时没能定位到这张贴图的条目**
   * （包结构异常，例如图集声明的页在整包里都没有对应条目）。
   * 播放器遇到 null 会按页名在角色的 `textures[]` 里回退查找 —— 这比写一个不存在的路径好，
   * 后者只会让播放器报「图片加载失败」，看起来像解包漏了文件。
   */
  path: string | null;
}

export interface ManifestTextureSet {
  atlas: string;
  atlasName: string;
  pages: ManifestTexturePage[];
}

export interface ManifestCharacterBase {
  id: string;
  dir: string;
  title: string;
  /** 解包过程中发现的、与原包不一致的地方 */
  warnings: string[];
  /** config.mlve 中 avatar 指向的头像图（包内相对路径） */
  avatarPath: string | null;
  /**
   * 包自己声明的贴图编码类型（模型配置的 `options.tex_type`，没有则为 null）。
   * 用途：alpha 混合方式的**先验** —— 实测 3572004785/Fazheng02 的贴图是预乘编码，
   * 但按像素统计只"略超 1%"，会被判成直通 alpha，画面表现为脸和胸口的一层灰色残影。
   * 播放器在统计落到灰色地带时按这个字段取值，见 web/player.js 的 detectPremultiplied。
   */
  texType: number | null;
  /**
   * 条目名（LPK 里的哈希名）→ 包内相对路径。
   * 解包器不改写任何资源内容，配置里的哈希引用由播放器按这张表在内存里映射。
   */
  refs: Record<string, string>;
  source: {
    modelEntry: string;
    costumePath: string | null;
    character: string | null;
    avatar: string | null;
    skeletonEntry: string;
    atlasEntry: string;
    textureEntries: string[];
    soundEntries: string[];
  };
}

/** Live2D Cubism（moc3 + model3.json）包里的一个动作 */
export interface ManifestCubismMotion {
  group: string;
  label: string | null;
  /** 包内相对路径；纯命令动作没有动作文件，这里是 null */
  file: string | null;
  sound: string | null;
  loop: boolean;
  /** 动作/语音对应的原始条目名（播放器改写 model3.json 时用） */
  fileEntry: string | null;
  soundEntry: string | null;
  /**
   * Live2DViewerEX 的 "Command"：没有动作文件，只改模型参数，
   * 例如 "parameters lock Param49 1"（脱/穿衣服这类开关就是靠它实现的）
   */
  command?: string | null;
  /** 命令执行后再执行的命令（例如"充钱"是 Command 设一档、PostCommand 设下一档） */
  postCommand?: string | null;
  /** 命令执行完后接着播的动作组 */
  nextMotion?: string | null;
  /** "选择"类型的动作：弹出选项，选了之后跳到 NextMtn 指定的动作组 */
  choices?: { text: string | null; next: string | null }[] | null;
  /** 命令动作自带的对白（没有语音文件） */
  text?: string | null;
  /** 对白停留时长（毫秒）；后置命令 PostCommand 也等这么久再执行（原版行为） */
  textDurationMs?: number | null;
  /** 变量指令（VarFloats）：type 1 = 条件，type 2 = 赋值 */
  varFloats?: unknown[] | null;
}

/** Spine 模型（当前 LPK 里的主流格式） */
export interface ManifestSpineCharacter extends ManifestCharacterBase {
  kind?: 'spine';
  spineVersion: string;
  /** 骨架格式：json（SkeletonJson）或 binary（SkeletonBinary） */
  skeletonFormat: 'json' | 'binary';
  skeleton: string;
  skeletonName: string;
  atlas: string;
  atlasName: string;
  textures: string[];
  /** 全部贴图套（一个图集一套；Live2DViewerEX 用它切换服装/和谐版），第一套是默认 */
  textureSets: ManifestTextureSet[];
  modelConfig: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /**
   * 包里指定的模型摆放位置（live2dex.model.json 的 options.position_x / position_y）。
   *
   * 是**模型局部坐标**里的偏移：播放器把它加在骨架自身 bounds 的中心上，
   * 模型才会出现在原版所在的位置。缺了它，带偏移的包（例如 kansasi_2 的 y = -17.9）
   * 会被画偏 —— 表现为"人物缺了一块"以及可触发区域红框与角色对不上。
   */
  positionX: number;
  positionY: number;
  animations: ManifestAnimationInfo[];
  interactions: ManifestInteractionInfo[];
  sounds: ManifestSoundInfo[];
  hitAreas: ManifestHitAreaInfo[];
}

/** Live2D Cubism 模型（moc3 + model3.json + textures + motions） */
export interface ManifestCubismCharacter extends ManifestCharacterBase {
  kind: 'cubism';
  model3: string;
  model3Name: string;
  moc3: string;
  textures: string[];
  motions: ManifestCubismMotion[];
  expressions: string[];
  physics: string | null;
  pose: string | null;
  displayInfo: string | null;
  sounds: ManifestSoundInfo[];
  hitAreas: ManifestHitAreaInfo[];
  groups: unknown[];
}

export type ManifestCharacter = ManifestSpineCharacter | ManifestCubismCharacter;

export interface ManifestEntryInfo {
  name: string;
  kind: string;
  size: number;
  encrypted: boolean;
  output: string | null;
}

export interface Manifest {
  schema: number;
  generatedAt: string;
  tool: string;
  source: ManifestSourceInfo;
  package: ManifestPackageInfo;
  characters: ManifestCharacter[];
  entries: ManifestEntryInfo[];
}
