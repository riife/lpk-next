/**
 * 平台无关的 POSIX 风格路径工具
 *
 * 为什么不用 `node:path`：解包器要在浏览器里跑同一份代码。
 * 约定：**解包器内部一律使用 POSIX 相对路径**（形如 `Melody/Melody.json`），
 * 真正的磁盘路径由调用方（CLI）负责映射；这样路径逻辑是纯字符串运算，两端一致。
 */

/** 把反斜杠统一成正斜杠，并去掉重复斜杠（不处理 .. 与 .，交给 normalize） */
function toPosix(input: string): string {
  return input.replace(/\\/g, '/');
}

/** 消解 `.` 与 `..`；保留开头的 `/`（绝对路径）与**结尾的单个斜杠**（与 node:path 一致） */
export function normalize(input: string): string {
  const posix = toPosix(input);
  const absolute = posix.startsWith('/');
  const trailing = posix.length > 1 && posix.endsWith('/');
  const out: string[] = [];
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  if (absolute) return joined === '' ? '/' : `/${joined}${trailing ? '/' : ''}`;
  if (joined === '') return trailing ? './' : '.';
  return `${joined}${trailing ? '/' : ''}`;
}

/** 拼接路径（等价于 node:path.join 的 POSIX 行为：结果不带尾斜杠，根路径除外） */
export function join(...parts: string[]): string {
  const meaningful = parts.filter((part) => part !== '' && part !== undefined && part !== null);
  if (meaningful.length === 0) return '.';
  const result = normalize(meaningful.join('/'));
  if (result === '/' || result === './') return result === './' ? '.' : result;
  return result.endsWith('/') ? result.replace(/\/+$/, '') || '/' : result;
}

/** 取目录名（等价于 node:path.posix.dirname） */
export function dirname(input: string): string {
  const posix = toPosix(input);
  const trimmed = posix.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return trimmed.slice(0, index);
}

/** 取文件名；给了 ext 且匹配则去掉后缀（等价于 node:path.posix.basename） */
export function basename(input: string, ext?: string): string {
  const posix = toPosix(input).replace(/\/+$/, '');
  const index = posix.lastIndexOf('/');
  const name = index < 0 ? posix : posix.slice(index + 1);
  if (ext && ext.length > 0 && name.endsWith(ext) && name !== ext) return name.slice(0, -ext.length);
  return name;
}

/** 是否为绝对路径 */
export function isAbsolute(input: string): boolean {
  return toPosix(input).startsWith('/');
}

/**
 * 判断 child 是否在 parent 之内（用于防止 `..` 逃出输出目录）。
 * 两者都按 POSIX 语义比较；相等视为在内。
 * 特例：parent 是 `.`（当前目录）时，任何不以 `..` 开头的相对路径都算在内。
 */
export function isInside(parent: string, child: string): boolean {
  const base = normalize(parent);
  const target = normalize(child);
  if (base === target) return true;
  if (base === '.' || base === './') return target !== '..' && !target.startsWith('../');
  return target.startsWith(base.endsWith('/') ? base : `${base}/`);
}
