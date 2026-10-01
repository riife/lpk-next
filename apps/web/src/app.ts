
/** 取元素；不存在就抛错（错误里带 id，比运行到一半才炸清楚得多） */
function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少元素 #${id}`);
  return node;
}

/** 同上，但用于需要 value 的表单控件（input 与 select 都有 value） */
function input(id: string): HTMLInputElement | HTMLSelectElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLSelectElement)) {
    throw new Error(`页面缺少表单控件 #${id}`);
  }
  return node;
}

/** 复选框：只有它才有 checked（用 input() 会丢类型） */
function checkbox(id: string): HTMLInputElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLInputElement) || node.type !== 'checkbox') {
    throw new Error(`页面缺少复选框 #${id}`);
  }
  return node;
}

/** 对话框 / 抽屉：showModal 只在 HTMLDialogElement 上有 */
function dialog(id: string): HTMLDialogElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLDialogElement)) throw new Error(`页面缺少对话框 #${id}`);
  return node;
}

/**
 * 用组件库的对话框做二次确认（`sheerly-dialog`），替代 `window.confirm`：
 * 原生弹窗的样式与主题都跟不上，文案也不能自定义。
 *
 * 返回 Promise<boolean>：确认 true；取消、按 Esc、点遮罩都算 false。
 */
function askConfirm(options: {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  const box = dialog('confirmDialog');
  document.getElementById('confirmDialogTitle')!.textContent = options.title;
  document.getElementById('confirmDialogText')!.textContent = options.description ?? '';
  const ok = document.getElementById('confirmDialogOk') as HTMLButtonElement;
  const cancel = document.getElementById('confirmDialogCancel') as HTMLButtonElement;
  ok.textContent = options.confirmText ?? '确定';
  cancel.textContent = options.cancelText ?? '取消';

  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      box.removeEventListener('close', onClose);
      if (box.open) box.close();
      resolve(value);
    };
    const onOk = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onClose = (): void => finish(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    box.addEventListener('close', onClose);
    box.showModal();
  });
}
/**
 * lpk-next 播放器前端
 * 数据来自解包产物 manifest.json（服务器模式）或用户拖入的本地目录（本地模式）
 */
import './style.css';
import { MemoryIO, unpackLpk } from '@lpk/unpacker';
import { SpinePlayer } from './player';
import { CubismPlayer } from './cubism';
import { VariableStore, pickVariant } from './variables';
import { findInteraction, interactionAvailable, pickIdle, planInteraction } from './live2dex';
import { createGallery } from './gallery';
import { VoicePlayer } from './audio';
import { detectMode, deletePackage, findLpkFile, loadPackageIndex, unpackOnServer, type RunMode } from './net';
import { buildZip, collectPacks, downloadBlob, type PackJob } from './pack-download';
import {
  FolderSource,
  MemorySource,
  UrlSource,
  describeFileSet,
  detectCharacterFromFolder,
  readManifestFromFileSet,
} from './sources';

const dom = {
  canvas: el('stage'),
  cubismCanvas: el('stage-cubism'),
  packageSelect: input('packageSelect'),
  characterSelect: input('characterSelect'),
  characterCount: el('characterCount'),
  textureSetCount: el('textureSetCount'),
  animationCount: el('animationCount'),
  interactionCount: el('interactionCount'),
  soundCount: el('soundCount'),
  expressionCount: el('expressionCount'),
  textureSetPanel: el('textureSetPanel'),
  textureSetList: el('textureSetList'),
  animationList: el('animationList'),
  expressionPanel: el('expressionPanel'),
  expressionList: el('expressionList'),
  choiceBox: el('choiceBox'),
  followCursorMode: input('followCursorMode'),
  followGain: input('followGain'),
  followGainValue: el('followGainValue'),
  interactionList: el('interactionList'),
  soundList: el('soundList'),
  meta: el('meta'),
  status: el('status'),
  statusText: el('statusText'),
  hud: el('hud'),
  hitAreaLayer: el('hitAreaLayer'),
  choiceMenu: el('choiceMenu'),
  viewport: document.querySelector('.viewport') as HTMLElement,
  galleryGrid: el('galleryGrid'),
  gallerySearch: input('gallerySearch'),
  galleryKind: input('galleryKind'),
  gallerySummary: el('gallerySummary'),
  galleryEmpty: el('galleryEmpty'),
  galleryWelcome: el('galleryWelcome'),
  galleryDrop: el('galleryDrop'),
  lpkInput: el('lpkInput') as HTMLInputElement,
  pickLpk: el('pickLpk'),
  pickFolder: el('pickFolder'),
  openZipPage: el('openZipPage'),
  zipPage: el('zipPage'),
  zipDrop: el('zipDrop'),
  zipSummary: el('zipSummary'),
  zipLog: el('zipLog'),
  zipBack: el('zipBack'),
  zipStart: el('zipStart') as HTMLButtonElement,
  zipPickFolder: el('zipPickFolder'),
  zipPickFiles: el('zipPickFiles'),
  zipFolderInput: el('zipFolderInput') as HTMLInputElement,
  zipFileInput: el('zipFileInput') as HTMLInputElement,
  backToGallery: el('backToGallery'),
  areaBar: el('areaBar'),
  areaToggle: el('areaToggle'),
  areaCount: el('areaCount'),
  areaSheet: dialog('areaSheet'),
  navToggle: el('navToggle'),
  navBackdrop: el('navBackdrop'),
  showHitAreas: checkbox('showHitAreas'),
  speed: input('speed'),
  speedValue: el('speedValue'),
  autoIdle: checkbox('autoIdle'),
  showDebug: checkbox('showDebug'),
  resetView: el('resetView'),
  folderInput: input('folderInput'),
  dropZone: el('dropZone'),
  playIdle: el('playIdle'),
  stopAll: el('stopAll'),
};

/**
 * 静态模式下"删掉了什么"只能记在内存里：
 *   * 构建期的包来自 packages.json，删了以后重新拉还会回来 —— 所以记住 id 并过滤掉；
 *   * 浏览器内解包的包本来就不在 packages.json 里，重新拉会丢 —— 所以记住这条，重新拉时补回去。
 * 两种模式对外表现一致：删了就消失。
 */
const hiddenPackages = new Set<string>();
let localPackageEntry: any = null;

/** 列表来源：服务器模式走 /api，静态模式走构建期 JSON；两种模式都套上上面的"已删除"记忆 */
async function loadIndexForUi(): Promise<{ packages: any[] }> {
  const index = await loadPackageIndex(state.mode);
  const entries = (index.packages ?? []).filter((item: any) => !hiddenPackages.has(item.id));
  if (localPackageEntry && !hiddenPackages.has(localPackageEntry.id)) entries.unshift(localPackageEntry);
  return { ...index, packages: entries };
}

/** 浏览器内解包的"包 id"：它只存在于内存里，没有真实目录 */
const LOCAL_PACKAGE_ID = 'local';

/** 打包下载页的路由 id（非数字，与真实包 id 不会撞） */
const ZIP_PAGE_ID = 'zip';

/**
 * 应用状态。
 *
 * 刻意留了 `[key: string]: any` 索引签名：这个对象是前端的"全局黑板"，
 * 被各处读写（含调试与自动化），先让它能用；关键字段（player/spine/cubism 等）
 * 后续按模块逐步收紧类型。
 * 有显式类型之后，`state.player` 这类访问不再被推成 `null`/`never` 而处处报错。
 */
interface AppState {
  player: any;
  spine: any;
  cubism: any;
  packageId: string | null;
  manifest: any;
  character: any;
  packages: any[];
  animations: any[];
  cubismMotions: any[];
  interactions: any[];
  [key: string]: any;
}

const state: AppState = {
  player: null, // 当前生效的播放器（SpinePlayer 或 CubismPlayer）
  spine: null,
  cubism: null,
  playerKind: null,
  packages: [],
  packageId: null,
  manifest: null,
  source: null,
  character: null,
  characterIndex: 0,
  textureSet: 0,
  animations: [],
  cubismMotions: [],
  /** 运行时 model3.json 里每个动作的 Name（解析 `组:条目` 引用用） */
  cubismMotionNames: {},
  interactions: [],
  speed: 1,
  /** 语音播放器（见 audio.js） */
  voice: new VoicePlayer({ onStatus: (message: any, isError: any) => setStatus(message, isError) }),
  /** 包里的变量（var_floats），用于皮肤/服装这类状态机 */
  variables: new VariableStore(),
  /** 一次性动作播完后的行为：'idle'（回待机，默认）或 'hold'（停在最后一帧） */
  afterInteraction: 'idle',
  /** 是否叠加显示可触发区域（红框） */
  showHitAreas: false,
  hitAreaSignature: '',
  /** 画布外触发区按钮栏的内容签名（只有变化时才动 DOM） */
  areaBarSignature: '',
  /** 是否正在拖拽参数（原版的"拖裙子/拖丝袜"） */
  dragActive: false,
  /** 刚刚因为 light dismiss 关掉了选项面板（这一下点击不要再触发互动） */
  dismissedAt: 0,
  /** 当前按在画布上的指针（支持双指缩放） */
  pointers: new Map(),
  pinchDistance: 0,
  /** "按住鼠标才跟随"模式下，鼠标是否正按着 */
  following: false,
  lastFrame: 0,
  lastHud: '',
  pointer: null,
  error: null,
};

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function boot() {
  try {
    state.spine = new SpinePlayer(dom.canvas);
    state.cubism = new CubismPlayer(dom.cubismCanvas);
    state.player = state.spine;
    state.playerKind = 'spine';
  } catch (error: any) {
    setStatus(`播放器初始化失败：${error.message}`, true);
    return;
  }
  wireEvents();
  applyFollowMode();
  applyThemeToPlayers(); // 按当前主题设置画布清屏色
  state.cubism.setTrackingGain(Number(dom.followGain.value));
  dom.followGainValue.textContent = `${Number(dom.followGain.value).toFixed(2)}×`;
  requestAnimationFrame(renderLoop);
  setupGallery();
  /* 先探测运行模式：/api/health 有响应就是服务器模式，否则静态模式。
     后端必须本机运行，所以给 300ms 超时就够（见 net.ts）。 */
  state.mode = await detectMode();
  state.modeReady = true;
  document.body.dataset.mode = state.mode;
  // 包列表就绪后再按路由决定进首页还是播放页（选择目标要查 state.packages）
  await loadPackageList();
  applyRoute();
  window.addEventListener('hashchange', applyRoute);
  setupBatteryVariables();
  // 自动化排查用：把内部状态和几个入口挂出来（只是引用，不改变任何行为）
  window.lpk = {
    state,
    playAnimation,
    runInteraction,
    playSound,
    stopAudio,
    selectCharacter,
    selectPackage,
    handleCanvasClick,
    playCubismMotion,
    playCubismGroup,
    playCubismReference,
    resolveCubismTarget,
    areaMotionRef,
    pickStartMotion,
    showChoices,
    applyRoute,
    setupBatteryVariables,
  };
}

/**
 * 电量变量（原版的 Battery 控制器）。
 *
 * 解包 APK 的 global-metadata.dat 里能看到这两个变量名：`sys_battery_level` / `sys_battery_status`
 * —— 原版是把电量暴露成**变量**给包的 varFloats 用，而不是一个参数。
 *
 * 取值约定（跟原版一致的部分是名字；数值按 Android BatteryManager 的语义来，
 * 因为原版是 Android 应用）：
 *   sys_battery_level  —— 0~100 的整数百分比
 *   sys_battery_status —— 1 UNKNOWN / 2 CHARGING / 3 DISCHARGING / 4 NOT_CHARGING / 5 FULL
 */
function setupBatteryVariables() {
  const store = state.variables;
  if (!store?.set) return;
  const apply = (battery: any) => {
    if (!battery) return;
    const level = Math.round(Number(battery.level) * 100);
    const charging = Boolean(battery.charging);
    const full = charging && Number(battery.level) >= 0.999;
    const status = full ? 5 : charging ? 2 : 3;
    store.set('sys_battery_level', level);
    store.set('sys_battery_status', status);
  };
  try {
    const pending = (navigator as any).getBattery?.();
    if (!pending?.then) return;
    pending
      .then((battery: any) => {
        apply(battery);
        battery.addEventListener?.('levelchange', () => apply(battery));
        battery.addEventListener?.('chargingchange', () => apply(battery));
      })
      .catch(() => {
        /* 拿不到电量就当没有这个功能 */
      });
  } catch {
    /* 浏览器不支持就算了 */
  }
}

/* ------------------------------------------------------------------ *
 * 首页（资源列表）与路由
 * ------------------------------------------------------------------ */

let gallery: any = null;

