/**
 * LPK 解包主流程
 *
 * 流程：
 *   1. 打开 LPK（ZIP）→ 找到明文 config.mlve（包描述）
 *   2. 依据 type 推导每个条目的密钥种子，逐条解密
 *   3. 按内容识别成原始资源（PNG / MP3 / Spine 骨架 / Spine 图集 / 模型配置 …）
 *   4. 依据模型配置里的引用关系，重建成"原始资源目录"（骨架 + 图集 + 贴图 + 语音）
 *   5. 输出 manifest.json，供 HTML 播放器直接加载
 *
 * 平台约束：本文件**不导入任何 node:\* 模块**。所有读写都通过注入的 UnpackIO 完成，
 * 路径一律是 POSIX 相对路径（见 posix.ts）；这样同一份代码在 Node 与浏览器里都能跑。
 */
import { ZipArchive, type ZipEntry } from './zip.ts';
import { encodeText, type UnpackIO } from './io.ts';
import { basename, dirname, isInside, join } from './posix.ts';
import { ENCRYPTED_NAME_RE, candidateSeeds, genKey, lpkCrypt, md5Hex } from './lpk.ts';
import {
  detect,
  detectionScore,
  imageSize,
  parseAtlasPages,
  readSpineBinaryHeader,
  tryDecodeText,
  tryParseJson,
  type AtlasPageInfo,
  type Detection,
} from './detect.ts';
import { AUDIO_EXTENSIONS, humanBytes, isAudioKind, isImageKind, sanitizeFileName, sanitizeFolderName, stripExtension } from './assets.ts';
import type {
  Manifest,
  ManifestAnimationInfo,
  ManifestCharacter,
  ManifestCubismCharacter,
  ManifestCubismMotion,
  ManifestEntryInfo,
  ManifestHitAreaInfo,
  ManifestInteractionInfo,
  ManifestSoundInfo,
} from './manifest.ts';

export const TOOL_NAME = 'lpk-next';
const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 配置结构（Live2DViewerEX）
 * ------------------------------------------------------------------ */

interface MlveCostume {
  name?: string;
  path?: string;
}

interface MlveCharacter {
  id?: string;
  character?: string;
  avatar?: string;
  costume?: MlveCostume[];
}

interface MlveConfig {
  type?: string;
  name?: string;
  id?: string;
  encrypt?: string;
  version?: string;
  list?: MlveCharacter[];
}

interface ExternalConfig {
  lpkFile?: string;
  file?: string;
  previewFile?: string;
  fileId?: string;
  type?: number;
  title?: string;
  author?: string;
  description?: string;
  metaData?: string;
}

interface Live2DExAtlas {
  atlas: string;
  tex_names?: string[];
  textures?: string[];
}

interface Live2DExMotion {
  name?: string;
  file?: string;
  file_loop?: boolean;
  /** 1 = 循环播放（背景动画靠它） */
  wrap_mode?: number;
  command?: string;
  next_mtn?: string;
  priority?: number;
  /** 淡入时长（毫秒） */
  fade_in?: number;
  /** 无动画条目的停留时长 */
  motion_duration?: number;
  sound?: string;
  text?: string;
  text_duration?: number;
  /** 选择支：选中后执行 next_mtn */
  choices?: { text?: string; next_mtn?: string; sound?: string }[];
  /** 变量指令：type 1 = 条件，type 2 = 赋值 */
  var_floats?: { name?: string; type?: number; code?: string }[];
}

interface Live2DExHitArea {
  name?: string;
  id?: string;
  motion?: string;
  width?: number;
  height?: number;
}

interface Live2DExModel {
  type?: number;
  skeleton: string;
  atlases?: Live2DExAtlas[];
  motions?: Record<string, Live2DExMotion[]>;
  hit_areas?: Live2DExHitArea[];
  options?: { scale_factor?: number; position_x?: number; position_y?: number; tex_type?: number };
}

