/**
 * 资源来源抽象
 *   UrlSource    —— 从服务器读取（服务器模式）
 *   FolderSource —— 直接从本地目录读取（拖拽 / 选择文件夹，无需服务器）
 */
import { parseAtlasPages, readSpineBinaryVersion } from './player';

export function loadImage(url: any): Promise<HTMLImageElement> {
  return new Promise((resolve: any, reject: any) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图片加载失败：${url}`));
    image.src = url;
  });
}

export function encodeRelativePath(path: any) {
  return String(path)
    .split('/')
    .map((segment: any) => encodeURIComponent(segment))
    .join('/');
}

export class UrlSource {
  /* 字段声明：迁移时从构造函数里的 this.x 赋值推导，类型暂为 any（后续按模块收紧） */
  base: any;
  kind: any;

  /** @param {string} base 例如 "models/3311033066/" */
  constructor(base: any) {
    this.base = base.endsWith('/') ? base : `${base}/`;
    this.kind = 'url';
  }

  resolve(rel: any) {
    return this.base + encodeRelativePath(rel);
  }

  async text(rel: any) {
    const response = await fetch(this.resolve(rel));
    if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）：${rel}`);
    return response.text();
  }

  async binary(rel: any) {
    const response = await fetch(this.resolve(rel));
    if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）：${rel}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async json(rel: any) {
    return JSON.parse(await this.text(rel));
  }

  async image(rel: any) {
    return loadImage(this.resolve(rel));
  }

  /** 音频 URL（服务器支持 Range，可直接拖动进度） */
  audioUrl(rel: any) {
    return this.resolve(rel);
  }

  release() {
    /* 无需释放 */
  }
}

export class FolderSource {
  /* 字段声明：迁移时从构造函数里的 this.x 赋值推导，类型暂为 any（后续按模块收紧） */
  files: any;
  kind: any;
  objectUrls: any;
  prefix: any;

  /**
   * @param {FileList|File[]} files 用户选择/拖入的文件
   * @param {string} [rootPrefix] 需要剥离的顶层目录名
   */
  constructor(files: any, rootPrefix = '') {
    this.kind = 'folder';
    this.files = new Map();
    this.objectUrls = new Map();
    this.prefix = rootPrefix;
    for (const file of files) {
      const rel = this.relativePath(file);
      if (!rel) continue;
      this.files.set(rel, file);
      this.files.set(rel.toLowerCase(), file);
    }
  }

  relativePath(file: any) {
    const raw = file.webkitRelativePath || file.relativePath || file.name;
    let rel = String(raw).replace(/\\/g, '/');
    if (this.prefix && rel.startsWith(`${this.prefix}/`)) rel = rel.slice(this.prefix.length + 1);
    return rel;
  }

  /** 列出所有相对路径（去重，保持原始大小写） */
  list() {
    const seen = new Set();
    const out = [] as any[];
    for (const [key, file] of this.files) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(key);
    }
    return out;
  }

  find(rel: any) {
    const normalized = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
    return this.files.get(normalized) || this.files.get(normalized.toLowerCase()) || null;
  }

  /** 相对路径 → 可直接交给加载器的 URL（本地文件用 object URL） */
  resolve(rel: any) {
    const file = this.find(rel);
    if (!file) return rel;
    if (!this.objectUrls.has(file)) this.objectUrls.set(file, URL.createObjectURL(file));
    return this.objectUrls.get(file);
  }

  async text(rel: any) {
    const file = this.find(rel);
    if (!file) throw new Error(`目录中找不到文件：${rel}`);
    return file.text();
  }

  async binary(rel: any) {
    const file = this.find(rel);
    if (!file) throw new Error(`目录中找不到文件：${rel}`);
    return new Uint8Array(await file.arrayBuffer());
  }

  async json(rel: any) {
    return JSON.parse(await this.text(rel));
  }

  async image(rel: any) {
    const file = this.find(rel);
    if (!file) throw new Error(`目录中找不到图片：${rel}`);
    if (!this.objectUrls.has(file)) this.objectUrls.set(file, URL.createObjectURL(file));
    return loadImage(this.objectUrls.get(file));
  }

  audioUrl(rel: any) {
    const file = this.find(rel);
    if (!file) return null;
    if (!this.objectUrls.has(file)) this.objectUrls.set(file, URL.createObjectURL(file));
    return this.objectUrls.get(file);
  }

  release() {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }
}