function setupGallery() {
  gallery = createGallery({
    grid: dom.galleryGrid,
    search: dom.gallerySearch,
    kindSelect: dom.galleryKind,
    summary: dom.gallerySummary,
    empty: dom.galleryEmpty,
    /* 列表来源由这里注入：服务器模式走 /api，静态模式走构建期的 packages.json。
       列表页本身不该知道运行模式（否则静态部署下会去请求 /api 而 404）。 */
    loadIndex: () => loadIndexForUi(),
    localPackageId: LOCAL_PACKAGE_ID,
    /* 二次确认用组件库的对话框（index.html 的 #confirmDialog），不用 window.confirm */
    confirmAction: (options: { title: string; description?: string; confirmText?: string }) => askConfirm(options),
    /* 删除：服务器模式连磁盘一起删（需求明确要求），静态模式只从内存里的列表移除。
       "列表怎么更新"由列表页自己负责（它会重新拉一次）—— 这里只负责删什么。 */
    onDelete: async (packageId: string) => {
      if (state.mode === 'server') {
        await deletePackage(packageId);
        setStatus(`已删除 ${packageId}（列表与磁盘目录）`);
      } else {
        /* 静态模式没有后端可删：记住"这个 id 已被删掉"，重新拉列表时过滤掉它 */
        hiddenPackages.add(packageId);
        if (packageId === LOCAL_PACKAGE_ID) localPackageEntry = null;
        setStatus(`已从列表移除 ${packageId}（静态模式：只在内存里）`);
      }
      /* 删掉的正好是当前正在看的包：回首页，别留一个打不开的页面 */
      if (state.packageId === packageId) {
        releasePlayback();
        state.source?.release?.();
        state.source = null;
        state.manifest = null;
        state.packageId = null;
        state.character = null;
        location.hash = '#';
      }
      /* 下拉框里的选项也要跟着变 */
      await loadPackageList();
    },
    onOpen: (packageId: any, characterId: any) => {
      // 用 hash 当作路由：进入播放页、可以后退、可以直接分享链接
      location.hash = `#${encodeURIComponent(packageId)}/${encodeURIComponent(characterId)}`;
    },
  });
  dom.backToGallery.addEventListener('click', () => {
    location.hash = '#';
  });
}

/** hash → `#<包>` 或 `#<包>/<角色>`；`#zip` 是打包下载页；为空则显示首页 */
function applyRoute() {
  const { packageId, characterId } = readHash();
  /* 打包下载页：与播放器无关，进来先把播放侧停掉（否则声音/模型还占着资源） */
  if (packageId === ZIP_PAGE_ID) {
    releasePlayback();
    state.character = null;
    document.documentElement.dataset.route = 'zip';
    hideChoices();
    return;
  }
  if (!packageId) {
    // 回首页就不该有任何东西在播：声音、模型资源一起放掉
    releasePlayback();
    state.character = null;
    state.cubismMotions = [] as any[];
    state.cubismMotionNames = {};
    state.interactions = [] as any[];
    state.animations = [] as any[];
    document.documentElement.dataset.route = 'gallery';
    hideChoices();
    gallery?.show();
    return;
  }
  /* `#local` 是**浏览器内解包**的结果：它只存在于内存里，没有包 id，
     所以不走 selectPackage（那条路会去拉 manifest.json），直接用已经装在 state 里的清单。 */
  if (packageId === LOCAL_PACKAGE_ID) {
    document.documentElement.dataset.route = 'player';
    const characters = state.manifest?.characters ?? [];
    const index = characterId ? characters.findIndex((c: any) => c.id === characterId) : 0;
    if (index >= 0 && state.character?.id !== characters[index]?.id) {
      selectCharacter(index);
    }
    return;
  }
  const wasGallery = document.documentElement.dataset.route === 'gallery';
  document.documentElement.dataset.route = 'player';
  // 同一个包内换角色：直接切角色，不必重新拉清单
  if (!wasGallery && state.packageId === packageId) {
    const index = (state.manifest?.characters ?? []).findIndex((character: any) => character.id === characterId);
    if (index >= 0 && state.character?.id !== characterId) {
      selectCharacter(index);
      return;
    }
    if (index >= 0) return;
  }
  selectPackage(packageId, characterId || null);
}

/** 切换渲染后端：Spine 用 WebGL 画布 + 自己驱动，Cubism 用 PIXI 画布 + 自带 ticker */
function usePlayer(kind: any) {
  if (state.playerKind === kind && state.player) return state.player;
  state.playerKind = kind;
  state.player = kind === 'cubism' ? state.cubism : state.spine;
  dom.canvas.hidden = kind === 'cubism';
  dom.cubismCanvas.hidden = kind !== 'cubism';
  if (kind === 'cubism') state.cubism.resize?.();
  return state.player;
}

function renderLoop(now: any) {
  const delta = state.lastFrame ? Math.min((now - state.lastFrame) / 1000, 0.1) : 0;
  state.lastFrame = now;
  /* 帧计数：排查"模型加载了但完全不动"这类问题时，第一件事就是看循环到底跑没跑
     （HUD 停在初始文案 / 0 fps 就是可疑信号）。诊断用，不影响行为。 */
  state.frameCount = (state.frameCount ?? 0) + 1;
  try {
    // 两种播放器都由这里统一步进（Cubism 也用同一个时钟，见 cubism.js 的说明）
    state.player.update?.(delta * state.speed);
    // 播放器内部起播的动作（入场动画、看门狗重试）也带语音，这里统一取走播放
    const pendingSound = state.player.takePendingSound?.();
    if (pendingSound) playSound(pendingSound);
    /* 口型同步：把当前语音的音量喂给播放器（只有声明了 Groups.LipSync 的模型才会用到；
       没有语音时 getLevel() 直接返回 0，等于不驱动）。 */
    state.player.setLipSyncLevel?.(state.voice?.getLevel?.() ?? 0);
    state.player.render();
    updateHitAreaLayer();
    updateAreaBar();
    updateHud(now);
  } catch (error: any) {
    if (state.error !== error.message) {
      state.error = error.message;
      setStatus(`渲染出错：${error.message}`, true);
    }
  }
  requestAnimationFrame(renderLoop);
}

/**
 * 自定义 select（`appearance: base-select`）的第一个子元素是
 * `<button><selectedcontent></selectedcontent></button>` —— 值显示区。
 * 换选项时**只能删 `<option>`**：`select.innerHTML = ''` 会把这个结构一起清掉，
 * 之后浏览器只生成**无法被 CSS 命中**的隐式 button，样式的省略号/间距就全失效了。
 */
function clearSelectOptions(select: any) {
  for (const child of [...select.children]) {
    if (child.tagName === 'OPTION' || child.tagName === 'OPTGROUP') child.remove();
  }
}

/* ------------------------------------------------------------------ *
 * 包列表：服务器模式走 /api，静态模式走构建期产物 packages.json
 * ------------------------------------------------------------------ */

async function loadPackageList() {
  try {
    /* 与列表页共用 loadIndexForUi()：否则静态模式下删掉的包会留在下拉框里，
       点它还会去加载一个已经不显示的资源。 */
    const index = await loadIndexForUi();
    state.packages = index.packages;
  } catch (error: any) {
    setStatus(
      state.mode === 'server'
        ? `无法读取包列表（${error.message}）。可以直接把解包目录拖到右侧画布上。`
        : `无法读取 packages.json（${error.message}）。直接把 .lpk 或解包目录拖到画布上即可。`,
    );
    return;
  }

  clearSelectOptions(dom.packageSelect);
  /* 一个包都没有时，首页要给"拖进来"的引导而不是空白（纯内存模式下这是默认首页） */
  updateGalleryWelcome();
  if (state.packages.length === 0) {
    const option = document.createElement('option');
    option.textContent = state.mode === 'server' ? '（还没有解包结果）' : '（拖入 .lpk 即可）';
    option.value = '';
    dom.packageSelect.append(option);
    setStatus(
      state.mode === 'server'
        ? '还没有解包结果：把 .lpk 拖到画布上交给服务器解包，或先跑 unpack 命令。'
        : '静态模式：把 .lpk 拖到画布上，会在浏览器里解包（结果只放内存，刷新即失效）。',
    );
    return;
  }
  for (const item of state.packages) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.author ? `${item.title} — ${item.author}` : item.title;
    dom.packageSelect.append(option);
  }
  dom.packageSelect.disabled = false;
  // 由 applyRoute() 决定进哪一页（首页时不预加载任何模型）
}

/**
 * 解析路由 hash（唯一的解析点，applyRoute 用它）：`#<包 id>` 或 `#<包 id>/<角色 id>`。
 *
 * 逐段解码，不能整串先解码再按 `/` 切：包 id 里若含 `%2F`，先解码会被切成两个字段。
 * @returns {{packageId: string|null, characterId: string|null}}
 */