interface SpineSkeletonDoc {
  skeleton?: { spine?: string; x?: number; y?: number; width?: number; height?: number };
  animations?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * 内部数据结构
 * ------------------------------------------------------------------ */

export interface LoadedEntry {
  zipName: string;
  size: number;
  bytes: Uint8Array;
  encrypted: boolean;
  detection: Detection;
  text: string | null;
  json: unknown;
  /** 最终写出的相对路径（未导出则为 null） */
  output: string | null;
}

export interface UnpackOptions {
  /** `.lpk` 的字节内容（由调用方读入；解包器自己不碰文件系统） */
  bytes: Uint8Array;
  /** 显示用的名字，如 `3140192145.lpk`（只用于日志与标题兜底） */
  name: string;
  /** 输出根目录（POSIX 相对路径，如 `out/3140192145`） */
  outDir: string;
  /** 落盘动作的实现：Node 侧用 node:fs，浏览器侧用内存实现 */
  io: UnpackIO;
  /** 可选的外部配置（Node 侧通常是 LPK 同目录的 config.json，已读成字节） */
  externalConfig?: { bytes: Uint8Array; name: string } | null;
  /** 可选的预览图字节（Node 侧为 preview.png 等同级文件） */
  preview?: { bytes: Uint8Array; name: string } | null;
  keepRaw?: boolean;
  log?: (line: string) => void;
}

export interface UnpackResult {
  outDir: string;
  manifestPath: string;
  manifest: Manifest;
}

const GROUP_LABELS: Record<string, string> = {
  idle: '待机',
  start: '开场',
  tap: '点击',
  tap_: '特殊',
  'idlebg#1': '背景循环',
  switch: '语音',
  switch1: '选项',
  touch: '触摸',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/* ------------------------------------------------------------------ *
 * 1. 打开 LPK，定位 config.mlve
 * ------------------------------------------------------------------ */

function findMlveEntry(zip: ZipArchive): ZipEntry {
  const hashed = zip.find(md5Hex('config.mlve'));
  if (hashed) return hashed;
  const literal = zip.find('config.mlve');
  if (literal) return literal;
  // 兜底：扫描明文 JSON，找带 list 的包描述
  for (const entry of zip.entries) {
    const text = tryDecodeText(zip.read(entry));
    if (!text) continue;
    const json = tryParseJson(text);
    if (isRecord(json) && typeof json.type === 'string' && Array.isArray(json.list)) return entry;
  }
  throw new Error('LPK 中找不到 config.mlve（包描述）');
}

/**
 * 读取"外部配置"。解包器不碰文件系统，所以这里只处理**已经在内存里的字节**：
 * Node 侧由 CLI 读好后传入（含 LPK 同目录的 config.json），浏览器侧通常没有。
 */
function loadExternalConfig(
  externalBytes: Uint8Array | null | undefined,
  externalName: string | null | undefined,
  log?: (line: string) => void,
): ExternalConfig | null {
  if (!externalBytes || externalBytes.length === 0) return null;
  const label = externalName ?? 'config.json';
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(externalBytes)) as ExternalConfig;
    log?.(`读取外部配置：${label}`);
    return parsed;
  } catch (error) {
    log?.(`外部配置解析失败（忽略）：${label} → ${(error as Error).message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 2. 解密全部条目
 * ------------------------------------------------------------------ */

function decryptEntries(zip: ZipArchive, mlve: MlveConfig, external: ExternalConfig | null, log: (line: string) => void): LoadedEntry[] {
  const encryptEnabled = mlve.encrypt !== 'false';
  const mlveId = typeof mlve.id === 'string' ? mlve.id : String(mlve.id ?? '');
  const keysFor = (name: string): number[] => {
    if (!encryptEnabled) return [0];
    const seeds = candidateSeeds(mlveId, name, external?.fileId ?? null, external?.metaData ?? null);
    return [...new Set(seeds.map(genKey))];
  };

  const entries: LoadedEntry[] = [];
  let encryptedCount = 0;

  for (const ze of zip.entries) {
    const raw = zip.read(ze);
    const rawDetection = detect(raw);
    const nameHintsEncrypted = ENCRYPTED_NAME_RE.test(ze.name);

    let best: { bytes: Uint8Array; detection: Detection } | null = null;
    if (encryptEnabled) {
      for (const key of keysFor(ze.name)) {
        const bytes = lpkCrypt(key, raw);
        const detection = detect(bytes);
        if (!best || detectionScore(detection) > detectionScore(best.detection)) best = { bytes, detection };
        if (detectionScore(detection) >= 3) break; // 命中明确类型，无需继续试
      }
    }

    const rawScore = detectionScore(rawDetection);
    const bestScore = best ? detectionScore(best.detection) : -1;

    let bytes = raw;
    let encrypted = false;
    if (best && bestScore > rawScore) {
      bytes = best.bytes;
      encrypted = true;
    } else if (rawScore > bestScore) {
      bytes = raw; // 明文条目（预览图、包配置等）
    } else if (nameHintsEncrypted && best) {
      bytes = best.bytes;
      encrypted = true;
    }

    if (encrypted) encryptedCount++;
    const text = tryDecodeText(bytes);
    entries.push({
      zipName: ze.name,
      size: bytes.length,
      bytes,
      encrypted,
      detection: best && encrypted ? best.detection : rawDetection,
      text,
      json: text ? tryParseJson(text) : null,
      output: null,
    });
  }

  log(`解密完成：${entries.length} 个条目（加密 ${encryptedCount} / 明文 ${entries.length - encryptedCount}）`);
  return entries;
}

/* ------------------------------------------------------------------ *
 * 3. 组装角色
 * ------------------------------------------------------------------ */

interface AtlasBuild {
  entry: LoadedEntry;
  pages: AtlasPageInfo[];
  textures: Array<LoadedEntry | null>;
  fileName: string;
}

/** 一个图集里的一页：图集声明的页名、实际写出的文件名、对应的贴图条目 */
interface TexturePagePlan {
  /** 图集文本里声明的页名 */
  page: string;
  /** 磁盘上的文件名（重名时会加 .v2 之类的后缀，同时改写图集文本） */
  file: string;
  entry: LoadedEntry | null;
}

/** 一套贴图 = 一个图集文件 + 它引用的所有页（Live2DViewerEX 用它切换服装/和谐版） */
interface TextureSetPlan {
  atlasFile: string;
  pages: TexturePagePlan[];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 角色目录名去重：两个角色可能用同一个资源名（图集第一页 / 包标题），
 * 后一个依次尝试 `<名字>-2`、`<名字>-3`…，并把最终结果登记进 usedIds。
 */
function uniqueCharacterId(base: string, usedIds: Set<string>): string {
  let id = base;
  if (usedIds.has(id)) {
    let n = 2;
    while (usedIds.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  usedIds.add(id);
  return id;
}

/**
 * `--raw` 的落盘路径：条目名按 `/`（或 `\`）拆成路径段逐个清洗后拼回 `_raw/` 下。
 * 正常的子目录结构（`textures/a.png`）原样保留，而 `..`（Zip-Slip）与 `/etc/x`、`C:\x`
 * 这类绝对路径会被清洗掉 —— 否则 join(rawDir, zipName) 既可能因为目录不存在抛 ENOENT，
 * 也可能把文件写到 out/ 之外。
 */
function rawEntryPath(rawDir: string, zipName: string): string {
  const segments = zipName
    .split(/[\\/]+/)
    .filter((part) => part.length > 0 && part !== '.')
    .map((part) => sanitizeFileName(part, 'entry'));
  return join(rawDir, ...(segments.length > 0 ? segments : ['entry']));
}

/**
 * 正式产物（角色目录 / `_unassigned/` / 预览图…）的落盘路径。
 *
 * 这些相对路径里混着**包内条目名**（例如 `_unassigned/other/<条目名>`、`audio/<条目名>.mp3`），
 * 而条目名完全由包决定：一个写着 `../../x` 的条目名会把文件写到 out/ 之外（Zip-Slip）。
 * 正常包（条目名是 md5 或普通文件名）永远走不到这个分支，所以这里直接报错而不是"猜一个安全名字"，
 * 免得清单里的 output 路径与实际文件对不上。
 */
function outTarget(outDir: string, rel: string): string {
  const target = join(outDir, rel);
  if (!isInside(outDir, target)) {
    throw new Error(`条目的输出路径会写到 out/ 之外，已拒绝：${rel}`);
  }
  return target;
}

function walkStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) walkStrings(item, visit);
  }
}

function rewriteRefs(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteRefs(item, map));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = rewriteRefs(item, map);
    return out;
  }
  return value;
}

function buildCharacter(params: {
  modelEntry: LoadedEntry;
  byName: Map<string, LoadedEntry>;
  characterSource: MlveCharacter | null;
  title: string | null;
  usedIds: Set<string>;
  /** 包级"贴图名 → 条目 hash"（见 unpack() 里的说明）；多个角色共用贴图时靠它兜底 */
  texNameIndex?: Map<string, string>;
}): { character: ManifestCharacter; files: Map<string, Uint8Array>; outputs: Array<{ entry: LoadedEntry; path: string }> } {
  const { modelEntry, byName, characterSource, title, usedIds, texNameIndex } = params;
  const model = modelEntry.json as Live2DExModel;
  const files = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  /** 条目 → 输出相对路径（写进 manifest 的 entries[] 便于审计） */
  const outputs: Array<{ entry: LoadedEntry; path: string }> = [];

  /* 骨架：JSON 或二进制（.skel）两种格式 */
  const skeletonEntry = typeof model.skeleton === 'string' ? byName.get(model.skeleton) : undefined;
  const skeletonKind = skeletonEntry?.detection.kind;
  if (!skeletonEntry || (skeletonKind !== 'spine-skeleton' && skeletonKind !== 'spine-skeleton-binary')) {
    throw new Error(`模型 ${modelEntry.zipName} 引用的骨架无效：${String(model.skeleton)}`);
  }
  const isBinarySkeleton = skeletonKind === 'spine-skeleton-binary';
  const binaryHeader = isBinarySkeleton ? readSpineBinaryHeader(skeletonEntry.bytes) : null;
  // 二进制骨架没法在 Node 侧直接读动画表，交给播放器加载后补全
  const skeletonDoc = (isBinarySkeleton ? {} : (skeletonEntry.json ?? {})) as SpineSkeletonDoc;

  /* 图集 + 贴图 */
  const atlasBuilds: AtlasBuild[] = [];
  for (const atlas of model.atlases ?? []) {
    const atlasEntry = typeof atlas.atlas === 'string' ? byName.get(atlas.atlas) : undefined;
    if (!atlasEntry || atlasEntry.detection.kind !== 'spine-atlas') continue;

    // Live2DViewerEX 用两个平行数组描述"页名 → 贴图条目"：
    //   tex_names[i] 是图集里的页名（不含扩展名），textures[i] 是对应的贴图条目。
    // 注意这条映射必须按“名字”查，不能按下标配对 —— 两个数组的顺序经常不一致，
    // 一旦错配，页尺寸与图集声明不符，UV 会采样到完全错误的位置（画面变成一堆碎片）。
    const nameToEntry = new Map<string, LoadedEntry>();
    const texNames = atlas.tex_names ?? [];
    const texHashes = atlas.textures ?? [];
    texNames.forEach((name, index) => {
      const hash = texHashes[index];
      const entry = hash ? byName.get(hash) : undefined;
      if (entry && isImageKind(entry.detection.kind)) nameToEntry.set(name, entry);
    });

    const declaredPages = parseAtlasPages(atlasEntry.text ?? '');
    const pages = declaredPages.length > 0 ? declaredPages : texNames.map((name) => ({ name: `${name}.png`, width: 0, height: 0 }));
    atlasBuilds.push({
      entry: atlasEntry,
      pages,
      textures: pages.map((page, index) => {
        const byNameEntry = nameToEntry.get(stripExtension(page.name));
        if (byNameEntry) return byNameEntry;
        /* 包级兜底：同一包里**别的角色**的配置登记过这张贴图（多个模型共用贴图很常见）。
           没有这一步，页会拿不到条目，而 manifest 又会写上一个不存在的路径 ——
           播放器报「图片加载失败」，看起来像解包漏了文件。 */
        const sharedHash = texNameIndex?.get(stripExtension(page.name));
        const shared = sharedHash ? byName.get(sharedHash) : undefined;
        if (shared && isImageKind(shared.detection.kind)) {
          warnings.push(`页 ${page.name} 由同包其它角色的配置提供（共用贴图）`);
          return shared;
        }
        // 退化：老包可能没有 tex_names，退回顺序配对
        const hash = texHashes[index];
        const fallback = hash ? byName.get(hash) : undefined;
        if (fallback && isImageKind(fallback.detection.kind)) {
          warnings.push(`页 ${page.name} 没有在 tex_names 里找到对应名字，改用顺序配对`);
          return fallback;
        }
        warnings.push(`页 ${page.name} 找不到对应的贴图条目`);
        return null;
      }),
      fileName: '',
    });
  }
  if (atlasBuilds.length === 0) throw new Error(`模型 ${modelEntry.zipName} 没有可用的图集`);

  /* 命名：用第一张图集页的名字作为角色/骨架名（就是 Spine 导出时的资源名） */
  const firstPage = atlasBuilds[0].pages[0]?.name ?? stripExtension(skeletonEntry.zipName);
  const id = uniqueCharacterId(sanitizeFolderName(stripExtension(firstPage) || 'character'), usedIds);

  const skeletonName = sanitizeFolderName(id);
  const skeletonFile = `${skeletonName}${isBinarySkeleton ? '.skel' : '.json'}`;
  const atlasFile = `${skeletonName}.atlas`;
  files.set(skeletonFile, skeletonEntry.bytes);
  outputs.push({ entry: skeletonEntry, path: `${id}/${skeletonFile}` });

  /* 逐套贴图落盘：页名冲突时只改文件名（内容与图集文本都不动），映射交给清单 */
  const textureSets: TextureSetPlan[] = [];
  const takenPages = new Map<string, Uint8Array>();

  atlasBuilds.forEach((build, atlasIndex) => {
    const fileName = atlasIndex === 0 ? atlasFile : `${skeletonName}.${atlasIndex + 1}.atlas`;
    build.fileName = fileName;

    const pages: TexturePagePlan[] = [];

    build.pages.forEach((page, pageIndex) => {
      const entry = build.textures[pageIndex] ?? null;
      let target = sanitizeFolderName(page.name);

      if (entry) {
        // 图集声明的页尺寸必须和贴图实际尺寸一致，否则 UV 会整片错位
        if (page.width > 0 && page.height > 0) {
          const size = imageSize(entry.bytes);
          if (size && (size.width !== page.width || size.height !== page.height)) {
            warnings.push(
              `页 ${page.name} 在图集里声明为 ${page.width}x${page.height}，实际贴图是 ${size.width}x${size.height}`,
            );
          }
        }
        const existing = takenPages.get(target);
        if (existing && !sameBytes(existing, entry.bytes)) {
          // 两套贴图里有同名但内容不同的页。资源本身不能动，所以只给文件换个名字，
          // 图集文本保持原样，播放器按清单里的 pages[].path 取图。
          const dot = target.lastIndexOf('.');
          const renamed = dot > 0 ? `${target.slice(0, dot)}.v${atlasIndex + 1}${target.slice(dot)}` : `${target}.v${atlasIndex + 1}`;
          warnings.push(`页 ${page.name} 与前一套贴图重名且内容不同，文件已另存为 ${renamed}`);
          target = renamed;
        }
        takenPages.set(target, entry.bytes);
        files.set(target, entry.bytes);
        outputs.push({ entry, path: `${id}/${target}` });
      }

      pages.push({ page: page.name, file: target, entry });
    });

    // 图集文本原样落盘
    files.set(fileName, build.entry.bytes);
    outputs.push({ entry: build.entry, path: `${id}/${fileName}` });
    textureSets.push({ atlasFile: fileName, pages });
  });

  const primaryPages = textureSets[0]?.pages ?? [];
  const texturePaths = primaryPages.map((page) => page.file);

  /* 语音：模型配置里所有指向音频条目的引用 */
  const soundEntries: string[] = [];
  const motions = (model.motions ?? {}) as Record<string, Live2DExMotion[]>;

  const motionIndex = new Map<string, Live2DExMotion>();
  for (const [group, list] of Object.entries(motions)) {
    for (const motion of list ?? []) {
      if (motion && typeof motion.name === 'string') motionIndex.set(`${group}:${motion.name}`, motion);
    }
  }

  const resolveSound = (motion: Live2DExMotion): string | null => {
    if (typeof motion.sound === 'string' && byName.get(motion.sound)) return motion.sound;
    const command = typeof motion.command === 'string' ? motion.command : '';
    const match = /start_mtn\s+([^\s;]+)/.exec(command);
    if (match) {
      const target = motionIndex.get(match[1]);
      if (target && typeof target.sound === 'string' && byName.get(target.sound)) return target.sound;
    }
    return null;
  };

  const sounds: ManifestSoundInfo[] = [];
  /** 角色目录内的相对路径（清单里的 refs 与模型配置映射用） */
  const localSoundPath = new Map<string, string>();
  const pushSound = (hash: string, label: string | null, text: string | null): void => {
    const entry = byName.get(hash);
    if (!entry || !isAudioKind(entry.detection.kind)) return;
    if (!soundEntries.includes(hash)) soundEntries.push(hash);
    const ext = AUDIO_EXTENSIONS[entry.detection.kind] ?? '.mp3';
    // 去掉 LPK 里的 .bin/.bin3 后缀，还原成正常音频文件名
    const rel = `audio/${hash.replace(/\.bin3?$/i, '')}${ext}`;
    localSoundPath.set(hash, rel);
    // manifest 里的路径统一以"包目录"为基准，播放器只需要一个 base
    const manifestPath = `${id}/${rel}`;
    outputs.push({ entry, path: manifestPath });
    if (!sounds.some((s) => s.entry === hash)) sounds.push({ path: manifestPath, entry: hash, label, text });
    else {
      const existing = sounds.find((s) => s.entry === hash);
      if (existing && !existing.label && label) existing.label = label;
    }
  };

  // 先记录所有语音（含未被动作直接引用的），保证不丢资源
  for (const list of Object.values(motions)) {
    for (const motion of list ?? []) {
      const hash = resolveSound(motion);
      if (hash) pushSound(hash, typeof motion.name === 'string' ? motion.name : null, typeof motion.text === 'string' ? motion.text : null);
    }
  }

  /* 交互（动作 + 语音 + 命令 + 选择支）
     注意：Live2DViewerEX 里很多交互根本没有动作文件——菜单项、纯语音、纯命令
     （"start_mtn switch:title"、"slot_opacities lock ... 0"）都是这种。
     原版会把它们都列出来，所以这里也全部保留，只在没有动画时把 animation 记为 null。 */
  const interactions: ManifestInteractionInfo[] = [];
  for (const [group, list] of Object.entries(motions)) {
    for (const motion of list ?? []) {
      if (!motion) continue;
      const hasFile = typeof motion.file === 'string' && motion.file.length > 0;
      const hasSound = resolveSound(motion) !== null;
      const hasCommand = typeof motion.command === 'string' && motion.command.length > 0;
      const hasChoices = Array.isArray(motion.choices) && motion.choices.length > 0;
      const hasText = typeof motion.text === 'string' && motion.text.length > 0;
      const hasNext = typeof motion.next_mtn === 'string' && motion.next_mtn.length > 0;
      const hasVars = Array.isArray(motion.var_floats) && motion.var_floats.length > 0;
      // 有些条目什么都"没有"，只有 next_mtn 或变量条件（例如皮肤切换的 qiehuan），也要保留
      if (!hasFile && !hasSound && !hasCommand && !hasChoices && !hasText && !hasNext && !hasVars) continue;

      const soundHash = resolveSound(motion);
      const local = soundHash ? localSoundPath.get(soundHash) : undefined;
      const soundPath = local ? `${id}/${local}` : null;
      interactions.push({
        group,
        groupLabel: GROUP_LABELS[group] ?? group,
        name: typeof motion.name === 'string' && motion.name ? motion.name : (motion.file ?? group),
        label: typeof motion.name === 'string' && motion.name ? motion.name : (motion.file ?? group),
        animation: hasFile ? (motion.file ?? null) : null,
        sound: soundPath,
        // wrap_mode=1 表示循环（背景这类动作靠它，不能只看 idle 组）
        loop: motion.wrap_mode === 1 || motion.file_loop === true || group.toLowerCase() === 'idle',
        priority: typeof motion.priority === 'number' ? motion.priority : null,
        command: hasCommand ? (motion.command ?? null) : null,
        choices: hasChoices
          ? (motion.choices ?? []).map((choice) => {
              const choiceSoundHash = typeof choice?.sound === 'string' ? choice.sound : null;
              const choiceLocal = choiceSoundHash ? localSoundPath.get(choiceSoundHash) : undefined;
              return {
                text: typeof choice?.text === 'string' ? choice.text : null,
                next: typeof choice?.next_mtn === 'string' ? choice.next_mtn : null,
                sound: choiceLocal ? `${id}/${choiceLocal}` : null,
              };
            })
          : null,
        fadeInMs: typeof motion.fade_in === 'number' ? motion.fade_in : null,
        text: hasText ? (motion.text ?? null) : null,
        next: typeof motion.next_mtn === 'string' ? motion.next_mtn : null,
        textDurationMs: typeof motion.text_duration === 'number' ? motion.text_duration : null,
        varFloats: Array.isArray(motion.var_floats) && motion.var_floats.length > 0 ? motion.var_floats : null,
      });
    }
  }

  /* 动画清单：配置里出现的 + 骨架里存在但配置没提到的 */
  const skeletonAnimations = new Set(Object.keys(skeletonDoc.animations ?? {}));
  const animations: ManifestAnimationInfo[] = [];
  const animationIndex = new Map<string, ManifestAnimationInfo>();
  for (const interaction of interactions) {
    const animationName = interaction.animation;
    if (!animationName) continue; // 纯命令/纯语音的交互没有动画
    const existing = animationIndex.get(animationName);
    if (existing) {
      existing.loop = existing.loop || interaction.loop;
    } else {
      const info: ManifestAnimationInfo = {
        name: animationName,
        loop: interaction.loop,
        label: `${interaction.groupLabel}·${interaction.label}`,
        // 二进制骨架读不出动画表，先都当作可用，播放器加载后再校正
        available: isBinarySkeleton ? true : skeletonAnimations.has(animationName),
      };
      animationIndex.set(animationName, info);
      animations.push(info);
    }
  }
  for (const name of skeletonAnimations) {
    if (!animationIndex.has(name)) {
      const info: ManifestAnimationInfo = { name, loop: false, label: null, available: true };
      animationIndex.set(name, info);
      animations.push(info);
    }
  }

  /* 交互里引用了骨架中不存在的动画时给出提示，播放器会把按钮置灰 */
  const danglingAnimations = isBinarySkeleton
    ? []
    : interactions
        .map((it) => it.animation)
        .filter((name): name is string => typeof name === 'string' && !skeletonAnimations.has(name));
  if (danglingAnimations.length > 0) {
    warnings.push(`配置引用了骨架中不存在的动画：${[...new Set(danglingAnimations)].join(', ')}`);
  }

  /* 点击区域 */
  const hitAreas: ManifestHitAreaInfo[] = [];
  for (const area of model.hit_areas ?? []) {
    if (!area || !area.id) continue;
    hitAreas.push({
      name: typeof area.name === 'string' ? area.name : area.id,
      bone: area.id,
      width: asNumber(area.width, 1),
      height: asNumber(area.height, 1),
      motion: typeof area.motion === 'string' ? area.motion : null,
    });
  }

  /* 把音频写进文件表（用角色目录内的相对路径） */
  for (const info of sounds) {
    const local = localSoundPath.get(info.entry);
    const entry = byName.get(info.entry);
    if (local && entry) files.set(local, entry.bytes);
  }

  /* 头像：config.mlve 里 avatar 指向的那张图 */
  let avatarPath: string | null = null;
  const avatarHash = characterSource && typeof characterSource.avatar === 'string' ? characterSource.avatar : null;
  const avatarEntry = avatarHash ? byName.get(avatarHash) : undefined;
  if (avatarEntry && isImageKind(avatarEntry.detection.kind)) {
    avatarPath = `${id}/avatar${avatarEntry.detection.ext}`;
    files.set(`avatar${avatarEntry.detection.ext}`, avatarEntry.bytes);
    outputs.push({ entry: avatarEntry, path: avatarPath });
  }

  /* 模型配置原样落盘（不改写里面的哈希引用；播放器按清单 refs 在内存里映射） */
  files.set('live2dex.model.json', modelEntry.bytes);
  outputs.push({ entry: modelEntry, path: `${id}/live2dex.model.json` });

  const spineInfo = skeletonDoc.skeleton ?? {};
  const spineVersion = binaryHeader?.version ?? (typeof spineInfo.spine === 'string' ? spineInfo.spine : 'unknown');
  if (isBinarySkeleton) {
    warnings.push('骨架是二进制格式（.skel），动画总数由播放器在加载后从骨架里读取');
  }
  if (spineVersion.startsWith('4.')) {
    warnings.push(`骨架是 Spine ${spineVersion} 导出的，播放器会自动改用 Spine 4.x 运行时`);
  }

  /** 条目名 → 包内相对路径：播放器据此把配置里的哈希引用映射到真实文件 */
  const refs: Record<string, string> = {};
  for (const { entry, path } of outputs) refs[entry.zipName] = path;
  refs[skeletonEntry.zipName] = `${id}/${skeletonFile}`;
  refs[modelEntry.zipName] = `${id}/live2dex.model.json`;
  const character: ManifestCharacter = {
    id,
    dir: id,
    title: title ?? id,
    spineVersion: spineVersion,
    skeletonFormat: isBinarySkeleton ? 'binary' : 'json',
    skeleton: `${id}/${skeletonFile}`,
    skeletonName: skeletonFile,
    atlas: `${id}/${atlasFile}`,
    atlasName: atlasFile,
    textures: texturePaths.map((p) => `${id}/${p}`),
    textureSets: textureSets.map((set) => ({
      atlas: `${id}/${set.atlasFile}`,
      atlasName: set.atlasFile,
      /* 页没有条目时 path 写 null：播放器会按页名在角色的 textures[] 里回退查找。
         以前这里无条件写 `${id}/${page.file}`（那时 file 是个兜底文件名），
         于是 manifest 指向一个**并不存在**的文件，播放器报「图片加载失败」。 */
      pages: set.pages.map((page) => ({ name: page.page, path: page.file ? `${id}/${page.file}` : null })),
    })),
    modelConfig: `${id}/live2dex.model.json`,
    bounds: {
      x: asNumber(spineInfo.x, 0),
      y: asNumber(spineInfo.y, 0),
      width: asNumber(spineInfo.width, 0),
      height: asNumber(spineInfo.height, 0),
    },
    scaleFactor: asNumber(model.options?.scale_factor, 1),
    /* 包里给模型指定的摆放位置（options.position_x/position_y）。
       之前这两个字段被丢掉了，而播放器又只按骨架自身的 bounds 居中 ——
       于是像 3631002471/kansasi_2（position_y = -17.9）这种带偏移的模型会被画在错误的位置：
       看上去就是"人物缺了一块 / 和原版对不上"，区域红框也跟着对不上。 */
    positionX: asNumber(model.options?.position_x, 0),
    positionY: asNumber(model.options?.position_y, 0),
    /* 包自己声明的贴图编码类型（options.tex_type）。
       用途：alpha 混合方式的**先验**。实测 3572004785/Fazheng02 的贴图是预乘 alpha，
       而播放器按像素统计（要求"RGB > alpha 的像素少于 1%"）判成了直通 alpha ——
       画面表现就是脸上、胸口出现一层灰色残影（预乘数据当直通渲染，半透明处被压暗）。
       改成 tex_type 为 0 且统计不明确时用预乘，见 web/player.js 的 detectPremultiplied。 */
    texType: Number.isFinite(model.options?.tex_type) ? Number(model.options?.tex_type) : null,
    avatarPath,
    animations,
    interactions,
    sounds,
    hitAreas,
    warnings,
    refs,
    source: {
      modelEntry: modelEntry.zipName,
      costumePath: null,
      character: characterSource && typeof characterSource.character === 'string' ? characterSource.character : null,
      avatar: characterSource && typeof characterSource.avatar === 'string' ? characterSource.avatar : null,
      skeletonEntry: skeletonEntry.zipName,
      atlasEntry: atlasBuilds[0].entry.zipName,
      textureEntries: atlasBuilds.flatMap((b) => b.textures.filter((t): t is LoadedEntry => t !== null).map((t) => t.zipName)),
      soundEntries,
    },
  };

  return { character, files, outputs };
}

/* ------------------------------------------------------------------ *
 * 3b. Live2D Cubism 模型（moc3 + model3.json）
 * ------------------------------------------------------------------ */

interface CubismMotionRef {
  File?: string;
  Sound?: string;
  Text?: string;
  TextDuration?: number;
  /** Live2DViewerEX 扩展：改参数的命令动作（没有 File），以及命令的后置动作 */
  Name?: string;
  Command?: string;
  PostCommand?: string;
  NextMtn?: string;
  Priority?: number;
  Choices?: { Text?: string; NextMtn?: string }[];
  Intimacy?: { Min?: number };
  /** 变量条件（好感度/开关之类的门控），目前只原样记录 */
  VarFloats?: unknown[];
}

interface CubismFileReferences {
  Moc?: string;
  Textures?: string[];
  Physics?: string;
  PhysicsV2?: { File?: string };
  Pose?: string;
  DisplayInfo?: string;
  UserData?: string;
  Expressions?: Array<{ Name?: string; File?: string }>;
  Motions?: Record<string, CubismMotionRef[]>;
}

interface CubismModel3 {
  Version?: number;
  FileReferences?: CubismFileReferences;
  HitAreas?: Array<{ Name?: string; Id?: string; Motion?: string; Width?: number; Height?: number }>;
  Groups?: unknown[];
}

/** 判断条目是不是"模型配置"（Spine 的 live2dex 配置或 Cubism 的 model3.json） */
function isModelConfigEntry(entry: LoadedEntry): boolean {
  return entry.detection.kind === 'live2dex-model' || entry.detection.kind === 'live2d-model3';
}

function buildCubismCharacter(params: {
  modelEntry: LoadedEntry;
  byName: Map<string, LoadedEntry>;
  characterSource: MlveCharacter | null;
  title: string | null;
  usedIds: Set<string>;
  /** 包级"贴图名 → 条目 hash"（Cubism 的贴图按 FileReferences.Textures 顺序取，用不到，仅为签名一致） */
  texNameIndex?: Map<string, string>;
  /** 包级"moc3 hash → 贴图引用列表"：同一 moc3 复用多个模型时，空引用靠它兜底 */
  mocTextureIndex?: Map<string, string[]>;
  /** 包级"moc3 hash → 动作表"：stub 型 model3 的动作引用也解析不出来，同样按 moc3 借 */
  mocMotionsIndex?: Map<string, Record<string, Array<{ File?: string; Sound?: string }>>>;
}): { character: ManifestCubismCharacter; files: Map<string, Uint8Array>; outputs: Array<{ entry: LoadedEntry; path: string }> } {
  const { modelEntry, byName, characterSource, title, usedIds, mocTextureIndex, mocMotionsIndex } = params;
  const model = modelEntry.json as CubismModel3;
  const refs = model.FileReferences ?? {};
  const files = new Map<string, Uint8Array>();
  const outputs: Array<{ entry: LoadedEntry; path: string }> = [];
  const warnings: string[] = [];

  /* 命名：Cubism 的 moc3 里没有资源名，用包标题/包名兜底 */
  const id = uniqueCharacterId(sanitizeFolderName(title?.trim() || 'model'), usedIds);

  const put = (entry: LoadedEntry, rel: string): void => {
    files.set(rel, entry.bytes);
    outputs.push({ entry, path: `${id}/${rel}` });
  };

  /* moc3 */
  const mocEntry = refs.Moc ? byName.get(refs.Moc) : undefined;
  if (!mocEntry || mocEntry.detection.kind !== 'moc3') {
    throw new Error(`模型 ${modelEntry.zipName} 引用的 moc3 无效：${String(refs.Moc)}`);
  }
  const moc3File = `${id}.moc3`;
  put(mocEntry, moc3File);

  /* 贴图：顺序必须与 FileReferences.Textures 一致。
     有的包把同一个 moc3 复用好几个模型，而后续模型的 model3.json 里 Textures 是**空字符串**
     （实测 3715171880、3446514791、3713854460：真正的引用只在第一个模型里）——
     于是这些角色一张贴图都拿不到，播放器报 "Texture loading error"。
     这里按 Moc 找同包兄弟模型的贴图清单，按下标兜底。 */
  const siblingTextures = refs.Moc ? mocTextureIndex?.get(String(refs.Moc)) : undefined;
  const siblingMotions = refs.Moc ? mocMotionsIndex?.get(String(refs.Moc)) : undefined;
  const texturePaths: string[] = [];
  (refs.Textures ?? []).forEach((hash, index) => {
    let resolved = hash;
    let shared = false;
    if (!resolved && siblingTextures?.[index]) {
      resolved = siblingTextures[index];
      shared = true;
    }
    const entry = resolved ? byName.get(resolved) : undefined;
    if (!entry || !isImageKind(entry.detection.kind)) {
      warnings.push(`第 ${index + 1} 张贴图找不到对应条目：${hash}`);
      return;
    }
    if (shared) warnings.push(`第 ${index + 1} 张贴图借用同包共享同一 moc3 的模型（原引用为空）`);
    const rel = `textures/texture_${String(index).padStart(2, '0')}${entry.detection.ext}`;
    put(entry, rel);
    texturePaths.push(`${id}/${rel}`);
  });
  if (texturePaths.length === 0) warnings.push('模型没有任何贴图');

  /* 单文件引用：物理 / 姿势 / 显示信息 / 用户数据 */
  const singleRefs: Array<[string | undefined, string]> = [
    [refs.Physics ?? refs.PhysicsV2?.File, `physics/${id}.physics3.json`],
    [refs.Pose, `pose/${id}.pose3.json`],
    [refs.DisplayInfo, `${id}.cdi3.json`],
    [refs.UserData, `${id}.userdata3.json`],
  ];
  const singlePaths = new Map<string, string>();
  for (const [hash, rel] of singleRefs) {
    if (!hash) continue;
    const entry = byName.get(hash);
    if (!entry) {
      warnings.push(`引用文件缺失：${hash}`);
      continue;
    }
    if (!files.has(rel)) put(entry, rel);
    singlePaths.set(rel, `${id}/${rel}`);
  }

  /* 表情 */
  const expressions: string[] = [];
  (refs.Expressions ?? []).forEach((expression, index) => {
    const entry = expression.File ? byName.get(expression.File) : undefined;
    if (!entry) {
      warnings.push(`表情 ${expression.Name ?? index} 找不到对应条目`);
      return;
    }
    const base = sanitizeFolderName(expression.Name ?? `exp_${index}`);
    const rel = `expressions/${base}.exp3.json`;
    if (!files.has(rel)) put(entry, rel);
    expressions.push(`${id}/${rel}`);
  });

  /* 动作 + 语音 */
  const motions: ManifestCubismMotion[] = [];
  const sounds: ManifestSoundInfo[] = [];
  const soundEntries: string[] = [];
  for (const [group, list] of Object.entries(refs.Motions ?? {})) {
    // 过滤掉 null 元素：包里的 JSON 可能写成 [null]，直接 .File 会抛，
    // 而这里抛了整个角色就没了（Spine 那条路径本来就有这层保护）
    (list ?? []).filter(Boolean).forEach((motion, index) => {
      let entry = motion.File ? byName.get(motion.File) : undefined;
      let borrowedMotion = false;
      if (!entry && siblingMotions) {
        /* stub 型 model3：动作引用也解析不出来，按 组 + 下标 借同一个 moc3 的兄弟模型的引用 */
        const siblingFile = siblingMotions[group]?.[index]?.File;
        const siblingEntry = siblingFile ? byName.get(siblingFile) : undefined;
        if (siblingEntry) {
          entry = siblingEntry;
          borrowedMotion = true;
        }
      }
      if (!entry) {
        // Live2DViewerEX 的"命令动作"：没有动作文件，只改参数、弹选项或换模型
        // （脱/穿衣服、花钱、选择支、重置换装都是靠它做的）。这些也是包的内容，原样记进清单。
        const hasVars = Array.isArray(motion.VarFloats) && motion.VarFloats.length > 0;
        if (!motion.File && (motion.Command || motion.PostCommand || motion.Choices || hasVars)) {
          motions.push({
            group,
            label: motion.Text ?? motion.Name ?? null,
            file: null,
            sound: null,
            loop: false,
            fileEntry: null,
            soundEntry: null,
            command: typeof motion.Command === 'string' ? motion.Command : null,
            postCommand: typeof motion.PostCommand === 'string' ? motion.PostCommand : null,
            nextMotion: typeof motion.NextMtn === 'string' ? motion.NextMtn : null,
            choices: Array.isArray(motion.Choices)
              ? motion.Choices.map((choice) => ({
                  text: typeof choice?.Text === 'string' ? choice.Text : null,
                  next: typeof choice?.NextMtn === 'string' ? choice.NextMtn : null,
                }))
              : null,
            text: typeof motion.Text === 'string' ? motion.Text : null,
            textDurationMs: typeof motion.TextDuration === 'number' ? motion.TextDuration : null,
            varFloats: hasVars ? motion.VarFloats : null,
          });
          return;
        }
        warnings.push(`动作 ${group}[${index}] 找不到对应条目`);
        return;
      }
      const rel = `motions/${sanitizeFolderName(group)}_${index}.motion3.json`;
      if (!files.has(rel)) put(entry, rel);

      /* 动作自己的 Meta.Loop 才是权威的循环标记。
         以前这里只按 `group === 'Idle'` 猜，于是 touch_idle / Tap / body 这些
         motion3.json 里明明写着 Meta.Loop=true 的动作，清单里全是 loop=false ——
         播放器据此判断"是不是待机态动作"时就判错了（实测：改了规则却不生效）。 */
      let fileLoop = false;
      try {
        /* 用 TextDecoder 而不是 Buffer：后者是 Node 全局，浏览器里没有 */
        const meta = JSON.parse(new TextDecoder('utf-8').decode(entry.bytes)) as { Meta?: { Loop?: boolean } };
        fileLoop = meta?.Meta?.Loop === true;
      } catch {
        fileLoop = false;
      }

      let soundPath: string | null = null;
      let soundEntryName: string | null = null;
      const soundEntry = motion.Sound ? byName.get(motion.Sound) : undefined;
      if (soundEntry && isAudioKind(soundEntry.detection.kind)) {
        const ext = AUDIO_EXTENSIONS[soundEntry.detection.kind] ?? '.mp3';
        const soundRel = `sounds/${sanitizeFolderName(group)}_${index}${ext}`;
        if (!files.has(soundRel)) put(soundEntry, soundRel);
        soundPath = `${id}/${soundRel}`;
        soundEntryName = soundEntry.zipName;
        if (!soundEntries.includes(soundEntry.zipName)) {
          soundEntries.push(soundEntry.zipName);
          sounds.push({ path: soundPath, entry: soundEntry.zipName, label: motion.Text ?? group, text: motion.Text ?? null });
        }
      } else if (motion.Sound) {
        warnings.push(`动作 ${group}[${index}] 的语音缺失：${motion.Sound}`);
      }

      motions.push({
        group,
        label: motion.Text ?? null,
        file: `${id}/${rel}`,
        sound: soundPath,
        loop: group === 'Idle' || fileLoop,
        fileEntry: entry.zipName,
        soundEntry: soundEntryName,
      });
    });
  }
  if (motions.length === 0) warnings.push('模型没有任何动作');

  /* 头像：config.mlve 里 avatar 指向的那张图。
     和 Spine 路径（buildCharacter 里同名的一段）一样必须真的导出：
     unpackLpk 会把 source.avatar 标成"已使用"，不导出的话这张图既不会进 _unassigned/、
     也不会出现在角色目录里 —— 等于被静默丢掉，package.preview 也拿不到它。 */
  let avatarPath: string | null = null;
  const avatarHash = characterSource && typeof characterSource.avatar === 'string' ? characterSource.avatar : null;
  const avatarEntry = avatarHash ? byName.get(avatarHash) : undefined;
  if (avatarEntry && isImageKind(avatarEntry.detection.kind)) {
    const rel = `avatar${avatarEntry.detection.ext}`;
    put(avatarEntry, rel);
    avatarPath = `${id}/${rel}`;
  }

  /* 重写后的 model3.json：解包阶段不再改写，模型配置原样落盘 */
  const model3File = `${id}.model3.json`;
  files.set(model3File, modelEntry.bytes);
  outputs.push({ entry: modelEntry, path: `${id}/${model3File}` });

  // 同样过滤 null 元素：一个 null 会让 .Name 抛异常、整个角色被跳过
  const hitAreas: ManifestHitAreaInfo[] = (model.HitAreas ?? []).filter(Boolean).map((area, index) => ({
    name: area.Name ?? `area_${index}`,
    bone: area.Id ?? '',
    width: asNumber(area.Width, 1),
    height: asNumber(area.Height, 1),
    motion: area.Motion ?? null,
  }));

  /** 条目名 → 包内相对路径：播放器按这张表改写 model3.json 里的哈希引用（只在内存里改） */
  const refMap: Record<string, string> = {};
  for (const { entry, path } of outputs) refMap[entry.zipName] = path;
  refMap[modelEntry.zipName] = `${id}/${model3File}`;

  const character: ManifestCubismCharacter = {
    kind: 'cubism',
    id,
    dir: id,
    title: title ?? id,
    /* Cubism 不用这个字段（它的 alpha 处理在 web/cubism.js 里独立判定），显式留空 */
    texType: null,
    model3: `${id}/${model3File}`,
    model3Name: model3File,
    moc3: `${id}/${moc3File}`,
    textures: texturePaths,
    motions,
    expressions,
    physics: singlePaths.get(`physics/${id}.physics3.json`) ?? null,
    pose: singlePaths.get(`pose/${id}.pose3.json`) ?? null,
    displayInfo: singlePaths.get(`${id}.cdi3.json`) ?? null,
    sounds,
    hitAreas,
    groups: model.Groups ?? [],
    avatarPath,
    warnings,
    refs: refMap,
    source: {
      modelEntry: modelEntry.zipName,
      costumePath: null,
      character: characterSource && typeof characterSource.character === 'string' ? characterSource.character : null,
      avatar: characterSource && typeof characterSource.avatar === 'string' ? characterSource.avatar : null,
      skeletonEntry: mocEntry.zipName,
      atlasEntry: '',
      textureEntries: (refs.Textures ?? []).filter((hash) => byName.has(hash)),
      soundEntries,
    },
  };

  return { character, files, outputs };
}

/* ------------------------------------------------------------------ *
 * 4. 打开 + 解密 + 分类（--list 与解包共用这一步）
 * ------------------------------------------------------------------ */

export interface LoadedPackage {
  name: string;
  zip: ZipArchive;
  mlveEntry: ZipEntry;
  mlve: MlveConfig;
  external: ExternalConfig | null;
  externalName: string | null;
  entries: LoadedEntry[];
  byName: Map<string, LoadedEntry>;
}

export function loadPackage(options: {
  bytes: Uint8Array;
  name: string;
  externalConfig?: { bytes: Uint8Array; name: string } | null;
  log?: (line: string) => void;
}): LoadedPackage {
  const log = options.log ?? ((): void => {});
  const name = options.name;

  const zip = new ZipArchive(options.bytes);
  log(`打开 ${name}：${zip.entries.length} 个条目 / ${humanBytes(options.bytes.length)}`);

  const mlveEntry = findMlveEntry(zip);
  const mlveText = tryDecodeText(zip.read(mlveEntry));
  if (!mlveText) throw new Error('config.mlve 无法解析为 UTF-8 文本');
  const mlve = JSON.parse(mlveText) as MlveConfig;
  const typeLabel = typeof mlve.type === 'string' ? mlve.type : String(mlve.type ?? '未知');
  log(`包类型：${typeLabel}，加密：${mlve.encrypt ?? '未声明'}，包 id：${mlve.id ?? '-'}`);

  const external = loadExternalConfig(options.externalConfig?.bytes, options.externalConfig?.name, log);
  if (typeLabel === 'STM_1_0' && !external) {
    log('警告：STM_1_0 包需要同目录的 config.json 才能推导密钥，解密可能失败');
  }

  const entries = decryptEntries(zip, mlve, external, log);
  const byName = new Map(entries.map((entry) => [entry.zipName, entry]));
  return { name, zip, mlveEntry, mlve, external, externalName: options.externalConfig?.name ?? null, entries, byName };
}

/** 一个条目被哪些模型配置 / 包配置引用（用于 --list 排查） */
export function referencedEntryNames(entries: LoadedEntry[]): Set<string> {
  const known = new Set(entries.map((entry) => entry.zipName));
  const referenced = new Set<string>();
  for (const entry of entries) {
    if (entry.json === null || entry.json === undefined) continue;
    if (!['live2dex-model', 'live2dex-package', 'live2d-model3', 'json'].includes(entry.detection.kind)) continue;
    walkStrings(entry.json, (text) => {
      if (known.has(text)) referenced.add(text);
    });
  }
  return referenced;
}

/* ------------------------------------------------------------------ *
 * 5. 主入口
 * ------------------------------------------------------------------ */

export function unpackLpk(options: UnpackOptions): UnpackResult {
  const pkg = loadPackage(options);
  const log = options.log ?? ((): void => {});
  const outDir = options.outDir;
  const { mlveEntry, mlve, external, entries, byName } = pkg;
  const modelEntries = entries.filter(isModelConfigEntry);
  if (modelEntries.length === 0) throw new Error('LPK 中没有找到模型配置（既没有 Live2DViewerEX 模型，也没有 model3.json）');

  const ordered: Array<{ entry: LoadedEntry; source: MlveCharacter | null; costume: MlveCostume | null }> = [];
  const seen = new Set<string>();
  for (const character of mlve.list ?? []) {
    for (const costume of character.costume ?? []) {
      if (!costume || typeof costume.path !== 'string' || costume.path.length === 0) continue;
      const entry = byName.get(costume.path);
      if (entry && isModelConfigEntry(entry) && !seen.has(entry.zipName)) {
        seen.add(entry.zipName);
        ordered.push({ entry, source: character, costume });
      }
    }
  }
  for (const entry of modelEntries) {
    if (!seen.has(entry.zipName)) {
      seen.add(entry.zipName);
      ordered.push({ entry, source: null, costume: null });
    }
  }

  const packageTitle = external?.title?.trim() || mlve.name?.trim() || basename(options.name, '.lpk');
  const usedIds = new Set<string>();
  const characters: ManifestCharacter[] = [];
  const files = new Map<string, Uint8Array>();

  /**
   * 包级的"贴图名 → 条目 hash"索引，扫**所有**角色的模型配置得到。
   *
   * 为什么需要：同一个包里多个模型常常**共用同一批贴图条目**（实测 2965558829：
   * 角色 Taishici01 的图集页 `Taishici01.png` 只在角色 Bg_taishici01 的配置里登记过）。
   * 只按本角色的配置查名字就会漏掉，于是页拿不到条目 —— 而旧代码**照样**把 `页路径` 写进
   * manifest（`file: target` 是无条件写的），播放器去取一个不存在的文件，报
   * 「图片加载失败：models/…/Taishici01.png」。
   */
  const texNameIndex = new Map<string, string>();
  /* 同一个 moc3 被多个模型复用时，只有第一个模型的 model3.json 填了贴图引用，后续模型是空字符串
     （实测 3715171880、3446514791、3713854460）—— 记下"每个 moc3 的贴图清单"给它们兜底。 */
  const mocTextureIndex = new Map<string, string[]>();
  const mocMotionsIndex = new Map<string, Record<string, Array<{ File?: string; Sound?: string }>>>();
  for (const item of ordered) {
    const model = item.entry.json as Live2DExModel | null;
    for (const atlas of model?.atlases ?? []) {
      const names = atlas.tex_names ?? [];
      const hashes = atlas.textures ?? [];
      names.forEach((name: string, index: number) => {
        const hash = hashes[index];
        if (name && hash && !texNameIndex.has(name)) texNameIndex.set(name, hash);
      });
    }
    /* Cubism：记下每个 moc3 的贴图清单（只取非空引用，空的那份正是需要兜底的） */
    const cubismRefs = (item.entry.json as CubismModel3 | null)?.FileReferences;
    const moc = cubismRefs?.Moc;
    if (moc) {
      const list = (cubismRefs?.Textures ?? []).filter((hash) => Boolean(hash));
      if (list.length > 0 && !mocTextureIndex.has(moc)) mocTextureIndex.set(moc, list);
      /* 动作表：只收"真的能解析出条目"的那些组，空的 stub 不需要被借 */
      const motions = cubismRefs?.Motions;
      if (motions && !mocMotionsIndex.has(moc)) {
        const usable: Record<string, Array<{ File?: string; Sound?: string }>> = {};
        let count = 0;
        for (const [group, entries] of Object.entries(motions)) {
          const files = (entries ?? []).filter((item) => item?.File);
          if (files.length > 0) {
            usable[group] = files;
            count += files.length;
          }
        }
        if (count > 0) mocMotionsIndex.set(moc, usable);
      }
    }
  }

  for (const item of ordered) {
    try {
      // 只有 config.mlve 里登记的那个角色能用包标题命名，包里多出来的角色用「包标题 + 序号」
      const naming = {
        title: characters.length === 0 ? packageTitle : `${packageTitle} ${characters.length + 1}`,
        usedIds,
        texNameIndex,
        mocTextureIndex,
        mocMotionsIndex,
      };
      const built =
        item.entry.detection.kind === 'live2d-model3'
          ? buildCubismCharacter({ modelEntry: item.entry, byName, characterSource: item.source, ...naming })
          : buildCharacter({ modelEntry: item.entry, byName, characterSource: item.source, ...naming });
      built.character.source.costumePath = item.costume?.path ?? null;
      for (const [rel, bytes] of built.files) files.set(`${built.character.id}/${rel}`, bytes);
      for (const { entry, path } of built.outputs) entry.output = path;
      characters.push(built.character);

      const summary =
        built.character.kind === 'cubism'
          ? `Cubism：moc3 ${built.character.source.skeletonEntry}，贴图 ${built.character.textures.length} 张，` +
            `动作 ${built.character.motions.length} 个，语音 ${built.character.sounds.length} 条`
          : `Spine ${built.character.spineVersion}：骨架 ${built.character.source.skeletonEntry}，` +
            `图集 ${built.character.source.atlasEntry}，贴图 ${built.character.textures.length} 张，` +
            `语音 ${built.character.source.soundEntries.length} 条，动画 ${built.character.animations.length} 个`;
      log(`角色 ${built.character.id}（${summary}）`);
    } catch (error) {
      log(`跳过模型 ${item.entry.zipName}：${(error as Error).message}`);
    }
  }
  if (characters.length === 0) throw new Error('没有任何模型可以被解包');

  /* 标记已被角色使用的条目 */
  const usedEntries = new Set<string>([mlveEntry.name]);
  for (const character of characters) {
    const src = character.source;
    usedEntries.add(src.modelEntry);
    usedEntries.add(src.skeletonEntry);
    usedEntries.add(src.atlasEntry);
    for (const name of src.textureEntries) usedEntries.add(name);
    for (const name of src.soundEntries) usedEntries.add(name);
    if (src.avatar) usedEntries.add(src.avatar);
  }

  /* 未被引用的条目照样导出，避免丢资源 */
  const unassigned: string[] = [];
  for (const entry of entries) {
    if (usedEntries.has(entry.zipName)) continue;
    if (entry.detection.kind === 'live2dex-package') continue;
    const folder = isAudioKind(entry.detection.kind)
      ? '_unassigned/audio'
      : isImageKind(entry.detection.kind)
        ? '_unassigned/textures'
        : '_unassigned/other';
    const rel = `${folder}/${entry.zipName}${entry.detection.kind === 'binary' ? '' : entry.detection.ext}`;
    files.set(rel, entry.bytes);
    entry.output = rel;
    unassigned.push(rel);
  }

  /* 预览图：优先使用调用方传入的外部预览图（Node 侧由 CLI 读 config.json 指定的文件） */
  let preview: string | null = null;
  if (options.preview && options.preview.bytes.length > 0) {
    // 预览文件名可能没有扩展名（或整串就是一个隐藏文件名）：lastIndexOf 返回 -1 时
    // slice(-1) 会取到**最后一个字符**，于是名字变成 previewn 这种怪东西 —— 退回 .png。
    const dot = options.preview.name.lastIndexOf('.');
    const ext = dot >= 0 ? options.preview.name.slice(dot).toLowerCase() : '.png';
    preview = `preview${ext}`;
    files.set(preview, options.preview.bytes);
  } else {
    // 没有外部预览图时退回包内 avatar（已经在角色目录里导出为 avatar.*）
    const firstAvatar = characters.find((c) => c.avatarPath)?.avatarPath ?? null;
    if (firstAvatar) preview = firstAvatar;
  }

  /* 包描述本身也原样导出，保证"资源不丢" */
  const mlveLoaded = byName.get(mlveEntry.name);
  if (mlveLoaded) {
    files.set('config.mlve', mlveLoaded.bytes);
    mlveLoaded.output = 'config.mlve';
  }

  /* 落盘：全部通过注入的 IO（Node 用 node:fs，浏览器用内存实现） */
  const io = options.io;
  io.mkdir(outDir);
  for (const [rel, bytes] of files) {
    const target = outTarget(outDir, rel);
    io.mkdir(dirname(target));
    io.writeFile(target, bytes);
  }

  if (options.keepRaw) {
    const rawDir = join(outDir, '_raw');
    for (const entry of entries) {
      const target = rawEntryPath(rawDir, entry.zipName);
      io.mkdir(dirname(target));
      io.writeFile(target, entry.bytes);
    }
    log(`原始条目已导出到 ${rawDir}`);
  }

  /* 复制一份外部 config.json，保持可追溯（字节已在内存里，直接写即可） */
  const externalConfigName = options.externalConfig?.name ?? null;
  if (options.externalConfig && externalConfigName) {
    io.mkdir(outDir);
    io.writeFile(join(outDir, 'source.config.json'), options.externalConfig.bytes);
  }

  const manifestEntries: ManifestEntryInfo[] = entries.map((entry) => ({
    name: entry.zipName,
    kind: entry.detection.kind,
    size: entry.size,
    encrypted: entry.encrypted,
    output: entry.output,
  }));

  const manifest: Manifest = {
    schema: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    tool: TOOL_NAME,
    source: {
      lpk: options.name,
      lpkBytes: options.bytes.length,
      entryCount: entries.length,
      configFile: externalConfigName,
      mlveEntry: mlveEntry.name,
    },
    package: {
      title: packageTitle,
      author: external?.author ?? null,
      description: external?.description ?? null,
      fileId: external?.fileId ?? null,
      metaData: external?.metaData ?? null,
      mlveType: typeof mlve.type === 'string' ? mlve.type : String(mlve.type ?? 'unknown'),
      mlveId: mlve.id ?? null,
      mlveName: mlve.name ?? null,
      preview,
      unassigned,
    },
    characters,
    entries: manifestEntries,
  };

  const manifestPath = join(outDir, 'manifest.json');
  io.writeFile(manifestPath, encodeText(`${JSON.stringify(manifest, null, 2)}\n`));
  log(`清单已写入 ${manifestPath}`);

  return { outDir, manifestPath, manifest };
}
