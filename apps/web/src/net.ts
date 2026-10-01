/**
 * 运行模式探测与两种模式下的数据获取。
 *
 * 需求里最关键的一条：**前端自动识别后端是否存活来判断当前模式**。
 *   * 服务器模式（`/api/health` 有响应）：列表来自 `/api`，拖入的 `.lpk` 上传给服务器解包，
 *     解包结果落盘，删除也落到磁盘；
 *   * 静态模式（没有 `/api`，例如把 dist/ 直接丢给静态服务器）：列表来自构建期生成的
 *     `packages.json`，拖入的 `.lpk` 在**浏览器里**解包，结果只放内存。
 *
 * 因为后端必须是本机运行，探测用很短的超时（300ms）就够，卡住的情况等于静态模式。
 */

export type RunMode = 'server' | 'static';

export interface PackageEntry {
  id: string;
  base: string;
  manifest: string;
  title: string | null;
  author: string | null;
  packType: string | null;
  characters: number;
  /** 角色 id 列表（列表页据此分组、显示"N 个模型"，不必再拉 manifest） */
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

/** 探测后端是否存活。任何异常/超时都算静态模式。 */
export async function detectMode(timeoutMs = 300): Promise<RunMode> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
    return response.ok ? 'server' : 'static';
  } catch {
    return 'static';
  } finally {
    clearTimeout(timer);
  }
}

/** 列表 JSON：服务器模式走 /api，静态模式走构建期产物 packages.json */
export async function loadPackageIndex(mode: RunMode): Promise<PackageIndex> {
  const url = mode === 'server' ? '/api/packages' : 'packages.json';
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`取列表失败：${url} → HTTP ${response.status}`);
  const data = (await response.json()) as PackageIndex;
  return { schema: data.schema ?? 1, generatedAt: data.generatedAt ?? '', packages: data.packages ?? [] };
}

/**
 * 服务器模式：把 .lpk 交给服务器解包，返回新条目的 id。
 * `files` 里若有 config.json 也一起传 —— STM_1_0 包的密钥要用它推导，
 * 服务器同样需要（包是上传上来的，它同级目录里没有这个文件）。
 */
export async function unpackOnServer(file: File, files: File[] = []): Promise<{ id: string; entry?: PackageEntry }> {
  const form = new FormData();
  form.append('lpk', file, file.name);
  const config = files.find((item) => item.name.toLowerCase() === 'config.json');
  if (config) form.append('config', config, config.name);
  const response = await fetch('/api/unpack', { method: 'POST', body: form });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`服务器解包失败：HTTP ${response.status}${text ? ` —— ${text.slice(0, 200)}` : ''}`);
  }
  return (await response.json()) as { id: string; entry?: PackageEntry };
}

/** 服务器模式：删除一个包（服务器侧同时删磁盘目录） */
export async function deletePackage(id: string): Promise<void> {
  const response = await fetch(`/api/packages/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`删除失败：HTTP ${response.status}${text ? ` —— ${text.slice(0, 200)}` : ''}`);
  }
}

/** 拖入的文件里是否有 .lpk */
export function findLpkFile(files: File[]): File | null {
  return files.find((file) => file.name.toLowerCase().endsWith('.lpk')) ?? null;
}