function readHash() {
  const raw = String(location.hash || '').replace(/^#/, '').trim();
  if (!raw || raw === '/') return { packageId: null, characterId: null };
  const [packageId, characterId] = raw.split('/').map((part: any) => decodeURIComponent(part));
  return { packageId: packageId || null, characterId: characterId || null };
}

function writeHash() {
  if (!state.packageId || !state.character) return;
  const next = `#${encodeURIComponent(state.packageId)}/${encodeURIComponent(state.character.id)}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

async function selectPackage(id: any, characterId: any = null) {
  const item = state.packages.find((entry: any) => entry.id === id);
  if (!item) return;
  // 下拉框要跟着"当前实际展示的包"走：从首页点进来、或直接开 hash 链接时也要对上，
  // 否则它永远停在第一个选项上（功能是对的，界面显示是错的）。
  dom.packageSelect.value = item.id;
  // 换包先把上一个包的声音和模型资源放掉，别让旧语音在加载期间继续响
  releasePlayback();
  setStatus(`正在加载 ${item.title} …`);
  try {
    const manifest = await (await fetch(item.manifest)).json();
    state.manifest = manifest;
    state.packageId = item.id;
    state.source = new UrlSource(item.base);
    renderPackageMeta(manifest);
    renderCharacterSelect(manifest);
    const index = characterId ? manifest.characters.findIndex((character: any) => character.id === characterId) : 0;
    await selectCharacter(index >= 0 ? index : 0);
  } catch (error: any) {
    setStatus(`加载失败：${error.message}`, true);
  }
}

function renderPackageMeta(manifest: any) {
  const info = manifest.package || {};
  const rows = [
    ['包名', info.title || '-'],
    ['作者', info.author || '-'],
    ['类型', `${info.mlveType} / ${manifest.source.entryCount} 条目`],
    ['说明', info.description || '-'],
  ];
  dom.meta.innerHTML = rows
    .map(([key, value]: any) => `<div class="meta-row"><span>${escapeHtml(key)}</span><b>${escapeHtml(String(value))}</b></div>`)
    .join('');
}

/**
 * 角色列表用下拉框而不是一排标签：
 * 角色 id 可能很长（`50010_skin_Queenbee03`），标签排会把侧栏顶宽、文本被裁；
 * 下拉框只有一个控件，宽度可控、文本自动省略，也少一张卡片。
 */
function renderCharacterSelect(manifest: any) {
  const select = dom.characterSelect;
  clearSelectOptions(select);
  manifest.characters.forEach((character: any, index: any) => {
    const option = document.createElement('option');
    option.value = character.id;
    option.textContent = manifest.characters.length > 1 ? `${index + 1}. ${character.id}` : character.id;
    option.title = `${character.title} · Spine ${character.spineVersion}`;
    select.append(option);
  });
  select.disabled = manifest.characters.length <= 1;
  if (state.character) select.value = state.character.id;
  setCounts({ characters: manifest.characters.length });
}

/* ------------------------------------------------------------------ *
 * 加载角色
 * ------------------------------------------------------------------ */

async function selectCharacter(index: any, textureSet = 0) {
  hideChoices();
  dom.viewport.classList.add('loading');
  // 移动端：选完角色就把抽屉收起来，把画面还给模型
  if (isNarrowLayout()) setNavOpen(false);
  const manifest = state.manifest;
  const character = manifest?.characters?.[index];
  if (!character) {
    dom.viewport.classList.remove('loading');
    return;
  }
  // 换模型：掐掉上一个模型的语音、释放它的 GPU 资源（音频不释放会一直响到最后）
  releasePlayback();
  state.variables.reset(); // 变量是每个模型自己的状态
  const isCubism = character.kind === 'cubism';
  setStatus(`正在加载角色 ${character.id} …`);

  try {
    /* Cubism 与 Spine 走两套渲染后端 */
    if (isCubism) {
      const player = usePlayer('cubism');
      const result = await player.load(character, state.source);
      // 把界面上的跟随设置应用到刚加载的模型
      player.setTrackingEnabled?.(followMode() !== 'off');
      player.setTrackingGain?.(Number(dom.followGain.value));
      state.character = character;
      state.characterIndex = index;
      state.interactions = [] as any[];
      state.animations = [] as any[];
      state.cubismMotions = result.motions;
      state.cubismMotionNames = result.motionNames ?? {};
      state.error = null;
      /* 变量条件里的 `@名字` 指的是**模型参数**（不带 @ 才是变量）：
         包里用 `{Name:"@CD_UI",Type:1,Code:"equal 0"}` 判断"面板现在是关着的"。 */
      state.variables.parameterOf = (id: any) => {
        // 我们强制写下去的值优先：coreModel 读回来的是 loadParameters() 恢复出来的旧值，
        // 用它判断"面板现在是开是关"永远不成立（只能开、不能关）。
        const override = state.player.overrideValueOf?.(id);
        if (override !== null && override !== undefined) return override;
        try {
          return state.player.model?.internalModel?.coreModel?.getParameterValueById(id);
        } catch {
          return undefined;
        }
      };
      // 命令里的 `$变量名`（例如 `parameters lock CD_UI $CD_UI 300`）由播放器替换
      state.player.variableOf = (name: any) => state.variables.get(name);

      dom.characterSelect.value = character.id;
      renderCubismControls(character, result);
      // 先跑包里的初始化（变量 + 参数锁定 + 开场动作），再起待机
      runCubismInit();
      /* 待机固定一条，不轮换（原版就是一直播同一段）：选法见 pickIdleCubismMotion，
         "待机"按钮用的是同一个函数（两处必须挑同一条）。 */
      const idle = pickIdleCubismMotion(result.motions);
      if (idle) state.player.setIdleMotion?.(idle.motion.group, idle.index);
      /* 入场动画：包里有 Start 组就先播它（原版进入模型时会先播这段问候语），
         播完之后由 ensureIdleMotion 接回待机。实测 14 个 Cubism 角色里有 6 个有 Start 组。 */
      const start = pickStartMotion(result.motions);
      if (start) {
        state.player.preloadMotion?.(start.group, result.motions.indexOf(start));
        // 交给播放器在能起播的时候播（换模型后立刻起播会被框架拒掉，见 setEntranceMotion）
        state.player.setEntranceMotion?.(start.group, result.motions.indexOf(start));
      } else if (idle) {
        state.player.preloadMotion?.(idle.motion.group, idle.index);
        playCubismMotion(idle.motion.group, idle.index);
      }
      writeHash();
      const notices = character.warnings || [];
      const warning = notices.length > 0 ? `  ⚠ ${notices.join('；')}` : '';
      setStatus(
        `已加载 ${character.id}（Live2D Cubism）：${result.motions.length} 个动作 / ` +
          `${result.expressions.length} 个表情 / ${character.textures.length} 张贴图${warning}`,
      );
      return;
    }

    const player = usePlayer('spine');
    const idleInteraction = (character.interactions || []).find((item: any) => item.group === 'idle');
    const idle = idleInteraction?.animation || (character.animations || []).find((item: any) => item.loop)?.name || null;
    /* 同角色的其它贴图套由播放器自己并入（见 player.js 的 mergeExtraTextureSets）：
       有的包把人物本体与背景拆到两套图集里，只加载活动那套会报 `Region not found in atlas`。
       播放器只并入"活动图集里没有的区域"，换装包不受影响。 */
    const result = await player.load(character, state.source, { idle, textureSet });
    state.character = character;
    state.characterIndex = index;
    state.textureSet = result.textureSet;
    state.interactions = character.interactions || [];
    state.cubismMotions = [] as any[];
    state.cubismMotionNames = {};
    // 二进制骨架解包时读不出动画表，这里用运行时里的真实清单补齐
    state.animations = mergeAnimations(character, result.animations);
    state.error = null;

    dom.characterSelect.value = character.id;
    renderControls(character);
    // 原版会先播"开场"（start 组），它自己的动作链（start_mtn）会把后续接上；没有开场就直接进待机
    const startInteraction = (character.interactions || []).find(
      (item: any) => item.group === 'start' && interactionAvailable(item, state.variables),
    );
    if (startInteraction) runInteraction(startInteraction);
    else enterIdle();
    writeHash();
    const notices = [...(result.sizeNotices || []), ...(character.warnings || [])];
    const warning = notices.length > 0 ? `  ⚠ ${notices.join('；')}` : '';
    const setInfo = result.textureSetCount > 1 ? ` / 贴图套 ${result.textureSet + 1}/${result.textureSetCount}` : '';
    setStatus(
      `已加载 ${character.id}（Spine ${result.spineVersion}，${character.skeletonFormat === 'binary' ? '二进制骨架' : 'JSON 骨架'}，${result.alphaMode}）：` +
        `${state.animations.length} 个动画 / ${character.sounds.length} 条语音 / ${result.pageNames.length} 张贴图${setInfo}${warning}`,
    );
  } catch (error: any) {
    setStatus(`角色加载失败：${error.message}`, true);
  } finally {
    // 加载遮罩（大的 Cubism 模型要几百毫秒，期间转个圈，别让人以为卡住）
    dom.viewport.classList.remove('loading');
  }
}

/* ------------------------------------------------------------------ *
 * Cubism 控制面板
 * ------------------------------------------------------------------ */

function renderCubismControls(character: any, result: any) {
  dom.textureSetPanel.hidden = true;
  dom.expressionPanel.hidden = result.expressions.length === 0;

  /* 动作：按组展示，组内每个动作一个按钮 */
  dom.animationList.innerHTML = '';
  const groups = new Map();
  result.motions.forEach((motion: any, index: any) => {
    if (!groups.has(motion.group)) groups.set(motion.group, []);
    groups.get(motion.group).push({ motion, index });
  });
  for (const [group, items] of groups) {
    const row = document.createElement('div');
    row.className = 'group';
    row.innerHTML = `<span class="group-label">${escapeHtml(group)}</span>`;
    for (const { motion, index } of items) {
      const button = document.createElement('button');
      const isCommand = Boolean(motion.command || motion.choices);
      applyChip(button, isCommand ? 'secondary' : 'outline');
      button.textContent = motion.label || `#${index}`;
      button.title = isCommand
        ? `${group}[${index}] 命令：${motion.command ?? '选择支'}`
        : `${group}[${index}]${motion.sound ? ' + 语音' : ''}`;
      button.addEventListener('click', () => playCubismMotion(group, index));
      row.append(button);
    }
    dom.animationList.append(row);
  }

  /* 互动：点击区域（原版靠点身体部位触发），以及点击类的动作组 */
  dom.interactionList.innerHTML = '';
  const tapGroups = [...groups.keys()].filter((g: any) => /tap|touch|click|特殊|点击/i.test(g));
  const hitAreas = (character.hitAreas || [])
    .map((area: any) => ({ area, reference: areaMotionRef(area) }))
    .filter((entry: any) => entry.reference);
  if (hitAreas.length > 0) {
    const row = document.createElement('div');
    row.className = 'group';
    row.innerHTML = '<span class="group-label">点击区域</span>';
    for (const { area, reference } of hitAreas) {
      const button = document.createElement('button');
      applyChip(button, 'outline');
      button.textContent = area.name;
      button.title = `点身体这个部位 → 动作组 ${reference}（也可以在画布上直接点）`;
      button.addEventListener('click', () => playCubismReference(reference));
      row.append(button);
    }
    dom.interactionList.append(row);
  }
  const tapRow = document.createElement('div');
  tapRow.className = 'group';
  tapRow.innerHTML = '<span class="group-label">随机</span>';
  if (tapGroups.length > 0) {
    const button = document.createElement('button');
    applyChip(button, 'outline');
    button.textContent = '随机点击动作';
    button.addEventListener('click', () => {
      const pick = randomCubismTap();
      if (pick) playCubismMotion(pick[0], pick[1]);
    });
    tapRow.append(button);
  }
  dom.interactionList.append(tapRow);

  /* 表情 */
  dom.expressionList.innerHTML = '';
  result.expressions.forEach((expression: any, index: any) => {
    const button = document.createElement('button');
    applyChip(button, 'outline');
    button.textContent = expression;
    button.title = expression;
    button.addEventListener('click', () => {
      if (!state.player.setExpression(index)) setStatus(`表情无法播放：${expression}`, true);
    });
    dom.expressionList.append(button);
  });

  /* 语音 */
  dom.soundList.innerHTML = '';
  for (const sound of character.sounds) {
    const button = document.createElement('button');
    applyChip(button, 'outline');
    button.textContent = sound.label || sound.path.split('/').pop();
    button.title = sound.path;
    button.addEventListener('click', () => playSound(sound.path));
    dom.soundList.append(button);
  }
  if (character.sounds.length === 0) dom.soundList.innerHTML = '<span class="muted">（该角色没有语音）</span>';
  setCounts({
    animations: result.motions.length,
    interactions: result.motions.length,
    sounds: character.sounds.length,
    expressions: result.expressions.length,
  });
}

/** 把数量写到面板标题上（0 或没有对应面板就留空） */
/**
 * 写一个计数徽章：0/空值就整个隐藏，别留一个空胶囊。
 *
 * 提到模块级是因为它不只服务 setCounts —— 触发区徽章（areaCount）也要用同一条规则，
 * 否则两条路径的"空值处理"迟早会不一致（界面自检就是这么抓到那个空胶囊的）。
 */
function writeCount(el: any, value: any) {
  if (!el || value === undefined || value === null) return;
  const count = Number(value);
  el.textContent = count > 0 ? String(count) : '';
  el.hidden = !(count > 0);
}

function setCounts({ characters, textureSets, animations, interactions, sounds, expressions }: any) {
  /**
   * 只更新调用方**给出的**项。
   * 有的地方只改动作数或贴图数（`setCounts({ animations })`），如果这里把没传的字段
   * 一并按 undefined 写成空串，就会把"角色 1"这类计数抹掉 —— 表现是标题旁挂着一个空徽章。
   */
  writeCount(dom.characterCount, characters);
  writeCount(dom.textureSetCount, textureSets);
  writeCount(dom.animationCount, animations);
  writeCount(dom.interactionCount, interactions);
  writeCount(dom.soundCount, sounds);
  writeCount(dom.expressionCount, expressions);
}

/** 统一"小按钮"的写法：外观交给 sheerly，这里只保证变体与尺寸一致 */
function applyChip(button: any, variant = 'outline') {
  button.className = 'sheerly-button';
  button.dataset.variant = variant;
  button.dataset.size = 'xs';
  button.type = 'button';
  return button;
}

/** 切换主题：类名给组件库用，dataset/color-scheme 给我们的样式与原生控件用，并记住用户的选择 */
function setTheme(dark: any) {
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  try {
    localStorage.setItem('lpk-theme', dark ? 'dark' : 'light');
  } catch {
    /* 隐私模式写不进去就算了 */
  }
  applyThemeToPlayers();
}

/** 画布是 WebGL 自己清屏的：浅色主题下别把背景刷成近黑 */
function applyThemeToPlayers() {
  const dark = document.documentElement.classList.contains('dark');
  const background = dark ? [0.055, 0.06, 0.08, 1] : [0.93, 0.93, 0.94, 1];
  if (state.spine) state.spine.backgroundColor = background;
}

/**
 * 画布光标：让鼠标形状反映"这里能不能点/能不能拖"。
 *   pointer   —— 悬停在可触发区域（点了会播动作/弹菜单/放语音）
 *   grab      —— 悬停在**可拖拽交互**上（Cubism 的 ParamHit 把手）
 *   grabbing  —— 正在拖那个把手
 *   crosshair —— 空白处 / 正在**拖动画布**（平移、缩放）时用十字，不用 grab
 */
function updateCanvasCursor(cssX: any, cssY: any, canvas: any) {
  const base = 'crosshair';
  if (state.pointer?.dragged || state.dragActive || state.pinchDistance > 0) {
    // 拖参数把手时是 grabbing；拖画布（平移）保持十字
    canvas.style.cursor = state.player?.dragging ? 'grabbing' : base;
    return;
  }
  /* 命中测试在分支里做（都是纯读的），光标统一在分支之后设置 ——
     以前这两行在两个分支里各写了一遍，改一处容易漏另一处。 */
  if (state.playerKind === 'cubism') {
    // 把手优先：它通常也绑定了点击，但拖动是更"顺手"的预期
    const handle = state.player.hitTestDrawable?.(cssX, cssY);
    if (handle && (state.player.dragHandlesAt?.(handle).length ?? 0) > 0) {
      canvas.style.cursor = 'grab';
      return;
    }
  }
  const area = state.player.hitTest?.(cssX, cssY, state.character?.hitAreas ?? []);
  canvas.style.cursor = area ? 'pointer' : base;
}

/** 移动端：一旦开始播东西就把抽屉收起来，把画面还给模型 */
function closeNavForPlayback() {
  if (isNarrowLayout() && document.body.classList.contains('nav-open')) setNavOpen(false);
}

function playCubismMotion(group: any, index: any) {
  closeNavForPlayback();
  const motion = state.cubismMotions?.[index];
  // 包里的变量赋值（换装、面板开关这类状态机靠它）：执行这条动作时更新变量
  if (motion?.varFloats?.length) state.variables?.apply?.(motion.varFloats);
  // 命令型动作：没有动作文件，只改模型参数、弹选项或换模型
  if (motion && (motion.command || motion.postCommand || motion.choices)) {
    const result = state.player.runMotionCommand({ ...motion, group, listIndex: index });
    if (!result.ok) {
      // 没有动作文件也没有命令的条目（作者留的占位），原版就是"什么都不发生"，不该报错
      setStatus(`这条动作没有可执行的内容：${motion.label ?? group}`);
      return;
    }
    if (result.changeModel) {
      const targetIndex = (state.manifest?.characters ?? []).findIndex(
        (item: any) => item.source?.modelEntry === result.changeModel,
      );
      if (targetIndex >= 0) {
        setStatus(`命令动作切换模型 → ${state.manifest.characters[targetIndex].id}`);
        selectCharacter(targetIndex);
        return;
      }
      setStatus(`命令要求切换到模型 ${result.changeModel}，但包里没有这个模型`, true);
    }
    /*
     * 包里 `Choices` 的处理：
     *   - 只有一个选项时**不是**"让用户选"，原版不会弹菜单。包里拿它当提示语用
     *     （"锁定触摸"那句 Press [~] or click to unlock 就是单选项），
     *     所以这里直接把这一项执行掉，不弹菜单。
     *   - 两个以上才是真选项（例如语音鉴赏 7 条），照常弹菜单。
     */
    if (result.choices?.length === 1) {
      const only = result.choices[0];
      if (only.sound) playSound(only.sound);
      setStatus(`已执行命令动作 ${group}：${only.text ?? result.message}`);
      if (only.next) playCubismReference(only.next);
      if (result.nextMotion) playCubismReference(result.nextMotion);
      return;
    }
    if (result.choices?.length) showChoices(result.choices);
    else setStatus(`已执行命令动作 ${group}：${result.message}`);
    if (result.nextMotion) playCubismReference(result.nextMotion);
    return;
  }

  if (!state.player.playMotion(group, index)) {
    setStatus(`动作无法播放：${group}[${index}]`, true);
    return;
  }
  const sound = motion && motion.group === group ? motion.sound : null;
  if (sound) playSound(sound);
}

/** Cubism 动作条目当前是否可用（按包里 varFloats 的条件指令） */
function cubismMotionAvailable(motion: any) {
  const conditions = motion?.varFloats;
  return !conditions?.length || !state.variables || state.variables.matches(conditions);
}

