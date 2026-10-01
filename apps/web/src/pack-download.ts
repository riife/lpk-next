/**
 * "把 .lpk 打包成 zip 下载"这一页的逻辑。
 *
 * 输入：**解包前的目录**（里面有一个或多个 `.lpk`，以及 STM_1_0 包需要的同级 `config.json`），
 *       也可以直接给若干 `.lpk` 文件；
 * 输出：一个 zip，里面是**解包后的目录结构**：
 *
 *     <包名>/manifest.json
 *     <包名>/<角色>/…
 *     <包名>/source.config.json   （有外部 config.json 时）
 *
 * 全部在浏览器里完成：解包用 `@lpk/unpacker`（与 Node 侧同一份代码），
 * 压缩用 `fflate` —— 不经过服务器，所以纯内存模式（静态部署）下同样可用。
 */
import { zipSync, type Zippable } from 'fflate';
import { MemoryIO, unpackLpk } from '@lpk/unpacker';

export interface PackJob {
  /** `.lpk` 文件本身 */
  file: File;
  /** 同目录的 config.json（STM_1_0 包的密钥要用它推导，缺了会解不出模型） */
  config: File | null;
  /** config.json 里 `previewFile` 指向的预览图（CLI 解包时也会一起导出，这里保持一致） */
  preview: File | null;
  /** zip 里的顶层目录名（= 文件名去掉 .lpk） */
  folder: string;
}

export interface PackProgress {
  /** 第几个包（从 1 开始） */
  index: number;
  total: number;
  folder: string;
  /** 当前阶段 */
  phase: 'unpack' | 'zip' | 'done' | 'error';
  message: string;
}

/**
 * 从拖入/选择的文件里挑出所有 `.lpk`，并把同目录的 `config.json`（以及它指定的预览图）配上去。
 *
 * 目录拖进来时每个文件带 `webkitRelativePath`（形如 `<目录>/<包名>/3140192145.lpk`），
 * 所以"同一个目录"按它的父目录判断；单独选文件时只看文件名。
 *
 * 是 async 的：要读 `config.json` 才知道预览图叫什么（`previewFile`）。
 */
export async function collectPacks(files: File[]): Promise<PackJob[]> {
  const pathOf = (file: File): string =>
    String((file as File & { webkitRelativePath?: string }).webkitRelativePath || (file as File & { relativePath?: string }).relativePath || file.name).replace(/\\/g, '/');
  const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

  const byDir = new Map<string, Map<string, File>>();
  for (const file of files) {
    const dir = dirOf(pathOf(file));
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    byDir.get(dir)!.set(file.name.toLowerCase(), file);
  }

  const jobs: PackJob[] = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.lpk')) continue;
    const dir = dirOf(pathOf(file));
    const siblings = byDir.get(dir) ?? new Map<string, File>();
    const config = siblings.get('config.json') ?? null;

    /* 预览图：config.json 里的 previewFile 指的是同目录的一个文件 */
    let preview: File | null = null;
    if (config) {
      try {
        const parsed = JSON.parse(await config.text()) as { previewFile?: string };
        if (typeof parsed.previewFile === 'string' && parsed.previewFile.length > 0) {
          preview = siblings.get(parsed.previewFile.toLowerCase()) ?? null;
        }
      } catch {
        /* 配置坏了就当没有预览图（解包器那份也会忽略） */
      }
    }

    jobs.push({ file, config, preview, folder: file.name.replace(/\.lpk$/i, '') });
  }
  return jobs;
}

export interface ZipResult {
  blob: Blob;
  /** 每个包的结果（成功/失败与文件数、体积），用于在页面上如实汇报 */
  results: Array<{ folder: string; ok: boolean; files: number; bytes: number; message: string }>;
}

/**
 * 逐个包解包并写进 zip。
 *
 * 用 `level: 1`：解出来的内容大头是 PNG/MP3/moc3（本来就压过了），再高档位收益很小却明显更慢；
 * 1 档对 `.json` / `.atlas` 这类文本仍有压缩，整体是"快且不太亏"的选择。
 */
export async function buildZip(jobs: PackJob[], onProgress: (progress: PackProgress) => void): Promise<ZipResult> {
  const entries: Zippable = {};
  const results: ZipResult['results'] = [];

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const at = { index: index + 1, total: jobs.length, folder: job.folder };
    try {
      onProgress({ ...at, phase: 'unpack', message: `解包 ${job.file.name}（${(job.file.size / 1024 / 1024).toFixed(1)} MB）…` });
      const io = new MemoryIO();
      const unpacked = unpackLpk({
        bytes: new Uint8Array(await job.file.arrayBuffer()),
        name: job.file.name,
        outDir: '.',
        io,
        externalConfig: job.config ? { bytes: new Uint8Array(await job.config.arrayBuffer()), name: 'config.json' } : null,
        /* 预览图一起导出，这样 zip 的内容与 CLI 的 `lpk unpack` 产物一致 */
        preview: job.preview ? { bytes: new Uint8Array(await job.preview.arrayBuffer()), name: job.preview.name } : null,
        log: () => {},
      });

      let bytes = 0;
      for (const [path, data] of io.files) {
        entries[`${job.folder}/${path}`] = data;
        bytes += data.length;
      }
      const characters = unpacked.manifest.characters.length;
      results.push({ folder: job.folder, ok: true, files: io.files.size, bytes, message: `${characters} 个角色 / ${io.files.size} 个文件` });
      onProgress({ ...at, phase: 'done', message: `✔ ${characters} 个角色 / ${io.files.size} 个文件（${(bytes / 1024 / 1024).toFixed(1)} MB）` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      /* 认得出来的常见原因直接说清楚：STM_1_0 包缺 config.json 时只会报"没有找到模型配置" */
      const hint = !job.config && /没有找到模型配置/.test(message) ? '（这个包需要同目录的 config.json，请连同它一起拖入）' : '';
      results.push({ folder: job.folder, ok: false, files: 0, bytes: 0, message: `${message}${hint}` });
      onProgress({ ...at, phase: 'error', message: `✘ ${message}${hint}` });
    }
  }

  const okCount = results.filter((item) => item.ok).length;
  if (okCount === 0) throw new Error('没有成功解出任何包，未生成 zip');
  onProgress({ index: jobs.length, total: jobs.length, folder: '', phase: 'zip', message: `正在压缩 ${okCount} 个包…` });
  const zipped = zipSync(entries, { level: 1 });
  return { blob: new Blob([zipped as unknown as BlobPart], { type: 'application/zip' }), results };
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  /* 立刻 revoke 会让部分浏览器来不及开始下载，留一点时间 */
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
