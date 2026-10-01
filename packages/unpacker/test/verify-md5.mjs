/**
 * MD5 依赖的正确性验证：确认 @noble/hashes 的 md5 与 Node 的 createHash('md5') 一致。
 *
 * 为什么要有这条测试：LPK 的条目名就是 md5，算法差一点整包都解不开；
 * 而且必须与既有工程（用 node:crypto 实现）**逐字节相同**，否则新老解包结果不一致。
 *
 * 运行：pnpm --filter @lpk/unpacker test
 */
import { createHash } from 'node:crypto';
import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { md5Hex } from '../src/lpk.ts';

const hashHex = (data) => createHash('md5').update(data).digest('hex');
const nobleHex = (text) => bytesToHex(md5(utf8ToBytes(text)));

let total = 0;
let failed = 0;
const check = (label, expected, actual) => {
  total += 1;
  if (expected !== actual) {
    failed += 1;
    if (failed <= 5) console.log(`  ✘ ${label}：期望 ${expected}，实际 ${actual}`);
  }
};

/* 边界长度：MD5 填充在 55/56/64/119/120 处行为不同 */
for (const n of [0, 1, 2, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 1000, 65535]) {
  const text = 'a'.repeat(n);
  check(`长度 ${n}`, hashHex(Buffer.from(text, 'utf8')), nobleHex(text));
}

/* 真实形态：条目名、配置名、中文路径 */
for (const text of [
  'config.mlve',
  '04bc1a4d2e7b3f5a6c8d9e0f1a2b3c4d',
  'Melody/Melody.model3.json',
  'Melody.atlas',
  '碧蓝航线 天城换装「红鸢的闲暇片刻」',
  'emoji 🙂 与制表符\t换行\n结束',
]) {
  check(text.slice(0, 24), hashHex(Buffer.from(text, 'utf8')), nobleHex(text));
}

/* 解包器导出的 md5Hex 也必须一致（它是全工程唯一的哈希入口） */
for (const text of ['config.mlve', 'Melody.png', '碧蓝航线']) {
  check(`md5Hex(${text})`, hashHex(Buffer.from(text, 'utf8')), md5Hex(text));
}

console.log(`  MD5 比对：${total} 个用例，失败 ${failed} 个`);
process.exit(failed === 0 ? 0 : 1);
