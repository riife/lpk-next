/**
 * Live2D Cubism 播放器
 *
 * 渲染栈：官方 Live2D Cubism Core + PIXI v6 + pixi-live2d-display（都存在 web/vendor，按需加载）。
 *
 * 关键点：解包出来的 model3.json 里存的是 LPK 的哈希条目名（我们不修改资源），
 * 所以这里在**内存里**把 FileReferences 的每个引用换成解包文件的真实 URL，再交给框架加载。
 */
/* global PIXI, Live2DCubismCore */

const RUNTIME_FILES = [
  '/vendor/pixi-6.5.10.min.js',
  '/vendor/live2dcubismcore.min.js',
  '/vendor/pixi-live2d-display-0.4.0.cubism4.min.js',
];

/** pixi 的 MotionPriority：NONE=0 IDLE=1 NORMAL=2 FORCE=3（起播时必须显式给，undefined 会被当成 0 拒绝） */
const MOTION_PRIORITY_NORMAL = 2;
const MOTION_PRIORITY_IDLE = 1;
const MOTION_PRIORITY_FORCE = 3;

/**
 * 命令串里的"开关类"动词（Live2DViewerEX 的全集，统计过 35 个包）：
 *   hit_areas / motions / param_hit / param_loop / mouse_tracking / change_cos
 * 它们不带参数值，只切换某个交互的启用状态，交给 applyToggleCommand 处理。
 */
const TOGGLE_VERBS = new Set(['hit_areas', 'motions', 'param_hit', 'param_loop', 'mouse_tracking', 'change_cos']);

/* TODO(review): 本文件里的时长/帧数/阈值（淡入毫秒、呼吸周期、重试帧数、拖拽阈值…）还没有做过
   命名待整理：后续统一提成具名常量（先只加注释，不改行为）。 */

const clamp = (value: any, min: any, max: any) => (value < min ? min : value > max ? max : value);

let runtimePromise: Promise<any> | null = null;

function loadScript(src: any) {
  return new Promise((resolve: any, reject: any) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`运行时脚本加载失败：${src}`));
    document.head.append(script);
  });
}

/** 按需加载 Cubism 渲染栈（Cubism Core 必须在 pixi-live2d-display 之前） */
export function ensureCubismRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (!window.PIXI) await loadScript(RUNTIME_FILES[0]);
      if (!window.Live2DCubismCore) await loadScript(RUNTIME_FILES[1]);
      if (!window.PIXI?.live2d) await loadScript(RUNTIME_FILES[2]);
      if (!window.PIXI?.live2d?.Live2DModel) throw new Error('pixi-live2d-display 未能注册 Live2DModel');
      // pixi-live2d-display 默认 config.sound = true，会用它自己的 SoundManager 播动作语音。
      // 那和播放器的 playSound 是两套音频，切换动作时我们停不掉它，听起来就是"旧声音和新声音一起响"。
      // 统一交给我们自己播（也能在换角色/换动作时干净地掐掉）。
      if (window.PIXI.live2d.config) {
        const config = window.PIXI.live2d.config;
        config.sound = false;
        // motionSync 会让"开始动作"先等音频就绪（本地单机播放不需要），也会让动作看起来慢半拍
        config.motionSync = false;
        /**
         * 交叉淡化时长。
         *
         * 待机/走路这类动作在包里是 `Loop: true`，框架自己会把时间绕回来无缝循环 ——
         * 只要不被"重新起播"，循环点本来就不需要任何淡入淡出。
         * 框架默认给待机 2 秒淡入（包里没写 FadeInTime），一旦动作被重新起播，
         * 旧姿势就要花两秒淡出去，表现就是"抬起的腿迟迟不落、走路像在等"。
         * 所以：循环动作用 0 秒（无缝），一次性动作给一个很短的过渡（0.2 秒）。
         */
        config.idleMotionFadingDuration = 0;
        config.motionFadingDuration = 200;
      }
      return { PIXI: window.PIXI, Live2DModel: window.PIXI.live2d.Live2DModel };
    })();
  }
  return runtimePromise;
}

export class CubismPlayer {
  /* 字段声明：迁移时按 tsc 的 TS2339 报错逐条补出，类型暂为 any（后续按模块收紧） */
  view: any;

  /* 字段声明：迁移时从构造函数里的 this.x 赋值推导，类型暂为 any（后续按模块收紧） */
  app: any;
  artmeshOpacity: any;
  breath: any;
  breathValue: any;
  canvas: any;
  controllers: any;
  currentMotion: any;
  debugWriteTrace: any;
  disabledMotionGroups: any;
  disabledParamHits: any;
  disabledParamLoops: any;
  drag: any;
  elapsedMs: any;
  entranceMotion: any;
  entranceTries: any;
  focusTarget: any;
  groups: any;
  hitAreasEnabled: any;
  idleMotion: any;
  intimacy: any;
  keyTriggers: any;
  lastDelta: any;
  lastWrittenIds: any;
  lipSyncLevel: any;
  lockedParameters: any;
  loopElapsed: any;
  model: any;
  motionIndex: any;
  motionPending: any;
  mouseTracking: any;
  paramHitValues: any;
  paramLoops: any;
  paramTriggerFired: any;
  paramTriggers: any;
  parameterValues: any;
  partOpacity: any;
  pendingCostume: any;
  pendingFrames: any;
  pendingSound: any;
  pendingTriggers: any;
  postCommandTimer: any;
  preloadMotion: any;
  releases: any;
  settings: any;
  smoothedFocus: any;
  trackingEnabled: any;
  trackingGain: any;
  variableOf: any;
  wanted: any;

  constructor(canvas: any) {
    this.canvas = canvas;
    this.app = null;
    this.model = null;
    this.view = { scale: 1, offsetX: 0, offsetY: 0 };
    this.currentMotion = null;
    /** 固定的待机动作（不轮换），由 setIdleMotion 指定 */
    this.idleMotion = null;
    /** 刚请求过动作、等框架确认（确认前不要抢着回待机） */
    this.motionPending = false;
    /** 读取变量值的回调（命令里的 `$名字` 用），由 app.js 设置 */
    this.variableOf = null;
    /* 包里的开关类命令（hit_areas / motions / param_hit / param_loop …）改的就是这些状态 */
    this.hitAreasEnabled = true;
    this.disabledMotionGroups = new Set();
    this.disabledParamHits = new Set();
    this.disabledParamLoops = new Set();
    this.pendingCostume = null;
    this.lockedParameters = new Map();
    this.parameterValues = new Map();
    this.paramHitValues = new Map();
    this.drag = null;
    /** 松手后的缓回队列（Release / ReleaseType） */
    this.releases = new Map();
    this.postCommandTimer = null;
    this.lastDelta = 1 / 60;
    this.controllers = {};
    this.mouseTracking = null;
    this.focusTarget = null;
    this.smoothedFocus = { x: 0, y: 0 };
    this.trackingEnabled = true;
    this.trackingGain = 0.5;
    this.motionIndex = new Map(); // "group#列表下标" → { group, groupIndex, label, sound, loop, command, choices }
  }

  /* ---------------------------------------------------------------- *
   * 加载
   * ---------------------------------------------------------------- */

  /**
   * 同一块 canvas 上只能创建一次 PIXI.Application（destroy 之后 WebGL 上下文不能复用，
   * 再次创建会报 checkMaxIfStatementsInShader 错误），所以这里缓存 app，只换模型。
   */
  ensureApp(PIXI: any) {
    if (this.app) return this.app;
    this.app = new PIXI.Application({
      view: this.canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      width: Math.max(1, this.canvas.clientWidth),
      height: Math.max(1, this.canvas.clientHeight),
    });
    return this.app;
  }

