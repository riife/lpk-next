/**
 * LPK 加密算法（Live2DViewerEX 的"伪随机流异或"）
 *
 * 逆向结论（与社区实现一致）：
 *   1. 每个条目用 genKey(seed) 得到一个 32 位整数作为密钥种子；
 *   2. 明文按 1024 字节分块，每块重新以种子初始化 LCG 状态；
 *   3. LCG：state = (2531011 + 214013 * state) >> 16 & 0xffff，取低 8 位作为密钥字节；
 *   4. 密文 = 明文 XOR 密钥字节。
 *
 * seed 的拼法取决于 config.mlve 的 type：
 *   STM_1_0（Steam 创意工坊）：mlve.id + configFileId + 条目名 + config.metaData
 *   STD2_0 / STD_1_0        ：mlve.id + 条目名
 */
import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** 加解密是同一个异或操作，所以只实现一次 */
const BLOCK_SIZE = 1024;
const LCG_MUL = 214013;
const LCG_ADD = 2531011;
/** LCG 状态的进位单位（2^16）：取 (LCG_ADD + LCG_MUL * state) 的高 16 位 */
const KEY_BLOCK_BYTES = 65536;

/** LPK 里被加密的条目名：32 位小写 hex + 可选 .bin/.bin3 后缀 */
export const ENCRYPTED_NAME_RE = /^[0-9a-f]{32}(?:\.bin3?)?$/;

/**
 * 字符串（UTF-8）的 MD5 十六进制。
 * 用 @noble/hashes（已审计、零依赖、Node 与浏览器通用）而不是自己实现，也不是 node:crypto。
 */
export function md5Hex(text: string): string {
  return bytesToHex(md5(utf8ToBytes(text)));
}

/**
 * 种子字符串 → 32 位无符号整数密钥。
 * 与 Python 版 `ret = (ret * 31 + ord(ch)) & 0xffffffff` 完全等价（按 Unicode 码点迭代）。
 */
export function genKey(seed: string): number {
  let ret = 0;
  for (const ch of seed) {
    const code = ch.codePointAt(0) ?? 0;
    ret = (ret * 31 + code) >>> 0; // >>> 0 即 & 0xffffffff
  }
  return ret >>> 0;
}

/** 异或流：encrypt 与 decrypt 是同一个函数 */
export function lpkCrypt(key: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  const seed = key >>> 0;
  for (let base = 0; base < data.length; base += BLOCK_SIZE) {
    const end = Math.min(base + BLOCK_SIZE, data.length);
    let state = seed;
    for (let i = base; i < end; i++) {
      /* 数学细节：state 始终 < 2^16，214013 * state < 2^49，double 可以精确表示，
         所以不需要 BigInt，用普通 number 即可。这里必须写成 Math.floor(x / KEY_BLOCK_BYTES)
         而不是 `x >> 16` —— 中间结果远超 int32，位移会先按 int32 截断，密钥就全错了。 */
      state = Math.floor((LCG_ADD + LCG_MUL * state) / KEY_BLOCK_BYTES) & 0xffff;
      out[i] = data[i] ^ (state & 0xff);
    }
  }
  return out;
}

/** 试算密钥用的候选种子（顺序即优先级） */
export function candidateSeeds(id: string, entryName: string, fileId?: string | null, metaData?: string | null): string[] {
  const seeds: string[] = [];
  if (fileId) {
    seeds.push(id + fileId + entryName + (metaData ?? ''));
    seeds.push(id + fileId + entryName);
  }
  seeds.push(id + entryName);
  if (metaData) seeds.push(id + entryName + metaData);
  return seeds;
}
