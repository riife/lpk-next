/**
 * @lpk/unpacker —— 公开入口
 *
 * 平台无关：同一份代码在 Node 与浏览器里都能跑（不导入任何 node:*）。
 *   * Node 侧：调用方提供基于 node:fs 的 UnpackIO（见 @lpk/cli）；
 *   * 浏览器侧：用 MemoryIO（静态模式把资源放在内存里）。
 */
export { unpackLpk, loadPackage, referencedEntryNames } from './unpack.ts';
export type { UnpackOptions, UnpackResult, LoadedPackage, LoadedEntry } from './unpack.ts';
export { buildPackageEntry, buildPackageIndex, isPackageId } from './index-build.ts';
export type { PackageEntry, PackageIndex, PackageIndexSource } from './index-build.ts';
export { ZipArchive } from './zip.ts';
export type { ZipEntry } from './zip.ts';
export { MemoryIO, encodeText } from './io.ts';
export type { UnpackIO } from './io.ts';
export { basename, dirname, isAbsolute, isInside, join, normalize } from './posix.ts';
export { ENCRYPTED_NAME_RE, candidateSeeds, genKey, lpkCrypt, md5Hex } from './lpk.ts';
export * from './manifest.ts';
