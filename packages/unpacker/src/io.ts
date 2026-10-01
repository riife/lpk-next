/**
 * 解包器的 IO 契约（平台无关）
 *
 * 解包器自己**不碰文件系统**：它只接受字节，把所有落盘动作交给注入进来的实现。
 *   * Node 侧（CLI）：一个基于 node:fs 的实现；
 *   * 浏览器侧：一个写进内存 Map 的实现（静态模式下资源只放内存）。
 * 这样"同一份代码两端都能跑"是硬保证，而不是靠运行时判断环境。
 *
 * 路径约定：全部是 POSIX 相对路径（见 posix.ts），由调用方决定它们对应磁盘上的哪里。
 */
export interface UnpackIO {
  /** 读文件；不存在返回 null（不要抛异常，调用方靠 null 判断可选文件） */
  readFile(path: string): Uint8Array | null;
  /** 递归创建目录（已存在不算错） */
  mkdir(path: string): void;
  /** 写文件（父目录必须已由 mkdir 创建） */
  writeFile(path: string, data: Uint8Array): void;
}

/** 把字符串按 UTF-8 写盘时的便捷封装 */
export const encodeText = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 内存实现：静态模式（浏览器）用它，测试也用它可以完全不碰磁盘 */
export class MemoryIO implements UnpackIO {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();

  readFile(path: string): Uint8Array | null {
    return this.files.get(path) ?? null;
  }

  mkdir(path: string): void {
    this.dirs.add(path);
  }

  writeFile(path: string, data: Uint8Array): void {
    this.files.set(path, data);
  }
}