/**
 * 加载 Cubism 角色后先跑包里的 init 条目。
 * 【碧蓝航线】不挠 就是这么开场的：`init#9` 的变量指令把 CD_fa / CD_UI / L2D_D2(=10) 等
 * 初始化，随后 postCommand 里 `start_mtn init#9:init_touch` 播放开场，并把一批参数
 * 锁到这些变量值上 —— 面板、服装切换这些状态全都建立在它们之上。
 */
function runCubismInit() {
  const init = (state.cubismMotions ?? []).find((motion: any) => String(motion.label ?? '').toLowerCase() === 'init');
  if (!init) return;
  const applied = state.variables?.apply?.(init.varFloats) ?? [];
  /* 命令里的 `$变量名` 交给播放器替换（cubism.js 的 substituteVariables，读的是
     selectCharacter 里设置的 variableOf）：包里写成 `parameters lock CD_fa $CD_fa 0`，
     意思是"锁到变量 CD_fa 的当前值"，不替换的话值会解析成 NaN、锁定等于没生效。 */
  const command = state.player.substituteVariables?.(init.postCommand);
  const result = command ? state.player.applyCommandString?.(command) : null;
  if (applied.length > 0 || result?.applied?.length > 0) {
    state.player.applyParameterOverrides?.();
    setStatus(`已执行包内初始化：${[...applied, ...(result?.applied ?? [])].slice(0, 4).join('；')}…`);
  }
  if (result?.nextMotion) playCubismReference(result.nextMotion);
}

/**
 * 解析 config.mlve 里的动作引用。原版允许三种写法（实测 【碧蓝航线】不挠 里
 * 53 条是 `组:条目`，其余是 `组#N` / 裸组名 / `empty`）：
 *
 *   `touch_idle:touch_idle1` —— 组 + 条目（条目名对应动作文件名，mlve 的 Motions 表里
 *                               每个条目只有 File、没有单独的 Name 字段）
 *   `CD_UI#9`                —— 整串就是组名（模型里组名本身带 `#N`，表示播放层级）
 *   `special`                —— 组里第一条
 *   `empty`                  —— 什么都不做（原版同样静默）
 *
 * @returns {{motion: object, index: number}|null}
 */