/**
 * 内存里的解包结果（静态模式下浏览器内解包后的资源）。
 *
 * 与 FolderSource 同一套接口，所以播放器不需要知道资源是"用户拖进来的目录"
 * 还是"刚在浏览器里从一个 .lpk 解出来的"。名下的字节来自 @lpk/unpacker 的 MemoryIO。
 */
export class MemorySource {
  kind = 'memory';
  /** 相对路径 → 字节（大小写各存一份，方便按包内引用查找） */
  files: Map<string, Uint8Array>;
  objectUrls: Map<string, string> = new Map();
  prefix: string;

  constructor(files: Map<string, Uint8Array>, rootPrefix = '') {
    this.files = new Map();
    this.prefix = rootPrefix;
    for (const [path, bytes] of files) {
      const rel = rootPrefix && path.startsWith(`${rootPrefix}/`) ? path.slice(rootPrefix.length + 1) : path;
      this.files.set(rel, bytes);
      this.files.set(rel.toLowerCase(), bytes);
    }
  }

  /** 列出所有相对路径（大小写各一份，这里只保留原始写法） */
  list(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const [key, bytes] of this.files) {
      if (seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());
      out.push(key);
    }
    return out;
  }

  find(rel: string): Uint8Array | null {
    const normalized = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
    return this.files.get(normalized) ?? this.files.get(normalized.toLowerCase()) ?? null;
  }

  /** 相对路径 → 可直接交给加载器的 URL（内存字节用 blob URL） */
  resolve(rel: string): string {
    const bytes = this.find(rel);
    if (!bytes) return rel;
    const key = rel;
    if (!this.objectUrls.has(key)) {
      this.objectUrls.set(key, URL.createObjectURL(new Blob([bytes as unknown as BlobPart])));
    }
    return this.objectUrls.get(key)!;
  }

  async text(rel: string): Promise<string> {
    const bytes = this.find(rel);
    if (!bytes) throw new Error(`解包结果里找不到文件：${rel}`);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async binary(rel: string): Promise<Uint8Array> {
    const bytes = this.find(rel);
    if (!bytes) throw new Error(`解包结果里找不到文件：${rel}`);
    return bytes;
  }

  async json(rel: string): Promise<any> {
    return JSON.parse(await this.text(rel));
  }

  async image(rel: string): Promise<HTMLImageElement> {
    if (!this.find(rel)) throw new Error(`解包结果里找不到图片：${rel}`);
    return loadImage(this.resolve(rel));
  }

  audioUrl(rel: string): string | null {
    return this.find(rel) ? this.resolve(rel) : null;
  }

  release(): void {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }
}

/**
 * 没有 manifest.json 时，直接从目录内容推断出一个角色
 * （骨架 JSON + Spine 图集 + 贴图 + 音频）
 */
