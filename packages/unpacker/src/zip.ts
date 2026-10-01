/**
 * ZIP 容器读取（基于 fflate）
 *
 * LPK 本身就是一个 ZIP 容器。这里不再自己解析中央目录与 inflate，而是直接用
 * fflate 的 `unzipSync` —— 它是一个成熟的跨平台包（Node 与浏览器同一份实现），
 * 正好用来替换原先的 `node:zlib`。
 *
 * 接口保持与旧实现一致：`entries`（只需 name）、`find`、`read`、`readName`。
 * 旧实现里的 method/flags/crc32/compressedSize/localOffset 字段全工程都没有用到，
 * 因此不再保留（见 test/verify-zip.mjs 的逐条比对，确认内容完全一致）。
 *
 * 代价：`unzipSync` 会一次性解开所有条目（旧实现是按需 inflate）。
 * 单包最大约 300 MB，可以接受；解包器本来就是"整包读入再写盘"的流程。
 */
import { unzipSync } from 'fflate';

export interface ZipEntry {
  /** 条目名（LPK 中通常是原始文件名的 md5，例如 04bc...ff.bin） */
  name: string;
}

export class ZipArchive {
  readonly entries: ZipEntry[];
  private readonly files: Record<string, Uint8Array>;

  constructor(buffer: Uint8Array) {
    this.files = unzipSync(buffer);
    this.entries = Object.keys(this.files).map((name) => ({ name }));
  }

  find(name: string): ZipEntry | undefined {
    return this.entries.find((entry) => entry.name === name);
  }

  /** 按条目读取内容 */
  read(entry: ZipEntry): Uint8Array {
    const data = this.files[entry.name];
    if (!data) throw new Error(`LPK 中不存在条目：${entry.name}`);
    return data;
  }

  /** 按条目名读取 */
  readName(name: string): Uint8Array {
    const entry = this.find(name);
    if (!entry) throw new Error(`LPK 中不存在条目：${name}`);
    return this.read(entry);
  }
}
