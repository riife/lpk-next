/**
 * Node 侧的 UnpackIO 实现：把解包器的落盘动作接到 node:fs 上。
 *
 * 解包器内部一律使用 POSIX 相对路径（见 @lpk/unpacker 的 posix.ts），
 * 这里负责把它映射到真实目录：`join(root, ...rel.split('/'))`。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UnpackIO } from '@lpk/unpacker';

export function nodeFsIO(root: string): UnpackIO {
  const abs = (rel: string): string => join(root, ...rel.split('/').filter((part) => part.length > 0));
  return {
    readFile: (rel) => {
      const path = abs(rel);
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    },
    mkdir: (rel) => {
      mkdirSync(abs(rel), { recursive: true });
    },
    writeFile: (rel, data) => {
      const path = abs(rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
  };
}

/** 递归删除一个目录（用于"删除包"：需求要求同时删磁盘） */
export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