  /**
   * @param {object} character manifest 里的 Cubism 角色
   * @param {{text:(p:string)=>Promise<string>, resolve:(p:string)=>string}} source
   */
  async load(character: any, source: any) {
    const runtime = await ensureCubismRuntime();
    const { Live2DModel } = runtime;
    this.dropModel(); // 换模型时只清掉上一个模型，保留 app

    const settings = JSON.parse(await source.text(character.model3));

    // 把配置里的哈希条目名换成真实文件 URL（只在内存里改，磁盘上的 model3.json 保持原样）。
    // 必须是绝对 URL：pixi-live2d-display 会拿 settings.url 当 base 再解析一次相对路径，
    // 相对 + 相对会拼出错误地址（表现为 Network error）。
    const refs = character.refs || {};
    const toUrl = (value: any) => (refs[value] ? new URL(source.resolve(refs[value]), location.href).href : value);
    const rewrite = (node: any): any => {
      if (typeof node === 'string') return toUrl(node);
      if (Array.isArray(node)) return node.map(rewrite);
      if (node && typeof node === 'object') {
        const out: Record<string, any> = {};
        for (const [key, value] of Object.entries(node)) out[key] = rewrite(value);
        return out;
      }
      return node;
    };
    const resolvedSettings = rewrite(settings);
    /* 贴图清单以**清单里解析好的路径**为准，不再沿用 model3.json 的原始数组：
       有的包在同一 moc3 的后续模型里把 Textures 写成空字符串（实测 3446514791、3715171880），
       空串经过 rewrite 还是空串，PIXI 会去加载空地址并报 "Texture loading error"，
       模型直接打不开。清单里的路径是解包时按条目解析出来的（空引用还会借用同包兄弟模型的），
       长度与 moc3 需要的贴图数一致，顺序也保持。 */
    if (resolvedSettings.FileReferences) {
      const paths = character.textures ?? [];
      if (paths.length > 0) {
        resolvedSettings.FileReferences.Textures = paths.map((rel: any) => new URL(source.resolve(rel), location.href).href);
      }
      /* 动作的 File 同理：stub 型 model3 里这些引用是空的或指向包外，rewrite 之后要么是空串
         要么是原始 hash，PIXI 都取不到，于是"清单里有 122 组动作，运行时一个都没解析出来"。
         用清单里解析好的路径按 组 + 下标 对齐（顺序与 model3 一致）。 */
      const manifestMotions = new Map();
      for (const motion of character.motions ?? []) {
        if (!motion?.group || !motion.file) continue;
        if (!manifestMotions.has(motion.group)) manifestMotions.set(motion.group, []);
        manifestMotions.get(motion.group).push(motion.file);
      }
      const motionRefs = resolvedSettings.FileReferences.Motions;
      if (motionRefs && typeof motionRefs === 'object') {
        for (const [group, list] of Object.entries(motionRefs)) {
          const resolved = manifestMotions.get(group);
          if (!resolved || !Array.isArray(list)) continue;
          list.forEach((motion: any, index: any) => {
            if (!motion || typeof motion !== 'object') return;
            const path = resolved[index];
            if (path) motion.File = new URL(source.resolve(path), location.href).href;
          });
        }
      }
      const expressions = resolvedSettings.FileReferences.Expressions;
      const manifestExpressions = (character.expressions ?? []).filter((item: any) => item?.file);
      if (Array.isArray(expressions) && manifestExpressions.length === expressions.length) {
        expressions.forEach((expression: any, index: any) => {
          if (expression && typeof expression === 'object') {
            expression.File = new URL(source.resolve(manifestExpressions[index].file), location.href).href;
          }
        });
      }
    }
    resolvedSettings.url = new URL(source.resolve(character.model3), location.href).href;
    // 记下当前模型的配置：换模型/命中区域兜底都要用它（HitAreas 就在这上面）
    this.settings = resolvedSettings;

    // 动作清单：group#列表下标 → { 组内下标, 标签, 语音 }。
    // 注意 model.motion(group, index) 里的 index 是**组内**下标，
    // 而清单里的动作是全局列表，两者不能混用（混用会播到别的动作，看起来就是"动画很奇怪"）。
    this.motionIndex.clear();
    const perGroupCounter = new Map();
    (character.motions || []).forEach((motion: any, index: any) => {
      const groupIndex = perGroupCounter.get(motion.group) ?? 0;
      perGroupCounter.set(motion.group, groupIndex + 1);
      this.motionIndex.set(`${motion.group}#${index}`, {
        group: motion.group,
        groupIndex,
        listIndex: index,
        label: motion.label,
        sound: motion.sound,
        loop: motion.loop,
        command: motion.command ?? null,
        choices: motion.choices ?? null,
        /* 动作文件路径：playMotion 要拿它和"当前正在播的动作文件"比较，
           判断"待机已经在播同一个文件、别重启"。缺了它那个判断永远为 false
           （实测会让待机在循环点被重启并重新淡入，正是那段注释说要避免的）。 */
        file: motion.file ?? null,
      });
    });

    const app = this.ensureApp(runtime.PIXI);
    this.canvas.style.background = 'transparent';

    this.model = await Live2DModel.from(resolvedSettings, {
      autoInteract: false,
      /**
       * 不要用框架的 `idleMotionGroup`：它会在动作结束后从该组里**随机**挑一条，
       * 于是待机会在某几条之间不停轮换。原版不是这样 —— 它一直播同一段待机。
       * 这里改成由我们自己记住一条固定待机（见 setIdleMotion / ensureIdleMotion）。
       */
      idleMotionGroup: undefined,
    });

    /*
     * 关掉框架自带的"随机待机"。
     *
     * pixi-live2d-display 的 CubismMotionManager 里写死了 `this.groups = { idle: 'Idle' }`，
     * 并且构造参数只在**真值**时才覆盖它 —— 传 undefined 等于没传。于是每次动作结束，
     * `MotionManager.update` 里的 `state.shouldRequestIdleMotion() && startRandomMotion(this.groups.idle)`
     * 就会从 Idle 组里**随机**挑一条接着播，待机因此不停轮换（原版是一直播同一段）。
     * 这里把 idle 组指到一个不存在的名字，随机待机就彻底停掉；
     * 待机改由 setIdleMotion / ensureIdleMotion 固定播同一条。
     */
    const motionManager = this.model.internalModel?.motionManager;
    if (motionManager?.groups) motionManager.groups.idle = '';

    /* 每个模型自己的状态，换模型时必须清掉：
       motionPending 卡住会让"回待机"的看门狗永远不动；
       wanted 是"上一个模型正在等的动作"，留着会让看门狗的重试分支先 return，
       于是新模型的入场动画**根本轮不到执行**（实测 entranceTries 一直是 0）；
       停用组、入场、待机同理，都是上一个模型的遗留。 */
    this.motionPending = false;
    this.pendingFrames = 0;
    this.wanted = null;
    this.entranceMotion = null;
    this.entranceTries = 0;
    this.disabledMotionGroups.clear();
    this.idleMotion = null;
    this.lockedParameters.clear();
    this.parameterValues.clear();
    this.paramHitValues.clear();
    this.releases.clear();

    /* 预加载入场与待机动作。
       框架默认只预加载 idle 组，而我们为了关掉"随机待机"把 idle 组名清空了 ——
       于是 startMotion 会走"按需异步加载"的路，换模型后实测直接返回 false、
       模型停在 Idle 一动不动（入场动画放不出来）。这里先把它加载进缓存。 */
    this.preloadMotion = (group: any, listIndex: any) => {
      const info = this.motionIndex.get(`${group}#${listIndex}`);
      if (!info) return;
      try {
        motionManager?.loadMotion?.(group, info.groupIndex);
      } catch {
        /* 预加载失败不影响后续（真正起播时还会再试一次） */
      }
    };
    /**
     * 时间由我们自己驱动，不让模型挂在 PIXI 的共享 ticker 上。
     *
     * 原因：pixi-live2d-display 把 motionManager 交给"累计时间"（elapsedTime）驱动，
     * 而 elapsedTime 是在 Ticker.shared 的每个 tick 上累加的。实测模型每帧会被更新约两次
     * （应用自己的 ticker 渲染一次 + 共享 ticker 再走一遍），于是累计时间比真实时间快约 2.5 倍，
     * 表现就是"动画比原版快一倍多、还很不连贯"。
     * 关掉 autoUpdate 后 _render 里累加的时间恒为 0，模型只按 update() 收到的时间走。
     */
    this.model.autoUpdate = false;
    this.elapsedMs = 0;
    app.stage.addChild(this.model);

    // 参数锁定（Live2DViewerEX 的 "parameters lock" 指令）：每帧把锁定值写回去
    this.lockedParameters = new Map();
    this.parameterValues = new Map();
    // 包自带的 Controllers 配置（原版的全部交互行为都写在这里）
    this.setupControllers(settings);

    // 参数覆盖（锁定值、点击累计、光标追踪）必须写在"这一帧把参数应用到模型"之前。
    // 写在 update 之后的话，下一帧动作曲线会先把它覆盖掉，再被应用到模型 —— 等于没生效
    // （表现就是"换装 on 不生效""动作看着不自然"）。
    // pixi-live2d-display 在 coreModel.update() 之前会发 beforeModelUpdate 事件，用来落笔。
    //
    // 但"这一笔"未必是最后一笔：pixi 自己（以及别的插件）也挂在同一个事件上，
    // 而它的 loadParameters() 会把参数表整个写回去 —— 谁后注册谁最后写。
    // 实测 2983469431 拖拽把手：dragTo 里算出 value=0.04、写进核心了，
    // 推进几帧后读回来仍是 0.000；把写入挪到"锁定值之后"也没用，因为还在同一个事件里。
    //
    // 所以拆成两半：
    //   applyParameterOverrides(dt) —— 有状态的那部分（呼吸/参数循环/光标平滑/拖拽推进），
    //                                  **每帧只调一次**，仍挂在 beforeModelUpdate 上；
    //   writeOverridesLast()        —— 纯写入（参数值、锁定值、点击累计、处于拖动中的把手值），
    //                                  包在 coreModel.update 里、真正更新模型的前一刻，
    //                                  谁也不抢不走，而且不推进任何计时器，多调也无害。
    this.lastDelta = 1 / 60;
    const internal = this.model.internalModel;
    if (typeof internal?.on === 'function') {
      internal.on('beforeModelUpdate', () => this.applyParameterOverrides(this.lastDelta));
    } else if (typeof internal?.update === 'function') {
      // 兜底：万一运行时没有这个事件，退回到"更新后写一遍"
      const originalUpdate = internal.update.bind(internal);
      internal.update = (deltaTime: any, now: any) => {
        originalUpdate(deltaTime, now);
        this.applyParameterOverrides(deltaTime);
      };
    }
    const core = internal?.coreModel;
    if (core && typeof core.update === 'function' && !core.__lpkLastWriteHooked) {
      const originalCoreUpdate = core.update.bind(core);
      core.update = (...args: any[]) => {
        try {
          this.writeOverridesLast();
        } catch {
          /* 写不进去不影响模型更新本身 */
        }
        return originalCoreUpdate(...args);
      };
      core.__lpkLastWriteHooked = true;
    }

    this.resetView();
    this.fit();

    /* 这里**不要**自己先起循环动作。
       实测时间线：load() 里这条 playMotion("Idle") 发生在 app.js 的 setIdleMotion 之前，
       于是它按 NORMAL 发出、和入场动画抢 reservation —— 有 Start 的包因此时好时坏
       （ZB26 能播，达文西花嫁 / 关岛魔改只播 Idle）。待机统一交给 setIdleMotion + 看门狗；
       入场放弃时也会在同一次调用里把待机接上（见 ensureIdleMotion）。 */
    const motions = character.motions || [];

    return {
      motions,
      expressions: character.expressions || [],
      /** 原始 model3.json 里声明的动作组（用于区分"静态模型"与"动作解析失败"） */
      settingsMotionGroups: Object.keys(settings.FileReferences?.Motions ?? {}),
      /**
       * 运行时 model3.json 里每个动作的 Name —— 原版解析 `组:条目` 引用（例如
       * Choices 里的 `select:wedding`）用的就是它。manifest 里存的是字幕文本，
       * 不是这个名字，所以只能从这里拿。
       * 同时给出 File（就是 manifest 的 fileEntry，md5），用于精确定位到具体动作。
       */
      motionNames: Object.fromEntries(
        Object.entries(settings.FileReferences?.Motions ?? {}).map(([group, list]: any) => [
          group,
          list.map((entry: any) => ({ name: entry.Name ?? null, file: entry.File ?? null })),
        ]),
      ),
    };
  }

  /* ---------------------------------------------------------------- *
   * 视图
   * ---------------------------------------------------------------- */

  fit() {
    if (!this.model || !this.app) return;
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const modelWidth = this.modelWidth();
    const modelHeight = this.modelHeight();
    const scale = Math.min(width / modelWidth, height / modelHeight) * 0.98;
    this.view.scale = scale;
    this.view.offsetX = (width - modelWidth * scale) / 2;
    this.view.offsetY = (height - modelHeight * scale) / 2;
    this.applyView();
  }

  modelWidth() {
    return this.model?.internalModel?.width || this.model?.width || 1;
  }

  modelHeight() {
    return this.model?.internalModel?.height || this.model?.height || 1;
  }

  /** 模型锚点在左上角，所以 position 就是偏移，scale 就是缩放 */
  applyView() {
    if (!this.model) return;
    this.model.scale.set(this.view.scale);
    this.model.position.set(this.view.offsetX, this.view.offsetY);
  }

  /**
   * 画布尺寸用**父容器**量，而不是 canvas 自己。
   *
   * PIXI 的 `renderer.resize()` 会顺手把 canvas 的行内 CSS 宽高也设成同样的值，
   * 于是"用 canvas.clientWidth 量尺寸"就成了自反馈：首页显示时容器是 0 尺寸，
   * 一旦被压成 1×1，之后 canvas 量出来永远是 1，再也回不到正常大小（模型一直不显示）。
   * 所以这里：量容器、太小时直接不处理、画完再把 CSS 宽高交还给样式表。
   */
  resize() {
    if (!this.app) return;
    const host = this.canvas.parentElement ?? this.canvas;
    const width = Math.round(host.clientWidth);
    const height = Math.round(host.clientHeight);
    // 首页 / 抽屉遮挡期间容器是 0 尺寸，此时什么都不做（别把画布压成 1px）
    if (width < 2 || height < 2) return;
    this.app.renderer.resize(width, height);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.fit();
  }

  panBy(dx: any, dy: any) {
    this.view.offsetX += dx;
    this.view.offsetY += dy;
    this.applyView();
  }

  zoomBy(factor: any, cssX: any, cssY: any) {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const px = cssX ?? width / 2;
    const py = cssY ?? height / 2;
    // 光标下的模型坐标保持不变
    const modelX = (px - this.view.offsetX) / this.view.scale;
    const modelY = (py - this.view.offsetY) / this.view.scale;
    this.view.scale = Math.min(this.view.scale * factor, 1e4);
    this.view.offsetX = px - modelX * this.view.scale;
    this.view.offsetY = py - modelY * this.view.scale;
    this.applyView();
  }