function resolveCubismTarget(reference: any) {
  const value = String(reference ?? '').trim();
  if (!value || value === 'empty') return null;
  const motions = state.cubismMotions || [];
  const [group, name] = value.includes(':') ? value.split(':') : [value, null];
  const inGroup = motions
    .map((motion: any, index: any) => ({ motion, index }))
    .filter(({ motion }: any) => motion.group === group);
  if (inGroup.length === 0) return null;
  // 同一组里常有靠变量条件区分变体（例如 pi=0 用 Stand、pi=1 用 Stand_s01）：
  // 先只在条件成立的条目里找，找不到再退回全部（避免"因为条件不成立就什么都不能播"）。
  const usable = inGroup.filter(({ motion }: any) => cubismMotionAvailable(motion));
  const pool = usable.length > 0 ? usable : inGroup;
  if (!name) return pool[0];

  /* ① 权威来源：运行时 model3.json 的 Motions[组][].Name。
     原版解析 `组:条目` 就是查这张表（choices 里的 `select:wedding` 属于这一类）。
     表里还有 `wedding_en` / `wedding_ja` 这类语言变体：先精确匹配，再匹配 `名字_语言`。
     命中后用 File（就是 manifest 的 fileEntry，md5）精确定位到具体动作，
     不依赖两侧数组顺序是否一致。 */
  const named = state.cubismMotionNames?.[group] ?? [];
  const wanted = name.toLowerCase();
  const namedHit =
    named.find((entry: any) => String(entry.name ?? '').toLowerCase() === wanted) ??
    named.find((entry: any) => String(entry.name ?? '').toLowerCase().startsWith(`${wanted}_`)) ??
    null;
  if (namedHit) {
    const byEntry = namedHit.file
      ? inGroup.find(({ motion }: any) => String(motion.fileEntry ?? '') === String(namedHit.file))
      : null;
    if (byEntry) return byEntry;
    const byPosition = named.indexOf(namedHit);
    if (byPosition >= 0 && byPosition < inGroup.length) return inGroup[byPosition];
  }

  /* ② 退路：manifest 的 label（有些包的 name 字段就是字幕）、文件名或文件名后缀 */
  const wantedBare = wanted.replace(/[^a-z0-9]/g, '');
  const bareName = ({ motion }: any) =>
    String(motion.file ?? '')
      .replace(/^.*\//, '')
      // 注意要去掉**所有**扩展名：motions/touch_idle_1.motion3.json
      // 只去掉最后一段会留下 "touchidle1motion3"，于是 `touch_idle:touch_idle1` 永远匹配不上
      .replace(/\.(motion3|model3|physics3|bin3)\.json$/i, '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();
  return (
    inGroup.find(({ motion }: any) => String(motion.label ?? '').toLowerCase() === wanted) ??
    pool.find(({ motion }: any) => String(motion.name ?? '').toLowerCase() === wanted) ??
    pool.find((item: any) => bareName(item) === wantedBare) ??
    pool.find((item: any) => bareName(item).endsWith(wantedBare)) ??
    null
  );
}

/** 播放某个动作组的第一个动作（NextMtn 跳转用；区域引用请用 playCubismReference） */
function playCubismGroup(group: any) {
  const target = (state.cubismMotions || [])
    .map((motion: any, index: any) => ({ motion, index }))
    .find(({ motion }: any) => motion.group === group);
  if (!target) {
    setStatus(`找不到动作组：${group}`, true);
    return false;
  }
  playCubismMotion(target.motion.group, target.index);
  return true;
}

/**
 * 播放一条区域/命令里的动作引用（`组:条目` 这种）。
 * 解析不到时保持安静：`empty` 和代理区域在原版里就是"什么都不发生"，
 * 不该弹出红色报错。
 */
function playCubismReference(reference: any) {
  const target = resolveCubismTarget(reference);
  if (!target) {
    if (String(reference ?? '').trim() && String(reference).trim() !== 'empty') {
      setStatus(`这条区域引用没有对应动作：${reference}`);
    }
    return false;
  }
  playCubismMotion(target.motion.group, target.index);
  return true;
}

/**
 * 选项菜单：用组件库的 dropdown-menu（`-content` + `-item`），显示与否看外层 .choice-menu。
 * 关闭路径有三条：点面板外面、按 Esc、选中某一项，都会把外层重新 hidden。
 */
function choiceMenuOpen() {
  return !dom.choiceMenu.hidden;
}

/** 关掉选项面板（light dismiss：点别处、按 Esc、切角色都关） */
function hideChoices() {
  if (!choiceMenuOpen()) return false;
  dom.choiceBox.replaceChildren();
  dom.choiceMenu.hidden = true;
  return true;
}

/**
 * 移动端的"操作"抽屉：画布始终占满，所有操作项都在抽屉里。
 * 打开时点遮罩 / 按 Esc / 选中资源都会收起。
 */
function setNavOpen(open: any) {
  document.body.classList.toggle('nav-open', open);
  dom.navBackdrop.hidden = !open;
}

/** 当前是移动端布局（靠 CSS 的导航按钮是否可见判断，避免和媒体查询写死两套阈值） */
function isNarrowLayout() {
  return getComputedStyle(dom.navToggle).display !== 'none';
}

/**
 * 弹出选项面板（light dismiss 语义：点面板外面任何地方都关掉）。
 * @param {Array<object>} choices 每项 {text, sound?, next?, onPick?}
 * @param {string} [titleText]
 */
function showChoices(choices: any, titleText = '请选择：') {
  dom.choiceBox.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'sheerly-dropdown-menu-label';
  title.textContent = titleText;
  dom.choiceBox.append(title);
  choices.forEach((choice: any) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheerly-dropdown-menu-item';
    button.setAttribute('role', 'menuitem');
    button.textContent = choice.text || '(未命名选项)';
    button.addEventListener('click', () => {
      hideChoices();
      if (choice.sound) playSound(choice.sound);
      if (choice.onPick) {
        choice.onPick();
        return;
      }
      if (!choice.next) {
        setStatus('这个选项没有指定后续动作');
        return;
      }
      if (state.playerKind === 'cubism') {
        playCubismReference(choice.next);
        return;
      }
      playChainedTarget(choice.next);
    });
    dom.choiceBox.append(button);
  });
  dom.choiceMenu.hidden = false;
}

/**
 * 点到一个绑定了动作组的区域时：如果这个组里有多个可选项，就像原版那样弹出"选择"菜单。
 * （`BS_10 → qiehuan` 这种组里有两条分支：换到 s01 / 换回原版，原版是弹菜单让人选。）
 * @returns {boolean} 是否弹出了菜单
 */
function showAreaMenu(area: any, entries: any) {
  const reference = areaMotionRef(area);
  if (!reference || !Array.isArray(entries) || entries.length === 0) return false;
  // Spine 侧保持原样（那一侧原版就是弹菜单让用户挑）
  if (state.playerKind !== 'cubism') return showSpineAreaMenu(area, entries);
  /*
   * 同一组里的多条通常**不是**"让用户挑"，而是变体：
   *   - 换装/面板（CD_UI#9 的 set_10 / set_0）靠变量条件区分，当前状态只有一条可用；
   *   - 语音靠语言区分，随机播一条。
   * 原版是按状态自动选一条执行，不会弹出 "set_10 / set_0" 这种菜单（实测对照原版截图）。
   * 真正需要用户选的只有包里**显式**写的 Choices（例如语音鉴赏的 7 条）。
   */
  const usable = entries.filter((entry: any) => cubismMotionAvailable(entry));
  const picked = (usable.length > 0 ? pickVariant(usable, state.variables) : null) ?? usable[0] ?? entries[0];
  const choices = picked?.choices ?? [];
  // 只有一个选项＝没有可选性：原版直接执行（例如"锁定触摸"那句 Press [~] 的提示），不弹菜单
  if (choices.length < 2) return false;
  showChoices(
    choices.map((choice: any) => ({ text: choice.text, sound: choice.sound, next: choice.next })),
    `${area.name}：请选择`,
  );
  return true;
}

/** Spine 侧的区域菜单：多条时按条目列出来给用户挑（这一侧原版就是给菜单） */
function showSpineAreaMenu(area: any, entries: any) {
  if (!area?.motion || !Array.isArray(entries) || entries.length === 0) return false;
  // 组里只有一条、而这条自带 Choices（包里显式定义的"选项"菜单）→ 直接展示它的选项
  const only = entries.length === 1 ? entries[0] : null;
  if (only?.choices?.length) {
    showChoices(
      only.choices.map((choice: any) => ({ text: choice.text, sound: choice.sound, next: choice.next })),
      `${area.name}：请选择`,
    );
    return true;
  }
  if (entries.length < 2) return false;
  showChoices(
    entries.map((entry: any) => {
      // 标签重复组名时没有信息量（qiehuan 组里两条都叫 qiehuan），改用它指向的目标来描述
      const label = entry.label && entry.label !== entry.group ? entry.label : null;
      return {
        text:
          label ||
          entry.text ||
          entry.animation ||
          (entry.next ? describeTarget(entry.next) : null) ||
          entry.label ||
          entry.name ||
          area.motion,
        sound: entry.sound,
        onPick: () => runInteraction(entry),
      };
    }),
    `${area.name}：请选择`,
  );
  return true;
}

/** 把 "组:名字" / 组名 描述成 "目标（实际动作）" */
function describeTarget(target: any) {
  if (state.playerKind === 'cubism') return target;
  const resolved = findInteraction(state.interactions, target);
  return resolved?.animation ? `${target}（${resolved.animation}）` : target;
}

/**
 * 区域对应的动作引用。
 *
 * 有些 Cubism 包的 HitAreas 只给名字、不给 motion（实测 5 个角色、26 个区域是这样，
 * 例如 少女前线-ZB26），约定是 **`Tap` + 区域名**：
 *   head → Taphead、body → Tapbody、leg1 → Tapleg1、change → Tapchange、
 *   HitAreaArm → TapHitAreaArm（区域名本身就带 HitArea 前缀，所以前缀保留）
 * 拿不到就回退到"区域名本身就是组名"，再不行返回 null（上层会提示"没有绑定动作"）。
 */
function areaMotionRef(area: any) {
  if (area?.motion) return area.motion;
  if (!area || state.playerKind !== 'cubism') return null;
  const groups = new Map(
    (state.cubismMotions ?? []).map((motion: any) => [String(motion.group).toLowerCase(), motion.group]),
  );
  const bases = [area.name, String(area.bone ?? '').replace(/^HitArea/i, '')].filter(Boolean);
  for (const base of bases) {
    const key = String(base).toLowerCase();
    const hit = groups.get(`tap${key}`) ?? groups.get(key);
    if (hit) return hit;
  }
  return null;
}

/** 入场动画：包里 `Start` 组的第一条可用动作（原版进入模型时先播这一段问候语） */
function pickStartMotion(motions: any) {
  const list = motions ?? state.cubismMotions ?? [];
  return list.find((motion: any) => String(motion.group).toLowerCase() === 'start' && cubismMotionAvailable(motion)) ?? null;
}

/**
 * 挑"固定待机"动作。加载时（selectCharacter → setIdleMotion）和"待机"按钮共用它，
 * 两处必须挑同一条 —— 否则按钮按下去会切到另一段动作上，而原版一直播同一段待机。
 *
 * 优先组名以 idle 开头的**可播循环**动作（Idle / Idle#1 / idle_01 都是待机变体，
 * 但 touch_idle / cover_idle 这类"状态/反应"动作不在此列，见 playMotion 里的说明），
 * 其次任意可播的循环动作，最后退回清单第一条。
 * 先看组名再看 loop：清单里的 loop 现在如实反映 motion3.json 的 Meta.Loop，而这批包
 * 几乎把所有动作都标成 Loop:true（实测 3258231941 有 23/32 组），只信 loop 会挑错。
 * @returns {{motion: object, index: number}|null}
 */
function pickIdleCubismMotion(motions = state.cubismMotions) {
  const list = motions ?? [];
  const looping = list.filter((motion: any) => motion.loop && cubismMotionAvailable(motion));
  const motion = looping.find((item: any) => /^idle/i.test(String(item.group))) ?? looping[0] ?? list[0] ?? null;
  return motion ? { motion, index: list.indexOf(motion) } : null;
}

/** 某个区域绑定的动作组里，所有能播的条目（给"选择"菜单用） */
function areaEntries(area: any) {
  const reference = areaMotionRef(area);
  if (!reference) return [];
  if (state.playerKind === 'cubism') {
    const motions = state.cubismMotions || [];
    return motions.map((motion: any, index: any) => ({ ...motion, index })).filter((motion: any) => motion.group === reference);
  }
  return findGroupEntries(reference);
}

/** Spine 侧：某个动作组里的所有条目 */
function findGroupEntries(group: any) {
  return state.interactions.filter((item: any) => item.group === group);
}

/**
 * 这个区域算出来的矩形是否落在**模型自己的包围盒**里。
 *
 * Cubism 包里有一类"代理区域"：作者会额外画一些不可见的 Touch* drawable，
 * 放在模型框之外很远的地方（实测 【碧蓝航线】不挠 里 y≈44000~59000，
 * 而模型自身高度只有几千），只用来说明"该区域对应哪个参数/动作"，
 * 原版靠参数（ParamHit）触发，从不把它们当成画布上的可点位置。
 *
 * 不排除它们的话，hitAreaRects 会算出画布外几千像素的矩形，
 * 于是 69 个区域里 63 个被误判成"画布外触发区"——原版并不会这样。
 */
function insideModelBox(rect: any) {
  if (state.playerKind !== 'cubism') return true; // Spine 的区域坐标本来就在舞台坐标里
  const modelWidth = state.player.modelWidth?.() ?? 0;
  const modelHeight = state.player.modelHeight?.() ?? 0;
  if (!(modelWidth > 0) || !(modelHeight > 0)) return true;
  const slack = (value: any, max: any) => value >= -max * 0.05 && value <= max * 1.05;
  return slack(rect.modelX, modelWidth) && slack(rect.modelY, modelHeight);
}

/**
 * 画布外的"UI 触发区"按钮栏。
 *
 * 有些包把点击区域挂在画面外的骨骼上（例如 `3409170834` 的 `1`/`2`/`xz` 对应
 * 特殊 1/特殊 2/选项菜单）——原版是把它们做成界面按钮的。这些区域在画布上点不到，
 * 所以这里按包里声明的顺序渲染成按钮，点击等同于点该区域。
 */
function updateAreaBar() {
  if (!state.character) return;
  const rects = state.player.hitAreaRects?.(state.character.hitAreas) ?? [];
  /* 显式写成"名字 → 矩形"，否则元素类型会被推成 {}，下面取 x/width 就会报错 */
  const byName = new Map<string, any>(rects.map((rect: any): [string, any] => [rect.name, rect]));
  const width = state.playerKind === 'cubism' ? dom.cubismCanvas.clientWidth : dom.canvas.clientWidth;
  const height = state.playerKind === 'cubism' ? dom.cubismCanvas.clientHeight : dom.canvas.clientHeight;
  const offscreen = (state.character.hitAreas ?? []).filter((area: any) => {
    const rect = byName.get(area.name);
    if (!rect) return true; // 算不出矩形（例如区域骨骼不在骨架里）
    if (!insideModelBox(rect)) return false; // 参数触发用的代理区域，见下方说明
    return rect.x + rect.width < 0 || rect.x > width || rect.y + rect.height < 0 || rect.y > height;
  });
  const signature = offscreen.map((area: any) => `${area.name}→${areaMotionRef(area)}`).join('|') + `#${width}x${height}`;
  if (signature === state.areaBarSignature) return;
  state.areaBarSignature = signature;

  if (offscreen.length === 0) {
    dom.areaBar.replaceChildren();
    dom.areaToggle.hidden = true;
    /* 徽章也要收起来：以前只清了按钮栏，徽章会留一个**空胶囊**在侧栏上（界面自检抓到的）。 */
    writeCount(dom.areaCount, 0);
    if (dom.areaSheet.open) dom.areaSheet.close();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const area of offscreen) {
    const reference = areaMotionRef(area);
    const button = document.createElement('button');
    button.type = 'button';
    applyChip(button, reference ? 'outline' : 'muted');
    button.textContent = reference ? `${area.name} → ${reference}` : area.name;
    button.title = reference ? `等同于点击模型上的「${area.name}」区域` : '这个区域没有绑定动作';
    button.disabled = !reference;
    button.addEventListener('click', () => {
      if (!reference) return;
      // 选完就收起，避免这块次要内容一直占着屏幕
      if (dom.areaSheet.open) dom.areaSheet.close();
      const entries = areaEntries(area);
      if (showAreaMenu(area, entries)) return;
      playAreaMotion(reference);
    });
    fragment.append(button);
  }
  dom.areaBar.replaceChildren(fragment);
  // 画布外触发区是次要内容：只在下方留一个按钮，完整清单放进 sheet 里按需查看
  dom.areaToggle.hidden = false;
  writeCount(dom.areaCount, offscreen.length);
}

/** 执行一个区域绑定的动作组（画布外按钮用） */
function playAreaMotion(target: any) {
  if (state.playerKind === 'cubism') {
    if (playCubismReference(target)) return;
    setStatus(`动作组不存在：${target}`, true);
    return;
  }
  playChainedTarget(target);
}

/** 找一组"点击"类动作用于画布点击 */
function randomCubismTap() {
  const motions = state.cubismMotions || [];
  const playable = motions
    .map((motion: any, index: any) => ({ motion, index }))
    .filter(({ motion }: any) => !motion.command && !motion.choices);
  const preferred = playable.filter(({ motion }: any) => /tap|touch|click|特殊|点击/i.test(motion.group));
  const pool = preferred.length > 0 ? preferred : playable;
  if (pool.length === 0) return null;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return [picked.motion.group, picked.index];
}

/** 清单里的动画（带标签/循环设置）+ 骨架里实际存在的动画 */
function mergeAnimations(character: any, runtimeNames: any) {
  const runtime = Array.isArray(runtimeNames) ? new Set(runtimeNames) : null;
  const merged = [] as any[];
  const seen = new Set();
  for (const animation of character.animations || []) {
    merged.push({ ...animation, available: runtime ? runtime.has(animation.name) : animation.available !== false });
    seen.add(animation.name);
  }
  for (const name of runtimeNames || []) {
    if (seen.has(name)) continue;
    merged.push({ name, loop: false, label: null, available: true });
  }
  return merged;
}

function renderControls(character: any) {
  /* 贴图版本（多套图集时才有意义，例如原版 / 和谐版） */
  const sets = character.textureSets || [];
  dom.textureSetList.innerHTML = '';
  dom.textureSetPanel.hidden = sets.length <= 1;
  if (sets.length > 1) {
    sets.forEach((set: any, index: any) => {
      const button = document.createElement('button');
      applyChip(button, index === state.textureSet ? 'default' : 'outline');
      button.textContent = `贴图 ${index + 1}`;
      button.title = `${set.atlasName}（${set.pages.length} 页）`;
      button.addEventListener('click', () => selectCharacter(state.characterIndex, index));
      dom.textureSetList.append(button);
    });
  }
  setCounts({ textureSets: sets.length });

  /* 动作 */
  dom.animationList.innerHTML = '';
  for (const animation of state.animations) {
    const button = document.createElement('button');
    applyChip(button, animation.available ? 'outline' : 'muted');
    button.textContent = animation.label || animation.name;
    button.title = animation.available
      ? `${animation.name}${animation.loop ? '（循环）' : ''}`
      : `${animation.name} 在骨架中不存在`;
    if (!animation.available) {
      button.addEventListener('click', () => setStatus(`骨架中没有这段动画：${animation.name}`, true));
    } else {
      button.addEventListener('click', () => playAnimation(animation.name, animation.loop));
    }
    dom.animationList.append(button);
  }

  /* 互动：把包里的交互条目全部列出来——包括没有动作文件的菜单（选择支）、
     纯语音条目和纯命令条目，原版同样会把它们显示成按钮 */
  dom.interactionList.innerHTML = '';
  const groups = new Map();
  const seen = new Set();
  for (const interaction of character.interactions) {
    if (interaction.group.toLowerCase() === 'idle') continue;
    // 变量条件不成立的变体（例如 pi=0 时的 _s01 皮肤）不显示
    if (!interactionAvailable(interaction, state.variables)) continue;
    // 去重：同名同动画的重复条目只留一条；不同变量条件的变体已经被上面的筛选分开了，
    // 所以换装之后这一组会自然换成另一条（例如 qiehuan 从"切到 _s01"变成"切回来"）
    const key = `${interaction.group}::${interaction.name}::${interaction.animation ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!groups.has(interaction.groupLabel)) groups.set(interaction.groupLabel, []);
    groups.get(interaction.groupLabel).push(interaction);
  }
  for (const [label, items] of groups) {
    const row = document.createElement('div');
    row.className = 'group';
    row.innerHTML = `<span class="group-label">${escapeHtml(label)}</span>`;
    for (const interaction of items) {
      const button = document.createElement('button');
      const isCommandOnly = !interaction.animation;
      const missing = interaction.animation && !state.player.hasAnimation?.(interaction.animation);
      applyChip(button, isCommandOnly ? 'secondary' : 'outline');
      button.textContent = interaction.label;
      button.title = [
        interaction.animation ?? (interaction.choices?.length ? '选择支' : interaction.command ? '命令' : '语音'),
        interaction.sound ? '有语音' : null,
        interaction.choices?.length ? `${interaction.choices.length} 个选项` : null,
        missing ? '（骨架中没有这个动画，只会执行命令/语音）' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      if (missing) button.dataset.variant = 'muted';
      button.addEventListener('click', () => runInteraction(interaction));
      row.append(button);
    }
    dom.interactionList.append(row);
  }

  /* 语音 */
  dom.soundList.innerHTML = '';
  for (const sound of character.sounds) {
    const button = document.createElement('button');
    applyChip(button, 'outline');
    button.textContent = sound.label || sound.path.split('/').pop();
    button.title = sound.path;
    button.addEventListener('click', () => playSound(sound.path));
    dom.soundList.append(button);
  }
  if (character.sounds.length === 0) dom.soundList.innerHTML = '<span class="muted">（该角色没有语音）</span>';
  setCounts({
    animations: character.animations.length,
    interactions: character.interactions.length,
    sounds: character.sounds.length,
    expressions: character.expressions?.length ?? 0,
  });
}

/* ------------------------------------------------------------------ *
 * 播放
 * ------------------------------------------------------------------ */

function playAnimation(name: any, loop: any, fadeInMs: number | null = null, onComplete: (() => void) | null = null) {
  if (!name) return false;
  closeNavForPlayback();
  const mix = Number.isFinite(fadeInMs) ? Math.max(0, (fadeInMs as number) / 1000) : undefined;
  // 记下"这段之前是什么"，供"互动结束后回到互动前的动画"使用
  if (state.player.current?.name && state.player.current.name !== name) {
    state.previousAnimation = state.player.current.name;
  }
  return state.player.play(name, { loop: Boolean(loop), mix, onComplete: onComplete ?? undefined });
}

/**
 * 播一个交互。原版的交互可能同时包含：动画 + 语音 + 骨架指令（换装）+ 选择支 + 后续动作链，
 * 这里按同样顺序处理，并且动作文件缺失时不再报错（原版也只是那个动作放不出来）。
 *
 * 时序：先执行赋值与换装指令 → 播动画 → 播语音 → 弹菜单；
 * 有动画时，后续动作链与"回到待机"都等动画播完再做（原版的 start_mtn 是"这段结束再起下一段"）。
 */
function runInteraction(interaction: any) {
  if (!interaction) return;

  /* 0) 变量条件不成立的条目直接跳过（例如 pi=0 时不该播 Stand_s01） */
  if (!interactionAvailable(interaction, state.variables)) return;

  /* 1) 先执行赋值和骨架指令（换装等必须在播动画前生效） */
  const plan = planInteraction(interaction, state.variables);
  state.player.applySlotOpacities?.(plan.command);
  const runChain = () => {
    let started = false;
    for (const target of plan.command.startMotions) started = playChainedTarget(target) || started;
    if (plan.nextTarget) started = playChainedTarget(plan.nextTarget) || started;
    return started;
  };
  if (plan.assigned.length > 0) {
    setStatus(`变量：${plan.assigned.join('；')}`);
    renderControls(state.character); // 变量变了，按钮可用性和待机动作都跟着变
  }

  /* 2) 动画：有动画就等它播完再跑动作链 / 回待机 */
  const hasChain = plan.command.startMotions.length > 0 || Boolean(plan.nextTarget);
  const finish = () => {
    const started = hasChain ? runChain() : false;
    if (!started) afterInteractionFinished(interaction);
  };
  if (plan.animation) {
    if (!playAnimation(plan.animation, plan.loop, plan.fadeInMs, plan.loop ? null : finish)) {
      // 包里的配置引用了骨架中不存在的动画（例如缺少某套皮肤），提示一下但不当成错误
      setStatus(`骨架中没有动画：${plan.animation}（包的配置引用了它，已跳过动画部分）`);
      finish();
    }
  } else {
    finish();
  }

  /* 3) 语音 */
  if (plan.sound) playSound(plan.sound);

  /* 4) 选择支 */
  if (plan.choices?.length) showChoices(plan.choices);
}

/** 处理一条后继指令目标："组" 或 "组:名字"（原版的 start_mtn / next_mtn） */
function playChainedTarget(target: any) {
  const found = findInteraction(state.character?.interactions ?? [], target, (list: any) =>
    pickVariant(
      list.filter((item: any) => interactionAvailable(item, state.variables)),
      state.variables,
    ),
  );
  if (!found) return false;
  runInteraction(found);
  return true;
}

/**
 * 选一个能播的"点击"交互（变量条件不成立、或骨架里没有这个动画的都要跳过）
 */
function pickTapInteraction() {
  const playable = state.interactions.filter(
    (item: any) =>
      interactionAvailable(item, state.variables) &&
      (!item.animation || state.player.hasAnimation?.(item.animation)),
  );
  const ordered = [/^tap$/i, /^tap_/i, /^touch/i, /^click/i];
  for (const pattern of ordered) {
    const candidates = playable.filter((item: any) => pattern.test(item.group));
    if (candidates.length > 0) return pickVariant(candidates, state.variables);
  }
  const loose = playable.filter(
    (item: any) => /tap|touch|click|点击/i.test(item.group + item.label) && item.group.toLowerCase() !== 'idle',
  );
  return loose.length > 0 ? pickVariant(loose, state.variables) : null;
}

/** 光标跟随的模式：'drag' 按住鼠标才跟随（默认）、'hover' 始终跟随、'off' 关闭 */
function followMode() {
  return dom.followCursorMode?.value ?? 'drag';
}

/** 超过这么多像素才算"拖动"，否则当成轻点（轻点要能触发区域的交互） */
const DRAG_THRESHOLD = 4;

/** 把模式应用到播放器：关掉的时候要把视线复位，否则会一直盯着最后那个方向 */
function applyFollowMode() {
  const enabled = followMode() !== 'off';
  state.cubism.setTrackingEnabled(enabled);
  state.player.setTrackingEnabled?.(enabled);
  if (!enabled) {
    state.cubism.clearFocus();
    state.player.clearFocus?.();
  }
}

/**
 * 待机动作必须每次按变量重新挑：
 * 同一组里 pi=0 是 Stand、pi=1 是 Stand_s01，换装后如果还硬记着 Stand，
 * 切动作回来就会"闪回初始服装"。具体规则见 live2dex.pickIdle（也覆盖 idle#1 这种组名）。
 */
function resolveIdle() {
  /* 第四条参数是"骨架里的动画名清单"：二进制骨架的动画表要加载后才读得到，
     而这种包又常常没有带动画的互动条目 —— 只按互动挑会一条都挑不出来
     （实测 3006099166/Moranjianxindiaochan01、3155134958/H048），
     加载完"轨道是空的"、画面停在 setup pose。规则同时被播放器自检复用，
     保证两边挑的是同一段。 */
  return pickIdle(
    state.interactions,
    state.variables,
    (name: any) => state.player.hasAnimation?.(name) ?? true,
    (state.animations || []).map((item: any) => item?.name).filter(Boolean),
  );
}

/** 回到待机（互动结束后、或者用户点"待机"按钮） */
function enterIdle() {
  const idle = resolveIdle();
  if (!idle?.animation) return false;
  // 已经在播同一个循环待机就不要重新起播：重播会把循环点重来一遍，看起来像卡了一下
  const current = state.player.current;
  if (current && current.loop && current.name === idle.animation) return true;
  return playAnimation(idle.animation, true, idle.fadeInMs);
}

/**
 * 兜底：任何操作之后如果什么都没在播，就把待机接上。
 * 有些包的交互是"条件成立才有的菜单项/语音项"，条件不满足时点了等于没点；
 * 没有这一层兜底，模型会停在默认姿势上，看起来就是"点一下就停住且回不来"。
 */
function ensurePlaying() {
  if (state.playerKind !== 'spine') return;
  const entry = state.player.animationState?.getCurrent(0);
  if (!entry || !entry.animation) enterIdle();
}

/** 一次性互动播完之后按设置决定做什么（默认回待机） */
function afterInteractionFinished(interaction: any) {
  if (state.afterInteraction === 'hold') return;
  if (state.afterInteraction === 'previous' && state.previousAnimation) {
    const previous = state.animations.find((item: any) => item.name === state.previousAnimation && item.available);
    if (previous && playAnimation(previous.name, previous.loop)) return;
  }
  if (!enterIdle()) ensurePlaying();
}

function playSound(relativePath: any) {
  state.voice.setUrlResolver((path: any) => state.source?.audioUrl?.(path));
  state.voice.play(relativePath);
}

/** 用户第一次交互后补播被浏览器拦下的语音 */
function resumePendingSound() {
  state.voice.setUrlResolver((path: any) => state.source?.audioUrl?.(path));
  state.voice.resumePending();
}

function stopAudio() {
  state.voice.stop();
}

/**
 * 停止播放并释放资源。
 *
 * 切包 / 切角色 / 回首页 / 加载失败都会走这里：
 *   1. 先掐声音（旧模型的语音不能在切换之后还响），包括被浏览器拦下、等待补播的那条；
 *   2. 再拆模型 —— Spine 释放贴图与骨架、Cubism 销毁 PIXI 模型，顺带清掉后置命令定时器；
 *   3. 最后清掉界面上的临时状态（选项面板、拖拽/跟随标志、坐标）。
 */
function releasePlayback() {
  stopAudio();
  hideChoices();
  state.following = false;
  state.dragActive = false;
  state.pointer = null;
  state.pinchDistance = 0;
  state.pointers.clear();
  try {
    if (state.playerKind === 'cubism') state.cubism.dropModel();
    else state.spine.dispose?.();
  } catch {
    /* 释放失败不该影响后续加载 */
  }
  // 变量条件里的 `@参数` 读取器指向的是刚被销毁的模型，这里一并清掉
  state.variables.parameterOf = null;
  if (state.player) state.player.variableOf = null;
}

/** 点击画布：命中点击区域就播对应动作，否则随机播一个"点击"动作 */
function handleCanvasClick(cssX: any, cssY: any) {
  const character = state.character;
  if (!character) return;
  /* 点击是"发了就走"，不阻塞指针事件。routeCanvasClick 是 async：同步抛出的错也会变成
     rejected promise 走下面这个 catch，所以外面不需要（也不可能）再包一层 try。 */
  void routeCanvasClick(cssX, cssY, character).catch((error: any) => {
    setStatus(`点击处理出错：${error.message}`, true);
  });
  // 不管走哪条分支，都不能让模型停在默认姿势上（原版点了没反应也不会"卡住"）
  ensurePlaying();
}

async function routeCanvasClick(cssX: any, cssY: any, character: any) {
  /* Cubism：两套命中机制都用上
     ① moc3 里的 HitArea drawable → Controllers.ParamHit 的**拖拽把手**（在 pointermove 里处理）
     ② 包里 model3.json 的 HitAreas → "点这个部位播哪个动作组"（菜单、换装都靠它） */
  if (state.playerKind === 'cubism') {
    /* ① 先用 moc3 的命中测试（原版就是这套）：命中哪个 drawable，就按名字找对应区域。
       比矩形命中更准：旋转/不规则网格、以及被变形器挪动的区域都能正确命中。 */
    const drawableName = state.player.hitTestDrawable?.(cssX, cssY);
    const byDrawable = drawableName
      ? (character.hitAreas ?? []).find((item: any) => item.name === drawableName || item.bone === drawableName)
      : null;
    const reference = areaMotionRef(byDrawable);
    if (reference) {
      if (showAreaMenu(byDrawable, areaEntries(byDrawable))) return;
      if (playCubismReference(reference)) return;
      return; // 解析不到时 playCubismReference 已经给了安静提示
    }

    /* ② 退路：矩形命中（有些包的点击区域不是模型里的 drawable） */
    const area = state.player.hitTest(cssX, cssY, character.hitAreas);
    const areaRef = areaMotionRef(area);
    if (areaRef) {
      // 这个组里有多个可选项时，像原版一样弹"选择"菜单（例如 BS_10 → qiehuan 的两条分支）
      if (showAreaMenu(area, areaEntries(area))) return;
      if (playCubismReference(areaRef)) return;
      return;
    }

    /* ③ 都没命中就什么都不做 —— 原版就是这样：点空白处不会随机播动作。
       包里的隐藏代理区域（TouchIdle 与 TouchDrag 那批，实测被作者放在模型框之外）
       是通过**包自己的状态机**触发的（变量 + 参数锁定 + 各区域的动作），不是靠随机播放。 */
    if (area) setStatus(`命中区域：${area.name}（这个区域没有绑定动作）`);
    return;
  }

  const area = state.player.hitTest(cssX, cssY, character.hitAreas);
  if (area?.motion) {
    // hit_areas 的 motion 就是动作组名（有些带 "组:名字"，例如 "switch:title"）
    if (showAreaMenu(area, areaEntries(area))) return;
    if (playChainedTarget(String(area.motion))) return;
  }

  const tap = pickTapInteraction();
  if (tap) {
    runInteraction(tap);
    return;
  }
  const fallback = state.animations.find((item: any) => item.available && !item.loop);
  if (fallback) playAnimation(fallback.name, false);
}

/* ------------------------------------------------------------------ *
 * 本地目录模式
 * ------------------------------------------------------------------ */

/**
 * 拖入 `.lpk`：
 *   * 服务器模式（探测到 /api）：上传给服务器解包，落盘后跳转到该包；
 *   * 静态模式（没有 /api）：在**浏览器里**用 @lpk/unpacker 解包，
 *     结果经 MemorySource 直接交给播放器 —— 只放内存，刷新即失效（这是明确接受的取舍）。
 *
 * 两条路最终都得到"一份 manifest + 一个 source"，所以下游渲染逻辑完全共用。
 */
async function loadFromLpk(file: File, allFiles: File[]) {
  /* STM_1_0（Steam 创意工坊）包的密钥要用同目录 config.json 里的字段推导。
     服务器模式是服务器自己去读；浏览器读不到磁盘，所以必须让用户**一起拖进来**
     （拖整个包目录，或 .lpk + config.json 一起选）。缺了它解出来会认不出模型。 */
  const configFile = allFiles.find((f) => f.name.toLowerCase() === 'config.json') ?? null;

  if (state.mode === 'server') {
    setStatus(`正在上传 ${file.name} 交给服务器解包…`);
    try {
      const { id } = await unpackOnServer(file, allFiles);
      setStatus(`服务器已解包 ${id}，正在打开…`);
      await loadPackageList();
      /* 列表页有自己的缓存（启动时那次是 0 个包），服务器上多了包必须让它重拉，
         否则回到首页看到的是旧列表。 */
      gallery?.invalidate();
      state.packageId = id;
      dom.packageSelect.value = id;
      await selectPackage(id);
      /* 与静态模式同理：改 hash 让链接可分享，再显式走一次路由 ——
         hashchange 是异步事件，只靠它视图会晚一拍（拖入后还停在列表页）。 */
      if (!location.hash.startsWith(`#${id}`)) location.hash = `#${id}/`;
      applyRoute();
    } catch (error: any) {
      setStatus(`服务器解包失败：${error.message}`, true);
    }
    return;
  }

  setStatus(`正在浏览器里解包 ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const externalConfig = configFile
      ? { bytes: new Uint8Array(await configFile.arrayBuffer()), name: configFile.name }
      : null;
    const io = new MemoryIO();
    const started = performance.now();
    let result;
    try {
      result = unpackLpk({ bytes, name: file.name, outDir: '.', io, externalConfig, log: () => {} });
    } catch (error: any) {
      /* 认不出模型时，最常见的原因就是少了 config.json —— 直接把该怎么做说清楚 */
      if (!externalConfig && /没有找到模型配置/.test(String(error?.message ?? ''))) {
        setStatus(
          `解包失败：这个包（STM_1_0）需要同目录的 config.json 才能解密。` +
            `请把 .lpk 和 config.json 一起拖进来，或直接拖整个包目录。`,
          true,
        );
        return;
      }
      throw error;
    }
    const elapsed = Math.round(performance.now() - started);
    const source = new MemorySource(io.files);

    /* 预览图用内存源里那张图的 blob URL —— 它只在这个页面存活期内有效，符合"结果只在内存里" */
    const previewPath = result.manifest.package.preview;
    let previewUrl: string | null = null;
    if (previewPath) {
      try {
        previewUrl = source.resolve(previewPath);
      } catch {
        previewUrl = null;
      }
    }

    await showLocalPackage({
      manifest: result.manifest,
      source,
      title: result.manifest.package.title ?? file.name,
      packType: '浏览器内解包',
      preview: previewUrl,
      status: `已在浏览器里解包 ${file.name}：${result.manifest.characters.length} 个角色 / ${io.files.size} 个文件（${elapsed} ms，结果只在内存里，刷新即失效）`,
    });
  } catch (error: any) {
    setStatus(`浏览器内解包失败：${error.message}`, true);
  }
}

/**
 * 把一个**本地来源**挂到列表并切到播放页。
 *
 * 两条路都汇到这里：浏览器内解包的 `.lpk`、以及直接拖进来的**解包后目录** ——
 * 它们最终都是"一份 manifest + 一个 source"，所以后续处理完全一样：
 *   1. 记成 `localPackageEntry`（它不在 packages.json / `/api` 里，列表重拉时要靠它补回来）；
 *   2. 生成同 schema 的列表条目并追加 —— 首页立刻能看到这个包；
 *   3. 改 hash 让链接可分享，并**显式调用一次 applyRoute()**：hashchange 是异步事件，
 *      只靠它视图会晚一拍（表现为"拖进去了但画面还停在列表页"）。
 */
async function showLocalPackage(options: {
  manifest: any;
  source: any;
  title: string;
  packType: string;
  preview?: string | null;
  status: string;
}): Promise<void> {
  const { manifest, source, title, packType, preview = null, status } = options;
  state.source?.release?.();
  state.source = source;
  state.manifest = manifest;
  state.packageId = LOCAL_PACKAGE_ID;
  dom.packageSelect.disabled = true;

  const entry = {
    id: LOCAL_PACKAGE_ID,
    base: '',
    manifest: '',
    title,
    author: manifest.package?.author ?? null,
    packType,
    characters: manifest.characters.length,
    characterIds: manifest.characters.map((c: any) => c.id),
    avatar: null,
    preview,
    kinds: [...new Set(manifest.characters.map((c: any) => c.kind ?? 'spine'))] as string[],
  };
  localPackageEntry = entry;
  hiddenPackages.delete(LOCAL_PACKAGE_ID);
  state.packages = [entry, ...(state.packages ?? []).filter((item: any) => item.id !== LOCAL_PACKAGE_ID)];

  renderPackageMeta(manifest);
  renderCharacterSelect(manifest);
  await selectCharacter(0);
  gallery?.add(entry);
  updateGalleryWelcome();
  location.hash = `#${LOCAL_PACKAGE_ID}/${encodeURIComponent(manifest.characters[0]?.id ?? '')}`;
  applyRoute();
  setStatus(status);
}

/**
 * 首页空态：一个包都没有时显示"拖进来"的引导（拖放区 + 两个选择按钮）。
 * "筛选没命中"由列表页自己显示另一条提示 —— 两者是不同情况，不能混用文案。
 */
function updateGalleryWelcome(): void {
  dom.galleryWelcome.hidden = (state.packages ?? []).length > 0;
}

/**
 * 「打包下载」页：输入**解包前的目录**（装着 .lpk，可能还有同级 config.json），
 * 输出**解包后的 zip**。全部在浏览器里完成，服务器模式与纯内存模式行为一致。
 */
function setupZipPage(): void {
  let jobs: PackJob[] = [];

  const logLines: string[] = [];
  const renderLog = (): void => {
    dom.zipLog.hidden = logLines.length === 0;
    dom.zipLog.replaceChildren(
      ...logLines.map((line) => {
        const row = document.createElement('div');
        row.className = 'zip-log-line';
        row.textContent = line;
        return row;
      }),
    );
  };
  const log = (line: string): void => {
    logLines.push(line);
    renderLog();
  };

  const setJobs = async (files: File[]): Promise<void> => {
    jobs = await collectPacks(files);
    logLines.length = 0;
    dom.zipStart.disabled = jobs.length === 0;
    if (jobs.length === 0) {
      dom.zipSummary.textContent = '没找到 .lpk —— 选一个装着 .lpk 的目录（或直接选 .lpk 文件）';
      renderLog();
      return;
    }
    const withConfig = jobs.filter((job) => job.config).length;
    dom.zipSummary.textContent = `找到 ${jobs.length} 个包（其中 ${withConfig} 个带同目录 config.json）`;
    log(`已选 ${jobs.length} 个包：${jobs.map((job) => job.folder).join('、')}`);
    if (withConfig < jobs.length) log(`提示：有 ${jobs.length - withConfig} 个包没有同目录 config.json，STM_1_0 包会解不出模型`);
    renderLog();
  };

  dom.zipPickFolder.addEventListener('click', () => dom.zipFolderInput.click());
  dom.zipPickFiles.addEventListener('click', () => dom.zipFileInput.click());
  /* setJobs 是 async（要读 config.json 才知道预览图叫什么），这里显式处理返回的 Promise，
     避免"未捕获的 rejection"这种只在控制台闪一下的问题。 */
  const pickJobs = (files: ArrayLike<File>): void => {
    void setJobs(Array.from(files)).catch((error: any) => log(`读取所选内容失败：${error.message}`));
  };
  dom.zipFolderInput.addEventListener('change', (event: any) => pickJobs(event.target.files || []));
  dom.zipFileInput.addEventListener('change', (event: any) => pickJobs(event.target.files || []));
  dom.zipBack.addEventListener('click', () => {
    location.hash = '#';
  });

  /* 拖入：整页都能接 */
  dom.zipPage.addEventListener('dragover', (event: any) => {
    event.preventDefault();
    dom.zipDrop.classList.add('active');
  });
  dom.zipPage.addEventListener('dragleave', (event: any) => {
    /* 在子元素之间移动也会触发 dragleave，只有真正离开页面才取消高亮 */
    if (event.target === dom.zipPage) dom.zipDrop.classList.remove('active');
  });
  dom.zipPage.addEventListener('drop', async (event: any) => {
    event.preventDefault();
    dom.zipDrop.classList.remove('active');
    try {
      const files = (await collectDroppedFiles(event.dataTransfer)) as File[];
      await setJobs(files);
    } catch (error: any) {
      log(`读取拖入内容失败：${error.message}`);
    }
  });

  dom.zipStart.addEventListener('click', async () => {
    if (jobs.length === 0) return;
    dom.zipStart.disabled = true;
    logLines.length = 0;
    const started = performance.now();
    try {
      const { blob, results } = await buildZip(jobs, (progress) => {
        log(`[${progress.index}/${progress.total}] ${progress.folder ? `${progress.folder} ` : ''}${progress.message}`);
        dom.zipSummary.textContent = `正在处理 ${progress.index}/${progress.total} …`;
      });
      const failed = results.filter((item) => !item.ok);
      const okBytes = results.filter((item) => item.ok).reduce((sum, item) => sum + item.bytes, 0);
      const name = `lpk-unpacked-${new Date().toISOString().slice(0, 10)}.zip`;
      downloadBlob(blob, name);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      dom.zipSummary.textContent = `完成：${results.length - failed.length}/${results.length} 个包，${(okBytes / 1024 / 1024).toFixed(1)} MB → ${name}`;
      log(`zip ${(blob.size / 1024 / 1024).toFixed(1)} MB，用时 ${seconds}s，已开始下载：${name}`);
      if (failed.length > 0) log(`有 ${failed.length} 个包失败：${failed.map((item) => item.folder).join('、')}`);
    } catch (error: any) {
      dom.zipSummary.textContent = `打包失败：${error.message}`;
      log(`✘ ${error.message}`);
    } finally {
      dom.zipStart.disabled = false;
      renderLog();
    }
  });
}

async function loadFromFileList(files: any) {
  if (!files || files.length === 0) return;

  /* 拖进来的是 .lpk：服务器模式上传解包，静态模式在浏览器里解包（结果只放内存） */
  const fileArray = Array.from(files) as File[];
  const lpkFile = findLpkFile(fileArray);
  if (lpkFile) {
    await loadFromLpk(lpkFile, fileArray);
    return;
  }

  /* 不是 .lpk，那就是**已经解包好的目录**（包目录，或单个角色目录）：
     直接当本地来源用，不经过解包器。 */
  const described = describeFileSet(files);
  const source = new FolderSource(files, described.prefix);
  try {
    if (described.kind === 'package') {
      const manifest = await readManifestFromFileSet(files, described.prefix);
      await showLocalPackage({
        manifest,
        source,
        title: manifest.package?.title ?? described.prefix ?? '本地目录',
        packType: '本地目录',
        status: `已从本地目录加载 ${described.prefix || '包'}：${manifest.characters.length} 个角色`,
      });
    } else {
      const character = await detectCharacterFromFolder(source);
      await showLocalPackage({
        manifest: { package: { title: character.title, mlveType: '本地目录' }, source: { entryCount: 0 }, characters: [character] },
        source,
        title: character.title ?? character.id,
        packType: '本地角色目录',
        status: `已从本地目录加载角色 ${character.id}`,
      });
    }
  } catch (error: any) {
    source.release();
    setStatus(`本地目录加载失败：${error.message}`, true);
  }
}

/** 递归读取拖入的目录（DataTransfer 的目录项需要 webkitGetAsEntry） */
async function collectDroppedFiles(dataTransfer: any) {
  const items = Array.from(dataTransfer.items || []);
  const entries = items.map((item: any) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)).filter(Boolean);
  if (entries.length === 0) return Array.from(dataTransfer.files || []);

  const out = [] as any[];
  const readEntry = async (entry: any, path: any) => {
    if (entry.isFile) {
      const file = await new Promise((resolve: any, reject: any) => entry.file(resolve, reject));
      Object.defineProperty(file, 'webkitRelativePath', { value: `${path}${(file as File).name}` });
      out.push(file);
      return;
    }
    const reader = entry.createReader();
    let batch = [] as any[];
    do {
      batch = await new Promise((resolve: any, reject: any) => reader.readEntries(resolve, reject));
      for (const child of batch) await readEntry(child, `${path}${entry.name}/`);
    } while (batch.length > 0);
  };

  for (const entry of entries) await readEntry(entry, '');
  return out;
}

