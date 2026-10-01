/**
 * 列表 JSON 的**唯一产出点**。
 *
 * 为什么放在解包器里：这份结构有两个消费者 ——
 *   * Vite 插件（构建期写 packages.json，静态模式用）；
 *   * CLI 的 `/api/packages`（服务器模式动态返回）。
 * 两边各写一份迟早会漂移，所以这里只定义一次，两边都调它。
 *
 * 这个函数是**纯函数**：只吃"读到的 manifest"，不碰文件系统 ——
 * 扫描目录、读文件由调用方（Node 侧）做完再传进来。
 */

/** 一个包的清单里，列表页需要的字段 */
export interface PackageIndexSource {
  id: string;
  /** 资源前缀（以 / 结尾），如 `/models/3572004785/` */
  base: string;
  manifestUrl: string;
  manifest: unknown;
}

export interface PackageEntry {
  id: string;
  base: string;
  manifest: string;
  title: string | null;
  author: string | null;
  packType: string | null;
  characters: number;
  /**
   * 角色 id 列表。
   *
   * 为什么放进索引：列表页要按角色分组、显示"N 个模型"角标。以前它是**逐卡拉 manifest** 拿的 ——
   * 静态部署下 models/ 未必跟着发布，于是 355 个请求全 404，页面一直停在"正在读取列表"。
   * 索引里带上它，列表页就不再需要 manifest，静态模式才真正成立。
   */
  characterIds: string[];
  avatar: string | null;
  preview: string | null;
  kinds: string[];
}

export interface PackageIndex {
  schema: number;
  generatedAt: string;
  packages: PackageEntry[];
}

/**
 * 产物目录名是否算一个"包"。
 *
 * 两种合法形态：创意工坊的纯数字 id，以及上传解包时生成的 `upload-…`。
 * 这个判断必须只有一份：CLI 的扫描器与 Vite 插件如果各写各的，
 * 就会出现"上传成功、落了盘，但列表里永远看不到"这种最难查的问题。
 */
export function isPackageId(id: string): boolean {
  return /^\d+$/.test(id) || /^upload-[\w-]+$/.test(id);
}

/** 从清单里安全地取一个嵌套值 */
function pick(record: unknown, ...path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const asText = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** 单个包 → 列表条目；清单坏了就返回 null（不让一个坏包毁掉整个列表） */
export function buildPackageEntry(source: PackageIndexSource): PackageEntry | null {
  const manifest = source.manifest;
  if (typeof manifest !== 'object' || manifest === null) return null;
  const characters = Array.isArray(pick(manifest, 'characters')) ? (pick(manifest, 'characters') as unknown[]) : [];
  const first = characters[0];
  const avatarPath = asText(pick(first, 'avatarPath'));
  const preview = asText(pick(manifest, 'package', 'preview'));
  const characterIds = characters
    .map((c) => asText(pick(c, 'id')))
    .filter((id): id is string => id !== null);
  return {
    id: source.id,
    base: source.base,
    manifest: source.manifestUrl,
    title: asText(pick(manifest, 'package', 'title')),
    author: asText(pick(manifest, 'package', 'author')),
    packType: asText(pick(manifest, 'package', 'mlveType')),
    characters: characters.length,
    characterIds,
    avatar: avatarPath ? `${source.base}${avatarPath}` : null,
    preview: preview ? `${source.base}${preview}` : null,
    kinds: [...new Set(characters.map((c) => asText(pick(c, 'kind')) ?? 'spine'))],
  };
}

/** 全部包 → 列表 JSON（按 id 排序，保证两个消费者输出一致） */
export function buildPackageIndex(sources: PackageIndexSource[], generatedAt = new Date().toISOString()): PackageIndex {
  const packages: PackageEntry[] = [];
  for (const source of sources) {
    const entry = buildPackageEntry(source);
    if (entry) packages.push(entry);
  }
  packages.sort((a, b) => a.id.localeCompare(b.id));
  return { schema: 1, generatedAt, packages };
}