  resetView() {
    this.view = { scale: 1, offsetX: 0, offsetY: 0 };
    this.fit();
  }

  /* ---------------------------------------------------------------- *
   * 播放
   * ---------------------------------------------------------------- */

  /**
   * 指定这个模型的"固定待机"动作（每个模型一条，永远播同一条，不轮换）。
   * 原版的表现就是一直播同一段待机；框架自带的 idleMotionGroup 会随机挑，所以关掉了。
   */
  setIdleMotion(group: any, index = 0) {
    this.idleMotion = group ? { group, index } : null;
  }

  /**
   * 口型同步的音量输入（0~1）。app.js 每帧从语音分析器取一次喂进来；
   * 真正的参数写入在 applyParameterOverrides 里（和参数锁定同一条时序）。
   */
  setLipSyncLevel(level: any) {
    const value = Number(level);
    this.lipSyncLevel = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  /** 取走"刚起播的动作自带的语音"（没有就返回 null）。app.js 每帧调用一次。 */
  takePendingSound() {
    const sound = this.pendingSound ?? null;
    this.pendingSound = null;
    return sound;
  }

  /**
   * 起播优先级：
   *   待机            → IDLE(1)
   *   其余动作，如果当前正在播的**就是待机** → FORCE(3)：框架的 reserve() 在"同等优先级且
   *     已有动作在播"时直接拒绝（实测：入口用 NORMAL 时 currentPriority 一直是 2、reserved
   *     始终是 undefined，Start 一帧都播不出去），必须高于待机才抢得动。
   *   其余动作，当前播的是别的动作 → NORMAL(2)：不硬抢正在进行的交互。
   */
  priorityFor(group: any) {
    if (String(group) === String(this.idleMotion?.group)) return MOTION_PRIORITY_IDLE;
    const current = this.model?.internalModel?.motionManager?.state?.currentGroup;
    const onIdle = current && String(current) === String(this.idleMotion?.group);
    return onIdle ? MOTION_PRIORITY_FORCE : MOTION_PRIORITY_NORMAL;
  }

  /**
   * 指定入场动画（包里的 Start 组）。
   * 不立刻起播，而是交给 ensureIdleMotion 在"框架手上没有动作"时起 ——
   * 换模型后紧接着起播会被框架拒掉（实测 startMotion 返回 false，模型停在 Idle 上
   * 一动不动，入场动画就放不出来），所以要等它空下来并允许重试。
   */
  setEntranceMotion(group: any, index = 0) {
    this.entranceMotion = group ? { group, index } : null;
    this.entranceTries = 0;
  }

  /**
   * 没有动作在播的时候把固定待机接上。
   *
   * 关键细节：动作是这一帧里被请求的（点击、参数触发、命令里的 start_mtn），而框架的
   * `motionManager.currentMotion` 要等它真正开始才反映出来。用"空转若干帧"当条件会在
   * 这一窗口里把刚请求的动作抢掉；这里改成等框架确认（`motionPending` 在
   * `currentMotion` 出现后清除），确认过之后再空就立刻回待机 —— 既不会抢动作，
   * 也不会像原版那样在动作结束后多停一段。
   *
   * TODO(review): 这个方法里叠了三套重试状态机（wanted / entranceMotion / motionPending，
   *   `waited`、`sinceLast`、`tries`、`pendingFrames` 各自计数）。语义已经很难一次读通，
   *   TODO：后续合并成一套（现在不动，避免破坏已经调好的时序）。
   */
  ensureIdleMotion() {
    if (!this.model) return false;
    const manager = this.model.internalModel?.motionManager;
    const state = manager?.state;
    /* 判断"还有没有动作在播"要用 isFinished()：
       动作播完后框架的 currentMotion 不会变 null，只看真假会把"已播完"误判成"正在播"，
       待机就再也接不上（表现是模型停在最后一帧不动）。 */
    const playing = Boolean(manager?.currentMotion) && manager?.isFinished?.() === false;

    /* 期望的动作还没被框架采纳就重试几帧。
       框架的 start(motion, group, index, priority) 要求 group/index 与 reserve 的一致，
       冲突时**静默**返回 false（换模型后的入场、交互被别的动作占着预约时都会这样）。
       不重试的话：交互等于没发生、底部立刻闪回"idle（循环）"。
       只在"当前播的不是待机"时让路，避免把点击/参数触发的动作饿死。 */
    /* 期望的动作还没被框架采纳就重试几帧。
       注意**不能**加 !playing 判断：待机一直在播，加上之后这段永远不会执行，
       交互就永远没有第二次机会（实测点击"摸头"三秒内框架只播过 Idle、底部一直闪回待机）。
       让路交给下面的 busyWithOther：只有"当前播的不是待机"时才不抢。 */
    /* 有入场动画待播时先处理入场，不要被"上一个动作的重试"挡住 ——
       实测：wanted 里还留着旧动作时，这段会先 return，入场分支永远轮不到执行
       （entranceTries 一直是 0，入场动画在那些包里就一直不播）。 */
    if (this.wanted && !this.entranceMotion) {
      const w = this.wanted;
      const info = this.motionIndex.get(`${w.group}#${w.index}`);
      const target = info ? info.groupIndex : w.index;
      const onAir =
        state && String(state.currentGroup) === String(w.group) && Number(state.currentIndex) === Number(target);
      if (onAir) {
        this.wanted = null;
      } else if (w.tries < 20) {
        const busyWithOther =
          state && state.currentGroup && String(state.currentGroup) !== String(this.idleMotion?.group ?? '');
        if (busyWithOther) return false; // 让别人先播
        /* 请求是异步的（reserve → await 加载 → start），期间 state.reservedGroup 指向这条动作。
           在它结算前**不能重发**：重发会让它走到 start() 时因为"预约对不上"被拒，
           于是变成"每帧重试、永远播不出来"，连待机也接不回来（模型冻住）。
           实测依据：真实帧循环下换角色后框架里什么都没在播（HUD 显示"待机"）。
           等太久就安静放弃，把待机让出来 —— 不去动框架的状态（清预约会把模型彻底冻住）。 */
        const inFlight = String(state?.reservedGroup) === String(w.group);
        if (inFlight) {
          w.waited = (w.waited ?? 0) + 1;
          if (w.waited < 240) return false;
          this.wanted = null;
          this.motionPending = false;
          this.currentMotion = null;
          return false;
        }
        // 两次尝试之间留出时间，别打断正在加载的请求
        w.sinceLast = (w.sinceLast ?? 0) + 1;
        if (w.tries > 0 && w.sinceLast < 15) return false;
        w.sinceLast = 0;
        w.tries += 1;
        const groupIndex = info ? info.groupIndex : w.index;
        try {
          this.model.motion(w.group, groupIndex, this.priorityFor(w.group));
        } catch {
          /* 起播失败就继续重试（上面的 tries 有上限） */
        }
        return false;
      } else {
        this.wanted = null; // 试够了，交给待机
      }
    }

    /* 入场动画优先。
       这里**不能**要求 !playing：待机被我们强制成循环（isLoop=true）后永远不会结束，
       那样入场就永远等不到机会（实测 Start 一帧都没播过）。
       只给"非待机的正在播动作"让路（点击/参数触发），既不会抢用户操作，也能顶掉自己的待机。 */
    if (this.entranceMotion) {
      const wanted = this.entranceMotion;
      const info = this.motionIndex.get(`${wanted.group}#${wanted.index}`);
      const targetIndex = info ? info.groupIndex : wanted.index;
      const onAir =
        state &&
        String(state.currentGroup) === String(wanted.group) &&
        Number(state.currentIndex) === Number(targetIndex);
      if (onAir) {
        this.entranceMotion = null; // 确认在播了
        return true;
      }
      /* 只在"当前播的不是待机"时让路：点击/参数触发的动作不能被入场抢掉
         （实测：入场每帧硬抢会把"参数到值触发动作"整个饿死）。
         但如果只在等 currentPriority 归零，就会和自己的待机死锁 —— 所以这里只挡非待机动作。 */
      const busyWithOther =
        state &&
        state.currentGroup &&
        String(state.currentGroup) !== String(this.idleMotion?.group ?? '');
      if (busyWithOther) return false;
      this.entranceTries = (this.entranceTries ?? 0) + 1;
      /* 起不来就别一直挡着（约 2 秒后放弃），并且**把这次放弃的预约一起清掉**：
         入场是按 FORCE(3) 发的，一旦它没落地，reservation 会以 3 的优先级一直挂着；
         待机是 IDLE(1)，遇到"已有更高优先级预约"会被 reserve() 直接拒掉 ——
         于是模型什么都不播（实测三个包都变成这样）。只清"正是我们要放弃的这条"。 */
      if (this.entranceTries > 60) {
        this.entranceMotion = null;
        this.wanted = null;
        this.motionPending = false;
        this.currentMotion = null;
        const target = info ? info.groupIndex : wanted.index;
        if (String(state?.reservedGroup) === String(wanted.group) && Number(state?.reservedIndex) === Number(target)) {
          try {
            state?.setReserved?.(undefined, undefined, 0);
          } catch {
            /* 清不掉就照旧往下走 */
          }
        }
        // 注意：这里**不 return**，同一次调用里继续把待机接上
      } else {
        this.playMotion(wanted.group, wanted.index, { entrance: true });
        return false;
      }
    }

    if (playing) {
      this.motionPending = false;
      this.pendingFrames = 0;
      return false;
    }
    if (this.motionPending) {
      /* 请求过动作但框架迟迟没反映（异步加载静默失败）：等一小会儿就放弃这次请求，
         否则 motionPending 永远卡在 true，待机再也接不回来。 */
      this.pendingFrames = (this.pendingFrames ?? 0) + 1;
      if (this.pendingFrames < 30) return false;
      this.motionPending = false;
      this.pendingFrames = 0;
      this.currentMotion = null;
    }
    if (!this.idleMotion) return false;
    // 走到这里说明框架手上没有在播的动作 → 接回固定待机
    return this.playMotion(this.idleMotion.group, this.idleMotion.index);
  }

  /**
   * 播一个动作。
   * @param {string} group 动作组
   * @param {number} index **清单里的全局下标**（内部换算成框架要的组内下标）
   * @returns {boolean} 是否成功开始播放
   */
  playMotion(group: any, index: any = 0, options: any = {}) {
    if (!this.model) return false;
    // `motions disable Tap` 这类命令停用的动作组不能播
    if (this.disabledMotionGroups.has(String(group))) return false;
    /* 有别的动作要播了，还没放出来的入场动画就让位 ——
       否则入场会一直和点击/参数触发的动作抢预约（实测会把它们整个饿死）。
       入场自己的重试带 entrance 标记，不会把自己取消掉。 */
    if (!options.entrance) this.entranceMotion = null;
    this.motionPending = true; // 等框架确认这条动作已经开始，期间不抢着回待机
    this.pendingFrames = 0;
    /* 记下"希望播的是哪一条"：框架的 startMotion 会因为预约冲突静默返回 false，
       这时如果不重试，交互就等于没发生 —— 表现是底部立刻闪回"idle（循环）"。
       看门狗会拿这个期望去核对框架状态并重试几帧。 */
    this.wanted = { group, index, tries: 0, entrance: Boolean(options.entrance) };
    const info = this.motionIndex.get(`${group}#${index}`);
    /* 名字就是 idle 开头的组（`Idle` / `Idle#1` / `idle_01`）要**接班成为待机**，
       不能当一次性动作播完就被固定 Idle 顶掉 —— 这类组是包的待机变体。
       注意**不要**用 /idle/i：那会把 `touch_idle` / `cover_idle` / `aim_idle` 也算进来，
       它们是"状态/反应"动作，实测把 touch_idle 接成待机会让画面每 2.28 秒
       弹出来一次又收回去（ZP_1~ZP_6 实测 0 → 1.95 → 0 → 1.96 …），既不是原版行为，
       也解决不了"扇面停住"（touch_idle_1 这条动作本身就是弹出→收回，包没法把扇面留在外面）。 */
    if (!options.entrance && /^idle/i.test(String(group))) {
      this.setIdleMotion(group, index);
    }
    const groupIndex = info ? info.groupIndex : index;
    // 正在循环的**待机**已经在播就不要重新起播：重新起播会带上淡入，循环点就白等了。
    // （一次性动作仍然会重播，符合"再点一次再看一遍"的预期。）
    // 注意：这里不能只看 info.loop —— 解包清单里的 loop 现在如实反映 motion3.json 的
    // Meta.Loop，而这批包几乎把**所有**动作都标成 Loop:true（实测 3258231941 有 23/32 组），
    // 只信它会导致"再点一次不重播"。
    const current = this.model.internalModel?.motionManager?.currentMotion;
    const currentFile = current?.definition?.File ?? current?.definition?.file ?? null;
    const wantedFile = info?.file ?? null;
    const isCurrentIdle =
      String(this.idleMotion?.group ?? '') === String(group) && Number(this.idleMotion?.index ?? -1) === Number(index);
    if (isCurrentIdle && currentFile && wantedFile && currentFile === wantedFile) {
      return true;
    }
    const played = this.model.motion(group, groupIndex, this.priorityFor(group));
    if (played === false) {
      this.motionPending = false; // 起播失败就不要一直等，否则待机再也接不上
      return false;
    }
    /* 这条动作自带的语音：交给 app.js 播（渲染循环里取走）。
       入场动画由播放器内部起播（看门狗重试那条路），不走 app.js 的播放入口，
       所以必须在这里把语音交出去 —— 否则入场动画放出来了却没有声音。
       注意：这行必须在**所有**动作上都执行，不能只写在待机分支里
       （之前被脚本插进了 idle 分支，结果只有待机会设置它，入场永远没声音）。 */
    this.pendingSound = info?.sound ?? null;
    /* 固定待机强制设为循环：包里的 Loop 标记不一定传到运行时（实测 Idle_0 播完就停了），
       而待机要么无缝循环、要么被反复重播（后者看得出"跳了一下"）。 */
    if (this.idleMotion?.group === group && this.idleMotion?.index === index) {
      const loaded = this.model.internalModel?.motionManager?.motionGroups?.[group]?.[groupIndex];
      Promise.resolve(loaded)
        .then((motion: any) => {
          if (motion) motion.isLoop = true;
        })
        .catch(() => {});
    }
    this.currentMotion = { group, index, label: info?.label ?? null, sound: info?.sound ?? null };
    return true;
  }

  /**
   * 执行 Live2DViewerEX 的 "Command" 动作（这些动作没有动作文件，只改参数 / 弹选项 / 换模型）。
   * 支持：
   *   parameters lock <id> [值] [毫秒] / unlock <id> / set <id> <值>
   *   change_model <模型条目名>   → 切到同一个包里的另一个模型
   *   start_mtn / next_mtn <引用> → 接着播某个动作
   * 以及 PostCommand（主命令之后再执行一条）和 NextMtn。
   *
   * 注意：**只有 postCommand、没有 command** 的条目也要执行。
   * 实测 【碧蓝航线】不挠 的 UI 命令条目就是这种形态 —— 例如 CD_UI#9 的
   * `postCommand = "parameters lock CD_UI $CD_UI 300"`：它把参数在 300 毫秒内推到变量值上，
   * 面板就是靠这一步进场/退场的。以前直接判成"没有可执行的命令"就返回，面板永远不动。
   */
  runMotionCommand(info: any) {
    const output: any = { ok: false, message: '', choices: null, nextMotion: null, changeModel: null };
    const applied = [] as any[];
    const command = info?.command ? this.applyCommandString(info.command) : null;
    if (command) {
      applied.push(...command.applied);
      if (command.changeModel) output.changeModel = command.changeModel;
      // 命令里要求播放某段动作（`start_mtn Tap`）时，交给上层用引用解析去播
      if (command.nextMotion) output.nextMotion = command.nextMotion;
    }
    // change_cos <xxx.bin3>：换装＝切到那个模型，和 change_model 走同一条路
    // （参数的 .bin3 文件名与 manifest 里角色的 source.modelEntry 一一对应）
    if (this.pendingCostume) {
      output.changeModel = output.changeModel ?? this.pendingCostume;
      this.pendingCostume = null;
    }
    if (info?.postCommand) {
      /* PostCommand 是"这条命令之后再执行"的后置命令，原版是等这条动作（含它的文字停留）走完再执行。
         立刻执行会把主命令的效果抵消掉：例如"脱内裤 on"是
           command = unlock Param49; lock Param49 0   （把内衣穿回去并锁住）
           post    = unlock Param49                   （放开锁定，交回动画）
         两条同时跑，锁定刚建立就被解除，表现就是"on 不生效"。 */
      this.schedulePostCommand(info.postCommand, info.textDurationMs ?? 0);
      applied.push('后置命令已排队');
    }
    output.ok = applied.length > 0 || Boolean(info?.choices) || Boolean(info?.nextMotion) || Boolean(output.changeModel);
    output.choices = info?.choices ?? null;
    // 命令里要播的动作优先于条目自带的 nextMotion
    output.nextMotion = output.nextMotion ?? info?.nextMotion ?? null;
    output.message = applied.join('；') || '命令已执行';
    if (!output.ok) {
      return { ok: false, message: '这条动作没有可执行的内容', choices: null, nextMotion: null, changeModel: null };
    }
    this.applyParameterOverrides();
    this.currentMotion = {
      group: info.group,
      index: info.listIndex ?? 0,
      label: info.label,
      sound: null,
      command: true,
    };
    return output;
  }

  /** 后置命令：等这条动作（文字停留时长）走完再执行，中途来了新命令就取消 */
  schedulePostCommand(command: any, delayMs: any) {
    if (this.postCommandTimer !== null) {
      clearTimeout(this.postCommandTimer);
      this.postCommandTimer = null;
    }
    if (!command) return;
    const run = () => {
      this.postCommandTimer = null;
      if (!this.model) return;
      this.applyCommandString(command);
      this.applyParameterOverrides(this.lastDelta);
    };
    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
    if (delay === 0) run();
    else this.postCommandTimer = setTimeout(run, delay);
  }

  /**
   * 这一帧以我们为准的参数值（锁定 / 过渡中 / 命令设过的），没有就返回 null。
   *
   * 用途：变量条件里的 `@参数` 要按**我们写下去的值**判断。
   * `coreModel.getParameterValueById()` 读回来的是 `loadParameters()` 恢复出来的旧值 ——
   * 动作曲线把参数改掉、我们又在 beforeModelUpdate 里写回，读回来的仍是恢复值。
   * 不区分的话，"面板开着再点一次"的 `@CD_UI not_equal 0` 永远不成立，面板只能开不能关。
   */
  overrideValueOf(id: any) {
    /* 顺序必须与 applyParameterOverrides 的**实际书写顺序**一致（后写的赢）：
       那里 releases 先写、lockedParameters 后写，所以最终生效的是锁定值。
       之前把 releases 放在前面，于是"既在释放又被锁定"的参数：
       包自己的条件判断读到释放目标值，模型实际用的却是锁定值 —— 两者不一致。 */
    if (this.lockedParameters.has(id)) return this.lockedParameters.get(id);
    if (this.releases.has(id)) return this.releases.get(id).to;
    // 拖拽把手按住期间的累计值（LockParam 的把手就停在这里）
    if (this.paramHitValues.has(id)) return this.paramHitValues.get(id);
    if (this.parameterValues.has(id)) return this.parameterValues.get(id);
    return null;
  }

  /**
   * 把命令串里的 `$变量名` 换成当前值。
   *
   * 包里大量使用这种写法：`parameters lock CD_UI $CD_UI 300` ——
   * 意思是"把参数 CD_UI 在 300 毫秒内推到**变量 CD_UI 的当前值**"。
   * 之前只在 init 那条路径上替换，postCommand 里的 `$CD_UI` 会解析成 NaN，
   * 于是参数永远停在原处、面板开关也就永远只能往一个方向走。
   */
  substituteVariables(text: any) {
    return String(text ?? '').replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole: any, name: any) => {
      const value = Number(this.variableOf?.(name));
      return Number.isFinite(value) ? String(value) : whole;
    });
  }

  /** 解析并执行一条命令串，返回执行说明 */
  applyCommandString(rawText: any) {
    const applied = [] as any[];
    let changeModel = null;
    let nextMotion = null;
    const text = this.substituteVariables(rawText);
    for (const clause of String(text).split(';')) {
      const parts = clause.trim().split(/\s+/);
      if (parts.length === 0 || !parts[0]) continue;
      if (parts[0] === 'change_model' && parts[1]) {
        changeModel = parts[1];
        applied.push(`切换到模型 ${parts[1]}`);
        continue;
      }
      // start_mtn / next_mtn：播放一个动作引用（可以是 `组:条目` 或 `组#N`）。
      // 实测 【碧蓝航线】不挠 里 `set_10` 这条"没有动作文件"的条目，
      // 它的 command 就是 `start_mtn Tap` —— 以前不认这条指令，于是报"没有可执行的命令"。
      if ((parts[0] === 'start_mtn' || parts[0] === 'next_mtn') && parts[1]) {
        nextMotion = parts.slice(1).join(' ');
        applied.push(`播放 ${nextMotion}`);
        continue;
      }
      // 开关类指令：hit_areas / motions / param_hit / param_loop / mouse_tracking / change_cos
      if (TOGGLE_VERBS.has(parts[0])) {
        const note = this.applyToggleCommand(parts);
        if (note) applied.push(note);
        continue;
      }
      /* 参数锁定/解锁的另一种写法（解包 APK 的 global-metadata.dat 里有 unlock_param /
         unlock_all_params 这两个标识符，是原版支持的拼写）。等价于
         `parameters lock <id> <值>` / `parameters unlock <id>` 以及"全部解锁"。 */
      if (parts[0] === 'unlock_all_params' || parts[0] === 'unlock_all') {
        this.lockedParameters.clear();
        applied.push('解锁全部参数');
        continue;
      }
      if (parts[0] === 'unlock_param' && parts[1]) {
        this.lockedParameters.delete(parts[1]);
        applied.push(`解锁 ${parts[1]}`);
        continue;
      }
      if ((parts[0] === 'lock_param' || parts[0] === 'set_param') && parts[1]) {
        const raw = Number(parts[2] ?? (parts[0] === 'lock_param' ? 1 : 0));
        const value = Number.isFinite(raw) ? raw : 0;
        if (parts[0] === 'lock_param') this.lockedParameters.set(parts[1], value);
        else this.parameterValues.set(parts[1], value);
        this.writeParameter(parts[1], value);
        applied.push(`${parts[0] === 'lock_param' ? '锁定' : '设置'} ${parts[1]}=${value}`);
        continue;
      }
      if (parts[0] !== 'parameters' || parts.length < 3) continue;
      const action = parts[1];
      const id = parts[2];
      if (action === 'lock' || action === 'set') {
        const raw = action === 'lock' ? (parts.length > 3 ? Number(parts[3]) : 1) : Number(parts[3] ?? 0);
        const value = Number.isFinite(raw) ? raw : action === 'lock' ? 1 : 0;
        /* 第 5 个参数是**过渡时长（毫秒）**：`parameters lock CD_UI $CD_UI 300`
           表示把参数在 300 毫秒内推到目标值（UI 面板进场/退场就是靠它平滑移动的）。
           没有时长就立刻写一次。 */
        const durationMs = Number(parts[4]);
        if (action === 'lock') this.lockedParameters.set(id, value);
        else this.parameterValues.set(id, value);
        if (Number.isFinite(durationMs) && durationMs > 0) {
          // 复用 Release 的缓动队列：从当前值过渡到目标值
          let current = value;
          try {
            current = Number(this.model?.internalModel?.coreModel?.getParameterValueById(id));
          } catch {
            current = value;
          }
          if (Number.isFinite(current) && Math.abs(current - value) > 1e-6) {
            this.releases.set(id, {
              from: current,
              to: value,
              durationMs,
              type: Number.isFinite(Number(parts[5])) ? Number(parts[5]) : 0,
              startMs: this.elapsedMs,
            });
          }
        } else {
          // 立刻写一次。像 "parameters lock Param142 0;parameters unlock Param142" 这种
          // "设一次值就放开"的写法（脱下衣的"穿"），只记录锁定等于没写：
          // 同一串命令里紧接着就解锁了，参数会保持原值，看起来就是"穿不生效"。
          this.writeParameter(id, value);
        }
        applied.push(
          (action === 'lock' ? `锁定 ${id}=${value}` : `设置 ${id}=${value}`) +
            (Number.isFinite(durationMs) && durationMs > 0 ? `（${durationMs}ms 过渡）` : ''),
        );
      } else if (action === 'unlock') {
        this.lockedParameters.delete(id);
        applied.push(`解锁 ${id}`);
      }
    }
    return { applied, changeModel, nextMotion };
  }

  /**
   * 解析命令串里"开关类"的指令。这些动词覆盖了包里全部的开关需求
   * （对 35 个包做过统计：param_hit 4 处、mouse_tracking 4 处、hit_areas 3 处、
   * motions 3 处、change_cos 2 处、param_loop 1 处）：
   *
   *   hit_areas enable|disable            整个点击区域开/关（就是包里那句"锁定触摸"）
   *   motions enable|disable <组>[,组…]   某个动作组开/关
   *   param_hit enable|disable <名字…>    某个拖拽把手开/关（换装的滑块就是它）
   *   param_loop enable|disable <名字…>   某个参数循环开/关
   *   mouse_tracking enable|disable       光标跟随开/关
   *   change_cos <xxx.bin3>               换装：切到对应的那个模型（原版用 .bin3 文件名指代）
   */
  applyToggleCommand(parts: any) {
    const verb = parts[0];
    const on = parts[1] === 'enable';
    const names = parts
      .slice(2)
      .join(' ')
      .split(',')
      .map((name: any) => name.trim())
      .filter(Boolean);
    switch (verb) {
      case 'hit_areas':
        this.hitAreasEnabled = on;
        return `点击区域${on ? '开启' : '关闭'}`;
      case 'mouse_tracking':
        this.trackingEnabled = on;
        return `光标跟随${on ? '开启' : '关闭'}`;
      case 'motions':
        for (const name of names) {
          if (on) this.disabledMotionGroups.delete(name);
          else this.disabledMotionGroups.add(name);
        }
        return `动作组 ${names.join('、')}${on ? '启用' : '停用'}`;
      case 'param_hit':
        for (const name of names) {
          if (on) this.disabledParamHits.delete(name);
          else this.disabledParamHits.add(name);
        }
        return `拖拽把手 ${names.join('、')}${on ? '启用' : '停用'}`;
      case 'param_loop':
        for (const name of names) {
          if (on) this.disabledParamLoops.delete(name);
          else this.disabledParamLoops.add(name);
        }
        return `参数循环 ${names.join('、')}${on ? '启用' : '停用'}`;
      case 'change_cos':
        if (parts[1]) {
          this.pendingCostume = parts[1];
          return `换装 → ${parts[1]}`;
        }
        return null;
      default:
        return null;
    }
  }

  /** 直接写一个参数（参数不存在时忽略） */
  writeParameter(id: any, value: any) {
    const core = this.model?.internalModel?.coreModel;
    if (!core?.setParameterValueById) return;
    try {
      core.setParameterValueById(id, value);
    } catch {
      /* 参数不存在就跳过 */
    }
  }

  /** 该动作组里第一个可播放（或可执行）的动作，供点击区域使用 */
  firstMotionOfGroup(group: any) {
    for (const [key, info] of this.motionIndex) {
      if (info.group !== group) continue;
      // 命令型条目同样返回（由 playGroup 交给上层处理），两条分支本来就是同一个结果
      return { info, key };
    }
    return null;
  }

  /**
   * 把锁定的参数值写回模型（每帧调用）。
   *
   * deltaTime 默认取上一帧的真实步进（update() 会写在 this.lastDelta 上）：
   * 呼吸 / 参数循环 / 光标平滑都按它推进。之前这里固定 1/60，于是"命令触发"和
   * "init" 这两条调用路径在非 60fps 时按假速率推进（呼吸、循环、追踪和画面对不上）。
   * 只有第一帧（update 还没跑过）才退回 1/60。
   *
   * TODO(review): 这个方法过长（参数覆盖 + 呼吸 + 参数循环 + 光标追踪 + 拖拽 + 触发），
   *   TODO：后续按职责拆开（现在只对齐 delta，不动内部顺序）。
   */
  /**
   * **纯写入**：把这一帧该生效的参数值写进核心，不推进任何计时器，因此多调也无害。
   *
   * 由 coreModel.update 的包装在"真正更新模型的前一刻"调用，保证是最后一笔 ——
   * pixi 的 loadParameters() 会把参数表写回去，我们写在它后面才不会被冲掉
   * （拖拽把手"拖了没反应"、换装指令"报了却没生效"都是这个时序问题）。
   * 有状态的部分（呼吸/参数循环/光标平滑/拖拽推进）留在 applyParameterOverrides 里，
   * 那个每帧只跑一次。
   */
  writeOverridesLast() {
    const core = this.model?.internalModel?.coreModel;
    if (!core?.setParameterValueById) return;
    /* 诊断用：记下这次写了哪些 id（自检与排查时会打印）。
       逐笔回读（每个写入再读一次核心）只在 debugWriteTrace 打开时做 —— 它每帧都会跑，
       平时不该为排查付性能代价。 */
    const traceDetail = this.debugWriteTrace === true;
    const written = [] as any[];
    let pass = '?';
    const write = (id: any, value: any) => {
      /* 先转数值再判有限：handle.value 有可能来自配置（字符串），
         直接 Number.isFinite("4") 会得到 false 而静默跳过。 */
      const numeric = Number(value);
      if (!id || !Number.isFinite(numeric)) {
        if (traceDetail) written.push(`${pass}:${id}=${value}→跳过`);
        return;
      }
      try {
        core.setParameterValueById(id, numeric);
        if (!traceDetail) {
          written.push(id);
          return;
        }
        let readBack = null;
        try {
          readBack = Number(core.getParameterValueById(id));
        } catch {
          readBack = '读回抛错';
        }
        written.push(`${pass}:${id}=${numeric}→${typeof readBack === 'number' ? readBack.toFixed(3) : readBack}`);
      } catch (error: any) {
        if (traceDetail) written.push(`${pass}:${id}=${numeric}→抛错:${error.message}`);
      }
    };
    pass = 'pv';
    for (const [id, value] of this.parameterValues) write(id, value);
    pass = 'hit';
    for (const [id, value] of this.paramHitValues) write(id, value);
    pass = 'lock';
    for (const [id, value] of this.lockedParameters) write(id, value);
    /* 光标追踪：目标值在 applyParameterOverrides 里平滑过，这里只负责写 */
    if (this.trackingEnabled && this.mouseTracking && this.focusTarget) {
      const gain = this.trackingGain;
      for (const item of this.mouseTracking.Items ?? []) {
        if (!item?.Id) continue;
        const raw = item.Axis === 1 ? this.smoothedFocus.y : this.smoothedFocus.x;
        const axis = clamp(raw * gain, -1, 1);
        const min = Number.isFinite(item.Min) ? item.Min : -1;
        const max = Number.isFinite(item.Max) ? item.Max : 1;
        write(item.Id, clamp(min + ((axis + 1) / 2) * (max - min), Math.min(min, max), Math.max(min, max)));
      }
    }
    /* **正在拖动中的把手必须最后写**，要压在参数锁定之后。
       包里常见写法是 init 先 `parameters lock LG_siwaL $LG_siwaL` 把参数钉在 0 档位上，
       而把手本身没标 LockParam —— 这时锁定值每帧最后写回，拖动值刚写进去就被压回 0。
       另一个坑：**同一个参数可以被多个把手共用**（实测 3805742792 的 LG_siwaL 有两个把手），
       没被拖动的那个每帧也会算出一个值（0），写在后面就把被拖动的那个覆盖掉。
       所以这里按参数 id 归并，取"偏离起点更多"的那个把手 —— 也就是用户真正在拖的那个。 */
    pass = 'drag';
    {
      const byId = new Map();
      for (const handle of this.drag?.handles ?? []) {
        const id = handle?.item?.Id;
        if (!id) continue;
        const moved = Math.abs(Number(handle.value) - Number(handle.startValue));
        const previous = byId.get(id);
        if (!previous || moved > previous.moved) byId.set(id, { handle, moved });
      }
      for (const { handle } of byId.values()) write(handle?.item?.Id, handle?.value);
    }
    /* 诊断：把这次写过的 id / 值 / 立刻回读记下来（自检失败时会打印） */
    this.lastWrittenIds = written;
  }

  applyParameterOverrides(deltaTime = this.lastDelta ?? 1 / 60) {
    const core = this.model?.internalModel?.coreModel;
    if (!core?.setParameterValueById) return;
    for (const [id, value] of this.parameterValues) {
      try {
        core.setParameterValueById(id, value);
      } catch {
        /* 参数不存在就跳过 */
      }
    }
    /* 部件/网格不透明度：包用它们做"强制显示"（例如黑边矩形、背景、道具），
       原版同样每帧按配置写回。写在最前面，后面的动作不会把它冲掉（我们仍在本帧末生效）。 */
    if (this.partOpacity) {
      for (const item of this.partOpacity) {
        // 官方 Web API 的正确名字是 setPartOpacityByIndex（vendor 里 pixi 用的就是这个）
        try {
          if (core.setPartOpacityByIndex) core.setPartOpacityByIndex(item.index, item.value);
          else if (core.setPartOpacityById) core.setPartOpacityById(item.id ?? item.index, item.value);
        } catch {
          /* 部件不存在就跳过 */
        }
      }
    }
    if (this.artmeshOpacity) {
      for (const item of this.artmeshOpacity) {
        try {
          if (core.setDrawableOpacity) core.setDrawableOpacity(item.index, item.value);
          else if (core.setDrawableOpacityByIndex) core.setDrawableOpacityByIndex(item.index, item.value);
          else if (core.setDrawableOpacityById) core.setDrawableOpacityById(item.id ?? item.index, item.value);
        } catch {
          /* 网格不存在就跳过 */
        }
      }
    }
    /* 自动呼吸：官方 CubismBreath 用 0~1 的余弦，周期 3.2345 秒 */
    if (this.breath) {
      this.breath.elapsed = (this.breath.elapsed + deltaTime * 1000) % this.breath.periodMs;
      const value = (1 - Math.cos((2 * Math.PI * this.breath.elapsed) / this.breath.periodMs)) / 2;
      this.breathValue = value;
      try {
        core.setParameterValueById(this.breath.id, value);
      } catch {
        /* 参数不存在就跳过 */
      }
    }
    /* 参数循环：在两个值之间来回（原版 ParamLoop）。用三角波，Duration 是一个来回的时长。 */
    if (this.paramLoops) {
      this.loopElapsed = (this.loopElapsed ?? 0) + deltaTime * 1000;
      for (const item of this.paramLoops) {
        /* 包里的 `param_loop disable <名字>` 要真的生效：之前 disabledParamLoops 只写不读，
           命令报"已停用"、循环却照跑。名字和 id 都可能出现在命令里，所以两个都比。 */
        const disabled = this.disabledParamLoops;
        if (disabled?.size && (disabled.has(String(item.id)) || disabled.has(String(item.name ?? '')))) continue;
        const phase = (this.loopElapsed % item.duration) / item.duration;
        const triangle = phase < 0.5 ? phase * 2 : 2 - phase * 2;
        const value = item.min + (item.max - item.min) * triangle;
        this.parameterValues.set(item.id, value);
        try {
          core.setParameterValueById(item.id, value);
        } catch {
          /* 参数不存在就跳过 */
        }
      }
    }

    // 光标追踪：按包里 MouseTracking 配置的 Min/Max 映射（带平滑）
    if (this.trackingEnabled && this.mouseTracking && this.focusTarget) {
      const smooth = Math.max(0.02, this.mouseTracking.SmoothTime ?? 0.15);
      const k = Math.min(1, deltaTime / smooth);
      this.smoothedFocus.x += (this.focusTarget.x - this.smoothedFocus.x) * k;
      this.smoothedFocus.y += (this.focusTarget.y - this.smoothedFocus.y) * k;
      const gain = this.trackingGain;
      for (const item of this.mouseTracking.Items) {
        if (!item?.Id) continue;
        const raw = item.Axis === 1 ? this.smoothedFocus.y : this.smoothedFocus.x;
        // 幅度可控：光标在模型范围内时通常只到一半左右，想看到极限要移到模型外
        const axis = clamp(raw * gain, -1, 1);
        const min = Number.isFinite(item.Min) ? item.Min : -1;
        const max = Number.isFinite(item.Max) ? item.Max : 1;
        const value = min + ((axis + 1) / 2) * (max - min);
        try {
          core.setParameterValueById(item.Id, clamp(value, Math.min(min, max), Math.max(min, max)));
        } catch {
          /* 参数不存在就跳过 */
        }
      }
    }

    // 点击累计出来的参数（ParamHit）要保持住
    for (const [id, value] of this.paramHitValues) {
      try {
        core.setParameterValueById(id, value);
      } catch {
        /* 参数不存在就跳过 */
      }
    }

    /* 口型同步（原版的 LipSync 控制器）：按当前语音音量驱动 model3.json 里声明的
       Groups.LipSync 参数（pixi 已经把它解析成 internalModel.lipSyncIds）。
       写在参数锁定**之前** —— 命令里的 `parameters lock` 应当能压过口型。
       注意：这批包一个都没声明 LipSync（14 个 Cubism 角色里 0 个），所以平时不会生效；
       这里做的是机制本身，将来任何声明了口型的包都能直接用。 */
    if (this.lipSyncLevel > 0) {
      for (const id of this.model?.internalModel?.lipSyncIds ?? []) {
        try {
          const index = core.getParameterIndex(id);
          if (index < 0) continue;
          const min = Number(core.getParameterMinimumValue(index));
          const max = Number(core.getParameterMaximumValue(index));
          const value = Number.isFinite(min) && Number.isFinite(max) && max > min
            ? min + (max - min) * this.lipSyncLevel
            : this.lipSyncLevel;
          core.setParameterValueById(id, value);
        } catch {
          /* 参数不存在就跳过 */
        }
      }
    }

    // "按压"型把手按时间推进；松手的把手按 Release 缓回拖动前的值
    // dragTick 会返回"拖到极值"要播的动作（MinMtn / MaxMtn），必须交给下面的队列，
    // 否则拖到底不会停在那一步（包里这类动作是换装/开关的落点）。
    this.pendingTriggers.push(...this.dragTick(deltaTime));
    this.applyReleases();

    /* 锁定值必须**最后**写：applyReleases 会把参数往"释放目标"缓动，如果锁定写在它前面，
       同一帧里就被它冲掉了 —— 表现就是"点了区域、变量也变了，但模型完全没反应"。
       实测：CD_UI 范围 0~10，命令把变量写成 10 并锁定 CD_UI=$CD_UI，
       但参数一直是 0（直接写 10 也是"刚写完=10，过一帧=0"）。
       overrideValueOf 里注释的顺序（releases → locked）就是这里应该有的顺序。 */
    for (const [id, value] of this.lockedParameters) {
      try {
        core.setParameterValueById(id, value);
      } catch {
        /* 参数不存在就跳过 */
      }
    }

    this.checkParamTriggers();

    // 参数触发的动作（例如某参数变 1 → 播"脱衣服"）
    while (this.pendingTriggers.length > 0) {
      const group = this.pendingTriggers.shift();
      if (group) this.playGroup(group);
    }
  }

  /**
   * 读取包里的 Controllers 配置。
   * 原版的交互几乎全靠它：
   *   MouseTracking → 光标追踪要把哪些参数驱动到多少（Min/Max）
   *   ParamHit      → 点某个部位会给某个参数加减值，到达阈值就播 MaxMtn / EndMtn（"人物变化"就是这个）
   *   ParamTrigger  → 参数到达某个值时触发某个动作
   *   KeyTrigger    → 按某个键播某个动作（原版支持，例如 【碧蓝航线】不挠 的 Input 192 → touch#9）
   *   IntimacySystem → 好感度（数值随互动增长，BonusActive 是加成阈值）
   */
  setupControllers(settings: any) {
    const controllers = settings?.Controllers ?? {};
    this.controllers = controllers;
    const mouse = controllers.MouseTracking;
    this.mouseTracking =
      mouse && mouse.Enabled !== false && Array.isArray(mouse.Items) && mouse.Items.length > 0 ? mouse : null;
    this.smoothedFocus = { x: 0, y: 0 };
    this.paramHitValues = new Map();
    this.paramTriggerFired = new Map();
    this.pendingTriggers = [] as any[];
    this.paramTriggers = (controllers.ParamTrigger?.Items ?? []).filter((item: any) => item?.Id && Array.isArray(item.Items));
    const keys = controllers.KeyTrigger;
    this.keyTriggers =
      keys && keys.Enabled !== false && Array.isArray(keys.Items)
        ? keys.Items.filter((item: any) => item && item.Input !== undefined && (item.DownMtn || item.UpMtn))
        : [];
    this.intimacy = null;
    const intimacy = controllers.IntimacySystem;
    if (intimacy && intimacy.Enabled !== false && Number.isFinite(Number(intimacy.MaxValue))) {
      this.intimacy = {
        max: Number(intimacy.MaxValue),
        bonusActive: Number.isFinite(Number(intimacy.BonusActive)) ? Number(intimacy.BonusActive) : 0,
        value: 0,
      };
    }

    /* 以下三类控制器在真包里被使用过，而且原版对它们各有一个 C*Controller 类
       （名字来自解包 APK 的 global-metadata.dat 词汇表）：
         ArtmeshOpacity → 强制若干 artmesh 的不透明度（例：ZB26 的 gun、不挠的黑边矩形）
         PartOpacity    → 强制若干 part 的不透明度（例：关岛魔改的"前景/绳子/背景"）
         ParamLoop      → 让参数在两个值之间循环（例：苏维埃同盟的 xiong/pigu 晃动）
       setupControllers 在模型加载之后调用，所以这里能直接解析下标。 */
    const core = this.model?.internalModel?.coreModel;
    this.artmeshOpacity = null;
    const artmesh = controllers.ArtmeshOpacity;
    if (artmesh && artmesh.Enabled !== false && Array.isArray(artmesh.Items)) {
      const items = [] as any[];
      for (const item of artmesh.Items) {
        if (!Number.isFinite(Number(item?.Value))) continue;
        for (const id of item.Ids ?? []) {
          const index = core?.getDrawableIndex ? core.getDrawableIndex(String(id)) : -1;
          if (index >= 0) items.push({ index, id: String(id), value: Number(item.Value), name: item.Name });
        }
      }
      if (items.length > 0) this.artmeshOpacity = items;
    }
    this.partOpacity = null;
    const part = controllers.PartOpacity;
    if (part && part.Enabled !== false && Array.isArray(part.Items)) {
      const items = [] as any[];
      for (const item of part.Items) {
        const value = Number.isFinite(Number(item?.Value)) ? Number(item.Value) : 1;
        for (const id of item.Ids ?? []) {
          const index = core?.getPartIndex ? core.getPartIndex(String(id)) : -1;
          if (index >= 0) items.push({ index, value, name: item.Name });
        }
      }
      if (items.length > 0) this.partOpacity = items;
    }
    this.paramLoops = null;
    const loops = controllers.ParamLoop;
    if (loops && loops.Enabled !== false && Array.isArray(loops.Items)) {
      const items = [] as any[];
      for (const item of loops.Items) {
        const duration = Number(item?.Duration);
        const min = Number(item?.MinValue);
        const max = Number(item?.MaxValue);
        if (!Number.isFinite(duration) || duration <= 0) continue;
        if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
        for (const id of item.Ids ?? []) {
          const index = core?.getParameterIndex ? core.getParameterIndex(String(id)) : -1;
          if (index >= 0) items.push({ id: String(id), duration, min, max, name: item.Name });
        }
      }
      if (items.length > 0) this.paramLoops = items;
    }

    /* 自动呼吸（原版有 CAutoBreathController，多数包都写 Enabled:true）。
       pixi-live2d-display 不自带呼吸，所以待机时胸口/身体是"死"的 —— 原版有轻微起伏。
       Cubism 官方 SDK 的 CubismBreath 默认周期 3.2345 秒、幅度 0~1，这里按同一套参数驱动
       ParamBreath（模型里没有这个参数就自动跳过）。 */
    this.breath = null;
    const breathSetting = controllers.AutoBreath;
    if (breathSetting?.Enabled !== false) {
      const index = core?.getParameterIndex ? core.getParameterIndex('ParamBreath') : -1;
      if (index >= 0) {
        this.breath = { id: 'ParamBreath', index, periodMs: 3234.5, elapsed: 0 };
      }
    }
  }

  /**
   * 按键触发：返回该键在该阶段（down/up）要播的动作引用，没有就返回 null。
   * `Input` 是原版记录的键码（与 KeyboardEvent.keyCode 同一套）。
   */
  keyTriggerFor(code: any, phase = 'down') {
    if (!this.keyTriggers?.length) return null;
    const item = this.keyTriggers.find((entry: any) => Number(entry.Input) === Number(code));
    if (!item) return null;
    return (phase === 'up' ? item.UpMtn : item.DownMtn) ?? null;
  }

  /** 播放某个动作组的第一个动作（点击区域 / 参数触发 / NextMtn 跳转都用它） */
  playGroup(group: any) {
    const entry = this.firstMotionOfGroup(group);
    if (!entry?.info) return false;
    if (entry.info.command || entry.info.choices) return false; // 命令型由上层处理
    return this.playMotion(group, entry.info.listIndex);
  }

  /**
   * 找到某个命中区域上绑定的"拖拽把手"。
   *
   * Controllers.ParamHit 的每一条按官方文档有三种 Type：
   *   0 拖拽（默认）—— 参数随鼠标**位移**改变，每像素变化 Factor
   *   1 抚摸        —— 参数随鼠标**移动距离**累加（来回移动也累加）
   *   2 按压        —— 按住时每秒变化 Factor
   * 触发动作：BeginMtn 开始拖拽时；MinMtn/MaxMtn 拖到参数最小/最大值时；
   * EndMtn 松手时参数**没**到极值才触发（官方文档原文）。
   */
  dragHandlesAt(hitName: any) {
    if (!hitName) return [];
    // `param_hit disable 头纱,裙纸` 这类命令停用的把手在这里被排除
    return (this.controllers?.ParamHit?.Items ?? []).filter(
      (item: any) =>
        item?.Id &&
        item.HitArea === hitName &&
        !this.disabledParamHits.has(String(item.Name ?? '')) &&
        !this.disabledParamHits.has(String(item.Id ?? '')),
    );
  }

  /** 开始拖拽：记下每个把手的起点与当时的参数值，并触发 BeginMtn */
  beginDrag(cssX: any, cssY: any, hitName: any) {
    const handles = this.dragHandlesAt(hitName);
    if (handles.length === 0) return false;
    const core = this.model?.internalModel?.coreModel;
    this.drag = {
      startX: cssX,
      startY: cssY,
      x: cssX,
      y: cssY,
      elapsed: 0,
      hitName,
      fired: new Set(),
      handles: handles.map((item: any) => {
        const index = core?.getParameterIndex?.(item.Id) ?? -1;
        const min = index >= 0 ? core.getParameterMinimumValue(index) : Number.isFinite(item.Min) ? item.Min : 0;
        const max = index >= 0 ? core.getParameterMaximumValue(index) : Number.isFinite(item.Max) ? item.Max : 1;
        let value = 0;
        try {
          value = Number(core?.getParameterValueById(item.Id)) || 0;
        } catch {
          value = 0;
        }
        return { item, min, max, startValue: value, value, distance: 0 };
      }),
    };
    this.pendingTriggers.push(...handles.filter((item: any) => item.BeginMtn).map((item: any) => item.BeginMtn));
    return true;
  }

  /** 每帧推进"按压"类型（按秒增加参数） */
  dragTick(deltaSeconds: any) {
    if (!this.drag) return [];
    this.drag.elapsed += deltaSeconds;
    // 只有"按压"型（Type 2）把手需要按时间推进；其余由 dragTo 驱动。
    // 返回的 MinMtn/MaxMtn 由调用方交给触发队列 —— 以前这里直接 return，
    // 拖到极值的落点动作就被丢掉了。
    if (!this.drag.handles.some((handle: any) => handle.item.Type === 2)) return [];
    return this.applyDragValues() ?? [];
  }

  /** 拖拽中：按类型改参数，到边界触发 MinMtn / MaxMtn */
  dragTo(cssX: any, cssY: any) {
    if (!this.drag) return [];
    const dx = cssX - this.drag.x;
    const dy = cssY - this.drag.y;
    this.drag.x = cssX;
    this.drag.y = cssY;
    for (const handle of this.drag.handles) {
      // 抚摸按"移动距离"累加，所以两个方向都算正
      if (handle.item.Type === 1) handle.distance += Math.abs(dx) + Math.abs(dy);
    }
    return this.applyDragValues();
  }

  /**
   * 把把手的当前值同步到"参数锁定目标"和"点击累计值"这两本账上（拖动中与松手时共用）。
   *
   * 拖动必须能改掉参数锁定：包里是这么配合的 —— init 先
   * `parameters lock CD_wa $CD_wa 300` 把参数钉在档位上，而把手本身又标了
   * LockParam（"停在这个值上"）。锁定的优先级高于拖动，不跟着改的话用户拖滑块
   * 完全没反应（实测就是这个问题）。LockParam 为真时还要把值记进 paramHitValues，
   * 否则松手后它会被动作曲线带走。
   */
  syncHandleValue(handle: any) {
    const { item, value } = handle;
    if (this.lockedParameters.has(item.Id)) this.lockedParameters.set(item.Id, value);
    if (item.LockParam === true) this.paramHitValues.set(item.Id, value);
    else this.paramHitValues.delete(item.Id);
  }

  /** 按当前指针位置算出各个把手的参数值并写回，返回需要播放的触发动作 */
  applyDragValues() {
    const triggered = [] as any[];
    const core = this.model?.internalModel?.coreModel;
    if (!this.drag || !core) return triggered;
    for (const handle of this.drag.handles) {
      const { item, min, max, startValue } = handle;
      const factor = Number.isFinite(item.Factor) ? item.Factor : 0.01;
      let delta;
      if (item.Type === 1) delta = handle.distance;
      else if (item.Type === 2) delta = this.drag.elapsed;
      // 方向按原版：竖直方向往下拖是正、水平方向往右拖是正
      //（正负最终由包里 Factor 的符号决定，所以这里错了整体都会反过来）
      else delta = item.Axis === 1 ? this.drag.y - this.drag.startY : this.drag.x - this.drag.startX;

      const value = clamp(startValue + delta * factor, Math.min(min, max), Math.max(min, max));
      handle.value = value;
      this.writeParameter(item.Id, value);
      this.syncHandleValue(handle);

      // MinMtn / MaxMtn：拖到该参数的极值时触发一次
      const atMin = Math.abs(value - min) < 1e-6;
      const atMax = Math.abs(value - max) < 1e-6;
      const target = atMax ? item.MaxMtn : atMin ? item.MinMtn : null;
      if (target && !this.drag.fired.has(item.Id)) {
        this.drag.fired.add(item.Id);
        triggered.push(target);
      }
    }
    return triggered;
  }

  /**
   * 结束拖拽。
   * 官方语义：EndMtn 是"松手时参数还没到极值"才触发；
   * LockParam 为真的保持当前值，否则在 Release 毫秒内缓回**拖动前**的值。
   */
  endDrag() {
    if (!this.drag) return [];
    const triggered = [] as any[];
    for (const handle of this.drag.handles) {
      const { item, min, max, value, startValue } = handle;
      const atMin = Math.abs(value - min) < 1e-6;
      const atMax = Math.abs(value - max) < 1e-6;
      if (item.EndMtn && !atMin && !atMax) triggered.push(item.EndMtn);
      if (item.LockParam === true) {
        // 同 applyDragValues：锁定目标跟着拖动值走，否则松手后又被锁回旧值
        this.syncHandleValue(handle);
        continue;
      }
      /* 非 LockParam 的把手：这里**只**清累计值，不动锁定目标 —— 与 applyDragValues 的这处
         差别是有意的（拖动期间锁定目标已经跟着更新过），紧接着按 Release 缓回拖动前的值。 */
      this.paramHitValues.delete(item.Id);
      const durationMs = Number.isFinite(item.Release) ? item.Release : 100;
      if (durationMs > 0 && Math.abs(value - startValue) > 1e-6) {
        this.releases.set(item.Id, {
          from: value,
          to: startValue,
          startMs: this.elapsedMs,
          durationMs,
          // 0 线性 / 1 减速 / 2 加速 / 3 缓入缓出
          type: Number.isFinite(item.ReleaseType) ? item.ReleaseType : 0,
        });
      }
    }
    this.drag = null;
    /* 返回值由上层播放（app.js 的 pointerup 会挨个 playCubismReference）。
       这里不要再塞进 pendingTriggers，否则会和上层的播放重复一次。 */
    return triggered;
  }

  /** 当前是否正在拖拽 */
  get dragging() {
    return Boolean(this.drag);
  }

  /** 松手后的缓回：把参数从拖动值按 Release/ReleaseType 插值回拖动前的值 */
  applyReleases() {
    if (this.releases.size === 0) return;
    const core = this.model?.internalModel?.coreModel;
    if (!core?.setParameterValueById) return;
    for (const [id, release] of [...this.releases]) {
      const t = release.durationMs > 0 ? (this.elapsedMs - release.startMs) / release.durationMs : 1;
      if (t >= 1) {
        this.writeParameter(id, release.to);
        this.releases.delete(id);
        continue;
      }
      const eased =
        release.type === 1 ? 1 - (1 - t) * (1 - t) : release.type === 2 ? t * t : release.type === 3 ? t * t * (3 - 2 * t) : t;
      this.writeParameter(id, release.from + (release.to - release.from) * eased);
    }
  }

  /** 参数到达配置值 → 触发动作（ParamTrigger） */
  checkParamTriggers() {
    const core = this.model?.internalModel?.coreModel;
    if (!core?.getParameterValueById) return;
    for (let i = 0; i < this.paramTriggers.length; i++) {
      const trigger = this.paramTriggers[i];
      let value;
      try {
        value = Number(core.getParameterValueById(trigger.Id));
      } catch {
        continue;
      }
      for (const entry of trigger.Items ?? []) {
        const wanted = Number(entry?.Value);
        const hit = Number.isFinite(wanted) && Math.abs(value - wanted) < 0.01;
        const key = `${i}:${wanted}:${entry?.Motion ?? ''}`;
        if (hit && !this.paramTriggerFired.get(key)) {
          this.paramTriggerFired.set(key, true);
          if (entry?.Motion) this.pendingTriggers.push(entry.Motion);
        } else if (!hit) {
          this.paramTriggerFired.set(key, false);
        }
      }
    }
  }

  /**
   * 这个画布坐标是否落在**模型自身范围**内（模型坐标 0..modelWidth / 0..modelHeight）。
   *
   * 注意不能用 hitTestDrawable 判断"按在模型上"：那套只认包里的 Touch* 命中代理，
   * 按在角色的衣服、头发这些可见 mesh 上是查不到的。拖动反应需要前者。
   */
  containsPoint(cssX: any, cssY: any) {
    const width = this.modelWidth();
    const height = this.modelHeight();
    if (!(width > 0) || !(height > 0) || !(this.view.scale > 0)) return false;
    const modelX = (cssX - this.view.offsetX) / this.view.scale;
    const modelY = (cssY - this.view.offsetY) / this.view.scale;
    // 留一点点余量：边缘按下也算（原版对边缘同样响应）
    const slackX = width * 0.02;
    const slackY = height * 0.02;
    return (
      modelX >= -slackX && modelX <= width + slackX && modelY >= -slackY && modelY <= height + slackY
    );
  }

  /*
   * 关于那批"模型框之外"的隐藏代理区域（TouchIdle / TouchDrag 等）：
   *
   * 实测（【碧蓝航线】不挠）：69 个区域里 53 个指向 touch_idle / touch_drag，它们对应的
   * drawable 被作者放在模型框之外（模型坐标 y≈44000~59000，而模型自身只有 8000 高），
   * 因此"触摸模型"永远命中不到它们 —— 对整块画布做 21×21 网格命中测试也只能命中
   * 6 个 drawable（TouchIdle1 / TouchDrag20 / TouchHead / TouchSpecial / TouchBody / Menu）。
   *
   * 曾经据此按"触摸类型"随机播一段（点→touch_idle、拖→touch_drag），但对照原版截图确认那是错的：
   *   - 原版点空白处、拖动画面都不会随机播动作（拖动在原版里是"拖拽移动"模型）；
   *   - 那些区域是通过**包自己的状态机**触发的：init 条目初始化变量、把参数锁到变量值上，
   *     各区域的动作再按变量条件（varFloats）挑选变体 —— 面板、换装都建立在这上面。
   * 所以这里不再提供随机触摸反应，交互一律走 HitAreas 命名区域 + 包内状态机。
   */

  /**
   * 光标追踪。
   *
   * 不用 pixi 的 `model.focus(x, y)`：它把光标方向归一化成单位向量再交给
   * focusController，结果无论光标离模型多远，注视幅度都是满格（看起来就是"位置不对"）。
   * 这里按"光标相对模型中心"的比例给 -1..1，交给框架的 focusController 做平滑与参数映射，
   * 与原版一样是渐进的。
   */
  focus(cssX: any, cssY: any) {
    const internal = this.model?.internalModel;
    if (!internal) return;
    const modelWidth = this.modelWidth() * this.view.scale;
    const modelHeight = this.modelHeight() * this.view.scale;
    if (!(modelWidth > 0) || !(modelHeight > 0)) return;
    const centerX = this.view.offsetX + modelWidth / 2;
    const centerY = this.view.offsetY + modelHeight / 2;
    const nx = clamp((cssX - centerX) / (modelWidth / 2), -1, 1);
    // 画布 y 轴向下，Cubism 的注视参数是 y 轴向上，所以取负
    const ny = clamp(-(cssY - centerY) / (modelHeight / 2), -1, 1);
    this.focusTarget = { x: nx, y: ny };
    // 包里没有 MouseTracking 配置时，退回框架自带的注视控制
    if (!this.mouseTracking) internal.focusController?.focus(nx, ny);
  }

  /** 光标离开画布（或关掉跟随时）回到正前方 */
  clearFocus() {
    this.focusTarget = null;
    this.smoothedFocus = { x: 0, y: 0 };
    this.model?.internalModel?.focusController?.focus(0, 0);
  }

  /** 开关光标追踪：关掉时连同参数一起复位（不再覆写该参数，交回模型自己的动作/物理） */
  setTrackingEnabled(enabled: any) {
    const wasEnabled = this.trackingEnabled;
    this.trackingEnabled = Boolean(enabled);
    if (!this.trackingEnabled) {
      this.clearFocus();
      if (wasEnabled) this.resetTrackingParameters();
    }
  }

  /** 把被追踪的参数写回中间值，避免关掉跟随后停在最后一次的注视位置 */
  resetTrackingParameters() {
    const core = this.model?.internalModel?.coreModel;
    if (!core?.setParameterValueById || !this.mouseTracking) return;
    for (const item of this.mouseTracking.Items) {
      if (!item?.Id) continue;
      const min = Number.isFinite(item.Min) ? item.Min : -1;
      const max = Number.isFinite(item.Max) ? item.Max : 1;
      try {
        core.setParameterValueById(item.Id, min + (max - min) / 2);
      } catch {
        /* 参数不存在就跳过 */
      }
    }
  }

  /** 跟随幅度（0.1~1.5 倍） */
  setTrackingGain(gain: any) {
    const value = Number(gain);
    this.trackingGain = Number.isFinite(value) ? clamp(value, 0.05, 3) : 0.5;
  }

  setExpression(indexOrName: any) {
    if (!this.model) return false;
    return this.model.expression(indexOrName) !== false;
  }

  /**
   * 唯一的时钟入口：由界面的渲染循环每帧调用一次。
   * @param {number} deltaSeconds 距上一帧的秒数
   */
  update(deltaSeconds: any) {
    const internal = this.model?.internalModel;
    if (!internal) return;
    // 钳制单帧步进：切标签页、卡顿之后不要把动画一次性推很远（那看起来就是"跳帧/重播"）
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.05);
    this.lastDelta = dt;
    this.elapsedMs += dt * 1000;
    internal.update(dt * 1000, this.elapsedMs);
    /* 更新**之后**再写一次纯值：动作曲线是在 internal.update 里被应用的，会覆盖我们
       在更新前写下的值。实测分界线非常干净 —— 同一份代码里
         Axis=1（参数不由动作曲线驱动）的把手全部通过，
         Axis=0（参数被待机动作驱动）的把手全部读到 0.000。
       写在更新之后，画出来的就是我们的值（这才是"拖动可见"的必要条件）。
       只调用纯写入，不推进任何计时器，所以不会像"整体挪进 core.update"那样把呼吸推两次。 */
    try {
      this.writeOverridesLast();
    } catch {
      /* 写不进去不影响这一帧 */
    }
    // 一次性动作播完后接回**固定**的那条待机（不是随机换一条）
    this.ensureIdleMotion();
  }

  setShowDebug() {
    /* Cubism 侧没有骨骼调试渲染，保留接口 */
  }

  /**
   * 命中测试：用**包清单里**的点击区域（model3.json 的 HitAreas）做矩形判断。
   *
   * 为什么不用框架自带的 hitTest：框架返回的是 moc3 里那些 HitArea drawable（id 形如 ArtMesh266），
   * 而包里 HitAreas 的 Id 与它们不是同一套（一个给 ParamHit 用、一个给"点这里放什么动作"用），
   * 于是框架的命中结果根本对不上包里的 motion 映射。这里自己按包围盒判断，和 Spine 侧一致。
   * @returns {object|null} 命中的区域（带 motion 字段）
   */
  hitTest(cssX: any, cssY: any, hitAreas: any) {
    // 包里的 `hit_areas disable`（"锁定触摸"）生效时，矩形命中也要一起关掉
    if (!this.hitAreasEnabled) return null;
    const internal = this.model?.internalModel;
    if (!internal?.getDrawableBounds) return null;
    const modelX = (cssX - this.view.offsetX) / this.view.scale;
    const modelY = (cssY - this.view.offsetY) / this.view.scale;
    let best = null;
    let bestArea = Infinity;
    for (const area of this.usableAreas(hitAreas)) {
      const rect = this.hitAreaRect(area);
      if (!rect) continue;
      if (
        modelX >= rect.modelX &&
        modelX <= rect.modelX + rect.modelWidth &&
        modelY >= rect.modelY &&
        modelY <= rect.modelY + rect.modelHeight
      ) {
        const size = rect.modelWidth * rect.modelHeight;
        if (size < bestArea) {
          bestArea = size;
          best = area;
        }
      }
    }
    return best;
  }

  /** 框架自己的命中测试（moc3 的 HitArea drawable），ParamHit 用的是这一套 id */
  hitTestDrawable(cssX: any, cssY: any) {
    // 包里的 `hit_areas disable`（"锁定触摸"）生效时，任何区域都不该命中
    if (!this.hitAreasEnabled) return null;
    const internal = this.model?.internalModel;
    if (!internal?.hitTest) return null;
    const modelX = (cssX - this.view.offsetX) / this.view.scale;
    const modelY = (cssY - this.view.offsetY) / this.view.scale;
    const names = internal.hitTest(modelX, modelY);
    return Array.isArray(names) && names.length > 0 ? names[0] : null;
  }

  /** 一个点击区域的矩形：模型坐标 + 画布坐标 */
  hitAreaRect(area: any) {
    const internal = this.model?.internalModel;
    const core = internal?.coreModel;
    if (!internal?.getDrawableBounds || !core || !area?.bone) return null;
    let index = -1;
    try {
      index = core.getDrawableIndex(area.bone);
    } catch {
      index = -1;
    }
    if (index < 0) return null;
    let bounds;
    try {
      bounds = internal.getDrawableBounds(index);
    } catch {
      return null;
    }
    if (!bounds) return null;
    const scale = this.view.scale;
    return {
      name: area.name ?? area.bone,
      modelX: bounds.x,
      modelY: bounds.y,
      modelWidth: bounds.width,
      modelHeight: bounds.height,
      x: this.view.offsetX + bounds.x * scale,
      y: this.view.offsetY + bounds.y * scale,
      width: bounds.width * scale,
      height: bounds.height * scale,
    };
  }

  /** 当前所有点击区域的画布矩形（"可触发区域"叠加层用） */
  hitAreaRects(hitAreas: any) {
    const out = [] as any[];
    for (const area of this.usableAreas(hitAreas)) {
      const rect = this.hitAreaRect(area);
      // 只丢掉退化（宽高为 0）的，不能按画布像素大小过滤：
      // Cubism 模型的坐标系很大（几万单位），缩放后几十像素的区域算出来可能远小于 1px
      if (rect && rect.modelWidth > 0 && rect.modelHeight > 0) out.push(rect);
    }
    return out;
  }

  /** 当前模型自带的点击区域（model3.json 的 HitAreas） */
  currentHitAreas() {
    const areas = this.settings?.HitAreas;
    if (!Array.isArray(areas)) return [];
    return areas
      .map((area: any, index: any) => ({
        name: area?.Name ?? `area_${index}`,
        bone: area?.Id ?? '',
        motion: area?.Motion ?? null,
      }))
      .filter((area: any) => area.bone);
  }

  /**
   * 过滤出"当前模型里真的存在"的点击区域。
   *
   * `change_model` 换过模型之后，调用方（界面）手里的区域清单属于**旧模型**，
   * 里面的 drawable 在新模型里根本不存在 —— 这时退回当前模型自己的 HitAreas，
   * 否则换模型后点击区域与"可触发区域"红框会全部失效。
   */
  usableAreas(hitAreas: any) {
    const internal = this.model?.internalModel;
    if (!internal?.getDrawableBounds) return [];
    const exists = (list: any) =>
      (list ?? []).filter((area: any) => {
        if (!area?.bone) return false;
        try {
          return internal.coreModel.getDrawableIndex(area.bone) >= 0;
        } catch {
          return false;
        }
      });
    const given = exists(hitAreas);
    return given.length > 0 ? given : exists(this.currentHitAreas());
  }

  render() {
    /* PIXI 自己在 ticker 里渲染，这里只保证尺寸正确（同样按容器量，见 resize 的说明） */
    if (!this.app) return;
    const host = this.canvas.parentElement ?? this.canvas;
    const width = Math.round(host.clientWidth);
    const height = Math.round(host.clientHeight);
    if (width < 2 || height < 2) return;
    const resolution = this.app.renderer.resolution || 1;
    if (
      Math.abs(this.app.renderer.width / resolution - width) > 1 ||
      Math.abs(this.app.renderer.height / resolution - height) > 1
    ) {
      this.resize();
    }
  }

  /** 只清掉当前模型（PIXI app 与 WebGL 上下文保留） */
  dropModel() {
    if (this.postCommandTimer !== null) {
      clearTimeout(this.postCommandTimer);
      this.postCommandTimer = null;
    }
    if (!this.model) return;
    try {
      this.app?.stage.removeChild(this.model);
      this.model.destroy({ children: true });
    } catch {
      /* 忽略 */
    }
    this.model = null;
    this.currentMotion = null;
  }

  /** 彻底销毁（含 PIXI app），之后需要新建播放器实例 */
  destroy() {
    this.dropModel();
    if (this.app) {
      try {
        this.app.destroy(false, { children: true });
      } catch {
        /* 忽略 */
      }
      this.app = null;
    }
  }
}