/* ------------------------------------------------------------------ *
 * 交互事件
 * ------------------------------------------------------------------ */

function wireEvents() {
  // TODO(review): 这个函数近 290 行，把控件绑定、画布手势、键盘、尺寸监听全塞在一起，
  //   TODO：后续按"控件 / 画布手势 / 键盘 / 尺寸"拆开（现在不动，避免打乱事件顺序）。
  dom.packageSelect.addEventListener('change', (event: any) => selectPackage(event.target.value));
  dom.characterSelect.addEventListener('change', (event: any) => {
    const index = (state.manifest?.characters ?? []).findIndex((character: any) => character.id === event.target.value);
    // selectCharacter 内部会把 hash 写成新角色
    if (index >= 0) selectCharacter(index);
  });

  // 浏览器要求先有一次用户交互才允许播放声音：第一次点/按键时补播入场语音
  window.addEventListener('pointerdown', resumePendingSound, { once: true });
  window.addEventListener('keydown', resumePendingSound, { once: true });

  // 路由（含包内换角色）统一由 applyRoute 处理，见文件开头的 hashchange 监听

  dom.speed.addEventListener('input', () => {
    /* 倍速只存进 state：真正生效的地方是渲染循环里的 `player.update(delta * state.speed)`。
       播放器侧那个 setSpeed 已经删掉了（另一个 agent 的 review 结论：没有任何地方读它）。 */
    state.speed = Number(dom.speed.value);
    dom.speedValue.textContent = `${state.speed.toFixed(2)}×`;
  });

  dom.autoIdle.addEventListener('change', () => {
    // 复选框 = "一次性动作播完后回待机还是停住"
    state.afterInteraction = dom.autoIdle.checked ? 'idle' : 'hold';
  });

  dom.showDebug.addEventListener('change', () => {
    state.spine.showDebug = dom.showDebug.checked;
    state.player.setShowDebug?.(dom.showDebug.checked);
  });

  dom.showHitAreas.addEventListener('change', () => {
    state.showHitAreas = dom.showHitAreas.checked;
    dom.hitAreaLayer.hidden = !state.showHitAreas;
    if (!state.showHitAreas) {
      dom.hitAreaLayer.innerHTML = '';
      state.hitAreaSignature = '';
    }
  });

  // 切换跟随方式：关掉时把注视位置复位，而不是停在最后的位置
  dom.followCursorMode.addEventListener('change', applyFollowMode);

  dom.followGain.addEventListener('input', () => {
    const gain = Number(dom.followGain.value);
    dom.followGainValue.textContent = `${gain.toFixed(2)}×`;
    state.cubism.setTrackingGain(gain);
  });

  dom.resetView.addEventListener('click', () => state.player.resetView());

  /* 画布外触发区：一个按钮 + sheerly-sheet（次要内容不常驻屏幕） */
  dom.areaToggle.addEventListener('click', () => dom.areaSheet.showModal());
  el('areaSheetClose').addEventListener('click', () => dom.areaSheet.close());
  dom.areaSheet.addEventListener('click', (event: any) => {
    // 点 sheet 背板（dialog 自身）也关掉
    if (event.target === dom.areaSheet) dom.areaSheet.close();
  });

  /* 选项菜单的 light dismiss：点面板外面任何地方、按 Esc 都关掉。
     popover 自己也会在点外面/Esc 时关闭，但我们仍在捕获阶段先关一次 ——
     这样"点画布关面板"只关面板、不会顺带又触发一次互动。 */
  document.addEventListener(
    'pointerdown',
    (event: any) => {
      if (!choiceMenuOpen()) return;
      if (dom.choiceBox.contains(event.target)) return;
      hideChoices();
      state.dismissedAt = performance.now();
    },
    true,
  );
  document.addEventListener('keydown', (event: any) => {
    if (event.key !== 'Escape') return;
    hideChoices();
    setNavOpen(false);
  });

  /* 主题切换：sheerly 用 .dark 类，选择记在 localStorage 里（首帧由 <head> 的内联脚本先落地） */
  for (const toggle of document.querySelectorAll('.theme-toggle')) {
    toggle.addEventListener('click', () => setTheme(!document.documentElement.classList.contains('dark')));
  }
  if (window.matchMedia) {
    // 用户没手动选过时跟随系统
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', (event: any) => {
      let saved = null;
      try {
        saved = localStorage.getItem('lpk-theme');
      } catch {
        saved = null;
      }
      if (!saved) setTheme(event.matches);
    });
  }

  /* 移动端抽屉开关 */
  dom.navToggle.addEventListener('click', () => setNavOpen(!document.body.classList.contains('nav-open')));
  dom.navBackdrop.addEventListener('click', () => setNavOpen(false));
  dom.playIdle.addEventListener('click', () => {
    if (state.playerKind === 'cubism') {
      /* "待机"按钮：用和加载时**同一个**选法（pickIdleCubismMotion）—— 挑的不是同一条的话，
         按钮按下去会切到另一段动作上，而原版一直播同一段待机。 */
      const idle = pickIdleCubismMotion();
      if (idle) playCubismMotion(idle.motion.group, idle.index);
      return;
    }
    enterIdle();
  });
  dom.stopAll.addEventListener('click', () => {
    state.spine.stop?.();
    stopAudio();
  });

  dom.folderInput.addEventListener('change', (event: any) => loadFromFileList(Array.from(event.target.files || [])));
  dom.lpkInput.addEventListener('change', (event: any) => loadFromFileList(Array.from(event.target.files || [])));
  dom.pickLpk.addEventListener('click', () => dom.lpkInput.click());
  dom.pickFolder.addEventListener('click', () => dom.folderInput.click());
  dom.openZipPage.addEventListener('click', () => {
    location.hash = `#${ZIP_PAGE_ID}`;
  });
  setupZipPage();

  /* 拖拽：画布上是"加载这个目录"，首页上是"拖进来解包/加载"——
     两处都调 loadFromFileList，支持的东西完全一样（.lpk / 解包后的包目录 / 单个角色目录）。 */
  const dropTargets: Array<{ element: HTMLElement; zone: HTMLElement }> = [
    { element: dom.canvas.parentElement ?? dom.canvas, zone: dom.dropZone },
    /* 首页整屏都能接：空态时用户最自然的动作就是往页面中间一拖 */
    { element: document.getElementById('gallery') ?? dom.galleryDrop, zone: dom.galleryDrop },
  ];
  for (const { element, zone } of dropTargets) {
    element.addEventListener('dragover', (event: any) => {
      event.preventDefault();
      zone.classList.add('active');
    });
    element.addEventListener('dragleave', () => zone.classList.remove('active'));
    element.addEventListener('drop', async (event: any) => {
      event.preventDefault();
      zone.classList.remove('active');
      setStatus('正在读取拖入的内容 …');
      try {
        const files = await collectDroppedFiles(event.dataTransfer);
        await loadFromFileList(files);
      } catch (error: any) {
        setStatus(`读取拖入内容失败：${error.message}`, true);
      }
    });
  }

  /* 画布：拖动平移 / 拖拽参数（原版的"拖裙子、拖丝袜"）/ 滚轮缩放 / 单击互动 */
  for (const canvas of [dom.canvas, dom.cubismCanvas]) {
    canvas.addEventListener('pointerdown', (event: any) => {
      // 刚被 light dismiss 的那一下点击只用来关面板，不再触发互动
      if (state.dismissedAt && performance.now() - state.dismissedAt < 400) return;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* 某些合成事件没有有效 pointerId，忽略即可 */
      }
      state.pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
      // 双指：进入缩放模式（移动端捏合缩放）
      if (state.pointers.size === 2) {
        const [a, b] = [...state.pointers.values()];
        state.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
        state.pointer = null;
        state.dragActive = false;
        return;
      }
      if (state.pointers.size > 2) return;
      state.pointer = { x: event.offsetX, y: event.offsetY, moved: 0, dragged: false };
      // 命中"拖拽把手"时进入拖拽模式，此时不平移视图
      state.dragActive = false;
      if (state.playerKind === 'cubism') {
        const hitName = state.player.hitTestDrawable?.(event.offsetX, event.offsetY);
        state.dragActive = Boolean(hitName && state.player.beginDrag?.(event.offsetX, event.offsetY, hitName));
        // "按住鼠标才跟随"：按下就开始看，松开停住（再按一下换个方向）
        if (!state.dragActive && followMode() === 'drag') {
          state.following = true;
          state.player.focus?.(event.offsetX, event.offsetY);
        }
      }
    });
    canvas.addEventListener('pointermove', (event: any) => {
      if (state.pointers.has(event.pointerId)) state.pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
      // 双指捏合缩放
      if (state.pointers.size >= 2) {
        const [a, b] = [...state.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (state.pinchDistance > 0 && distance > 0) {
          state.player.zoomBy(distance / state.pinchDistance, (a.x + b.x) / 2, (a.y + b.y) / 2);
        }
        state.pinchDistance = distance;
        return;
      }
      // 光标形状：可点区域 pointer、把手/空白 grab、拖动中 grabbing
      if (!state.pointer) updateCanvasCursor(event.offsetX, event.offsetY, canvas);
      /* 光标追踪（Cubism 的头部/眼球跟随），两种方式：
         hover —— 鼠标一动就跟随；drag —— 按住鼠标期间才跟随 */
      if (state.playerKind === 'cubism' && !state.dragActive) {
        if (followMode() === 'hover') state.player.focus?.(event.offsetX, event.offsetY);
        else if (state.following) state.player.focus?.(event.offsetX, event.offsetY);
      }
      if (!state.pointer) return;
      const dx = event.offsetX - state.pointer.x;
      const dy = event.offsetY - state.pointer.y;
      state.pointer.x = event.offsetX;
      state.pointer.y = event.offsetY;
      state.pointer.moved += Math.abs(dx) + Math.abs(dy);
      /* 只要位移超过阈值，这一次按下就不再算"点击" —— 不管是拖参数还是移动画布。
         否则平移完抬手会顺带触发一次交互（用户只是想挪一下画面）。 */
      if (state.pointer.moved > DRAG_THRESHOLD) state.pointer.dragged = true;
      /* 拖拽把手只在实际拖动之后才生效：
         同一个区域往往既要能拖（拖裙子/丝袜）、又要能点（摸头、菜单），
         如果按下就吃掉，点这个区域就再也触发不了交互了。 */
      if (state.dragActive) {
        if (state.pointer.dragged) {
          for (const group of state.player.dragTo?.(event.offsetX, event.offsetY) ?? []) playCubismReference(group);
        }
        return;
      }
      if (state.pointer.moved > DRAG_THRESHOLD) state.player.panBy(dx, dy);
    });
    canvas.addEventListener('pointerup', (event: any) => {
      state.pointers.delete(event.pointerId);
      if (state.pointers.size < 2) state.pinchDistance = 0;
      const pointer = state.pointer;
      const dragged = Boolean(pointer?.dragged);
      state.pointer = null;
      state.dragActive = false;
      // 按住期间跟随的：松开就停在当前注视方向（下次按住再改）
      state.following = false;
      // EndMtn（松手且没拖到极值）等触发动作也要播
      for (const group of state.player.endDrag?.() ?? []) playCubismReference(group);
      if (dragged) return; // 真拖动过：不算点击
      // 没有配对的 pointerdown（例如被 light dismiss 吃掉的那一下、或双指缩放）不算点击
      if (!pointer) return;
      // 轻点：即使落在拖拽把手上，也要照常触发这个区域的交互
      handleCanvasClick(event.offsetX, event.offsetY);
      // 松开后光标回到"这里能不能点"的状态
      updateCanvasCursor(event.offsetX, event.offsetY, canvas);
    });
    canvas.addEventListener('pointercancel', (event: any) => {
      state.pointers.delete(event.pointerId);
      if (state.pointers.size < 2) state.pinchDistance = 0;
      for (const group of state.player.endDrag?.() ?? []) playCubismReference(group);
      state.dragActive = false;
      state.following = false;
      state.pointer = null;
      canvas.style.cursor = 'crosshair';
    });
    canvas.addEventListener('pointerleave', () => {
      // 只有"始终跟随"才在移出画布时复位；按住跟随的松手后应当保持
      if (state.playerKind === 'cubism' && !state.dragActive && followMode() === 'hover') {
        state.player.clearFocus?.();
      }
    });
    canvas.addEventListener(
      'wheel',
      (event: any) => {
        event.preventDefault();
        state.player.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.offsetX, event.offsetY);
      },
      { passive: false },
    );
  }

  /** 正在输入框/下拉框里打字时不要抢键 */
  const isTypingTarget = (target: any) =>
    Boolean(target) && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? '');

  window.addEventListener('keydown', (event: any) => {
    // 模型自己声明的按键触发（Controllers.KeyTrigger）优先：原版也是按这个表分发
    if (state.playerKind === 'cubism' && !isTypingTarget(event.target)) {
      const triggered = state.player.keyTriggerFor?.(event.keyCode, 'down');
      if (triggered && playCubismReference(triggered)) {
        event.preventDefault();
        return;
      }
    }
    if (event.code === 'Space' && !isTypingTarget(event.target)) {
      event.preventDefault();
      if (state.voice.playing) stopAudio();
      else dom.playIdle.click();
    }
  });

  window.addEventListener('keyup', (event: any) => {
    if (state.playerKind !== 'cubism' || isTypingTarget(event.target)) return;
    const triggered = state.player.keyTriggerFor?.(event.keyCode, 'up');
    if (triggered) playCubismReference(triggered);
  });

  const resizeObserver = new ResizeObserver(() => {
    state.spine.resizeViewport();
    state.cubism.resize();
  });
  const observeTarget = dom.canvas.parentElement;
  if (observeTarget) resizeObserver.observe(observeTarget);
}