export async function detectCharacterFromFolder(source: any) {
  const paths = source.list();

  /* 1) 骨架：先找二进制 .skel（读头部版本号即可确认），再找 Spine JSON */
  let skeletonPath = null;
  let skeletonVersion = null;
  let skeletonFormat = 'json';
  let skeletonDoc = null;

  for (const path of paths.filter((p: any) => /\.(skel|bin)$/i.test(p))) {
    try {
      const version = readSpineBinaryVersion(await source.binary(path));
      if (version) {
        skeletonPath = path;
        skeletonVersion = version;
        skeletonFormat = 'binary';
        break;
      }
    } catch {
      /* 读不了就跳过 */
    }
  }

  if (!skeletonPath) {
    for (const path of paths.filter((p: any) => /\.json$/i.test(p) && !/manifest\.json$/i.test(p))) {
      try {
        const doc = JSON.parse(await source.text(path));
        if (doc && typeof doc === 'object' && doc.skeleton && Array.isArray(doc.bones) && doc.skins) {
          skeletonPath = path;
          skeletonDoc = doc;
          skeletonVersion = doc?.skeleton?.spine ?? 'unknown';
          break;
        }
      } catch {
        /* 不是 JSON，跳过 */
      }
    }
  }
  if (!skeletonPath) throw new Error('目录里没有找到 Spine 骨架（*.json 或 *.skel）');

  let atlasPath = paths.find((p: any) => /\.atlas$/i.test(p)) || null;
  let atlasText = null;
  for (const path of atlasPath ? [atlasPath] : paths.filter((p: any) => /\.(txt|atlas)$/i.test(p))) {
    const text = await source.text(path);
    const firstLine = text.split(/\r?\n/).find((line: any) => line.trim().length > 0);
    if (firstLine && /\.(png|jpe?g|webp)$/i.test(firstLine.trim())) {
      atlasPath = path;
      atlasText = text;
      break;
    }
  }
  if (!atlasPath || !atlasText) throw new Error('目录里没有找到 Spine 图集文件（*.atlas）');

  const palettePages = parseAtlasPages(atlasText);
  const directory = skeletonPath.includes('/') ? skeletonPath.slice(0, skeletonPath.lastIndexOf('/') + 1) : '';
  const textures = [] as any[];
  for (const page of palettePages) {
    const candidates = [`${directory}${page.name}`, page.name];
    const found = candidates.find((candidate: any) => source.find(candidate)) || page.name;
    textures.push(found);
  }

  const animations = Object.keys(skeletonDoc?.animations || {}).map((name: any) => ({
    name,
    loop: false,
    label: null,
    available: true,
  }));
  const audioFiles = paths.filter((p: any) => /\.(mp3|ogg|wav)$/i.test(p));
  const baseName = (palettePages[0]?.name || skeletonPath).replace(/\.[^.]+$/, '').split('/').pop();

  return {
    id: baseName || 'local',
    dir: '',
    title: baseName || '本地模型',
    spineVersion: skeletonVersion ?? 'unknown',
    skeletonFormat,
    skeleton: skeletonPath,
    atlas: atlasPath,
    textures,
    modelConfig: null,
    avatarPath: null,
    bounds: {
      x: Number(skeletonDoc?.skeleton?.x) || 0,
      y: Number(skeletonDoc?.skeleton?.y) || 0,
      width: Number(skeletonDoc?.skeleton?.width) || 0,
      height: Number(skeletonDoc?.skeleton?.height) || 0,
    },
    animations,
    interactions: [],
    sounds: audioFiles.map((path: any) => ({ path, entry: path, label: path.split('/').pop(), text: null })),
    hitAreas: [],
    warnings: [],
  };
}

/**
 * 一个文件在拖入内容里的相对路径。
 *
 * 三个来源给的字段不一样，必须统一在这里判断（`FolderSource` 用的是同一套顺序）：
 *   * 拖文件夹 / 目录选择器 → `webkitRelativePath`（浏览器给，带顶层目录名）；
 *   * 从 `webkitGetAsEntry` 递归读出来的 → 由 `collectDroppedFiles` 写在 `webkitRelativePath` 上；
 *   * 合成/测试构造的 File → 只有 `relativePath`。
 * 只认其中一个的话，换一种来源就会"路径少一层目录"，表现为找不到骨架或清单。
 */
function fileRelativePath(file: any): string {
  return String(file.webkitRelativePath || file.relativePath || file.name || '').replace(/\\/g, '/');
}

/** 从拖入/选择的文件里找到一个"包"（存在 manifest.json 或 out/<id>/ 结构） */
export function describeFileSet(files: any) {
  const names = Array.from(files).map((file: any) => fileRelativePath(file));
  const manifestName = names.find((name: any) => /(^|\/)manifest\.json$/i.test(name));
  if (manifestName) {
    const prefix = manifestName.includes('/') ? manifestName.slice(0, manifestName.lastIndexOf('/')) : '';
    return { kind: 'package', prefix };
  }
  const first = names[0] || '';
  const prefix = first.includes('/') ? first.slice(0, first.indexOf('/')) : '';
  return { kind: 'character', prefix };
}

/** 从拖入/选择的文件里读出一个包清单 */
export async function readManifestFromFileSet(files: any, prefix: any) {
  const manifestName = `${prefix ? `${prefix}/` : ''}manifest.json`;
  for (const file of files) {
    if (fileRelativePath(file).toLowerCase() === manifestName.toLowerCase()) return JSON.parse(await file.text());
  }
  throw new Error('没有找到 manifest.json');
}