/* ------------------------------------------------------------------ *
 * 界面小工具
 * ------------------------------------------------------------------ */

function setStatus(message: any, isError = false) {
  // 状态栏里还放着一个入口按钮，所以只改文本节点，不能直接覆盖 textContent
  dom.statusText.textContent = message;
  dom.status.classList.toggle('error', Boolean(isError));
}

/**
 * "可触发区域"叠加层：把每个点击区域按当前视图画成红框（和原版一样）。
 * 每帧调用，但只有矩形真的变了才动 DOM。
 */
function updateHitAreaLayer() {
  if (!state.showHitAreas || !state.character) return;
  const player = state.player;
  const rects = player.hitAreaRects?.(state.character.hitAreas) ?? [];
  /* 矩形是**画布坐标**，而这一层是叠在页面上的，两者不一定同原点（画布可能有边框/内边距、
     布局变化时画布也会挪）。所以按"画布相对本层"的偏移来放框 —— 画布一动，框就跟着动。
     **必须用播放器自己的画布**：Spine 模型渲染在 #stage 上，#stage-cubism 在那种情况下是
     隐藏的 0×0 画布，拿它算偏移会得到 `0 - 340 = -340`，于是所有红框整体左移一个侧栏的宽度
     —— 这正是"框和角色对不上"的原因（实测：画布内 x=367 的框被画到了视口 x=367，
     而它本该在 340+367=707）。 */
  const canvasEl = player?.canvas ?? el('stage-cubism');
  let offsetX = 0;
  let offsetY = 0;
  if (canvasEl && canvasEl.clientWidth > 0 && canvasEl.clientHeight > 0) {
    const canvasRect = canvasEl.getBoundingClientRect();
    const layerRect = dom.hitAreaLayer.getBoundingClientRect();
    offsetX = canvasRect.left - layerRect.left;
    offsetY = canvasRect.top - layerRect.top;
  }
  const signature = `${offsetX.toFixed(1)},${offsetY.toFixed(1)}|` + rects
    .map((r: any) => `${r.name}:${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`)
    .join('|');
  if (signature === state.hitAreaSignature) return;
  state.hitAreaSignature = signature;

  const fragment = document.createDocumentFragment();
  for (const rect of rects) {
    const box = document.createElement('div');
    box.className = 'hit-rect';
    box.style.left = `${rect.x + offsetX}px`;
    box.style.top = `${rect.y + offsetY}px`;
    box.style.width = `${Math.max(2, rect.width)}px`;
    box.style.height = `${Math.max(2, rect.height)}px`;
    const label = document.createElement('span');
    label.textContent = rect.name ?? '';
    box.append(label);
    fragment.append(box);
  }
  dom.hitAreaLayer.replaceChildren(fragment);
}

function updateHud(now: any) {
  const player = state.player;
  const isCubism = state.playerKind === 'cubism';
  const current = isCubism
    ? player.currentMotion
      ? {
          name: `${player.currentMotion.group}${player.currentMotion.label ? `·${player.currentMotion.label}` : ''}`,
          loop: true,
          duration: 0,
        }
      : null
    : player.current;
  const track = !isCubism && player.animationState ? player.animationState.getCurrent(0) : null;
  const trackTime = track ? track.trackTime : 0;
  const percent = current && current.duration > 0 ? Math.min(100, (trackTime / current.duration) * 100) : 0;

  if (state.hudFrameTime) {
    const instant = 1000 / Math.max(now - state.hudFrameTime, 1);
    state.fps = state.fps ? state.fps * 0.9 + instant * 0.1 : instant;
  }
  state.hudFrameTime = now;

  const text = [
    state.character ? state.character.id : '未加载',
    current ? `${current.name}${current.loop ? '（循环）' : ''}` : '待机',
    `${state.speed.toFixed(2)}×`,
  ].join(' · ');
  const key = `${text}|${Math.round(percent)}`;
  if (key === state.lastHud) return;
  state.lastHud = key;
  // 进度条直接用组件库的 sheerly-progress（原生 <progress>，语义也更对）
  dom.hud.innerHTML =
    `<span class="hud-title">${escapeHtml(text)}</span>` +
    `<progress class="sheerly-progress" max="100" value="${percent.toFixed(1)}"></progress>` +
    `<span class="fps">${Math.round(state.fps || 0)} fps</span>`;
}

function escapeHtml(value: any) {
  return String(value).replace(
    /[&<>"']/g,
    (char: any) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[char],
  );
}

boot();
