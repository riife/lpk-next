/**
 * ZIP 层的交叉验证：新实现（fflate）与独立实现（手写中央目录解析 + node:zlib）逐条比对。
 *
 * 为什么要两条独立实现比对：`unzipSync` 自己和自己比是套套逻辑，
 * 必须用另一套代码路径（Node 自带 zlib）解出同样的内容，才能证明换库之后**内容没变**。
 *
 * 运行：node packages/unpacker/test/verify-zip.mjs [lpk ...]
 *   不给参数就用内置抽样包（需要 LPK_WORKSHOP；没配置就跳过）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ZipArchive } from '../src/zip.ts';
import { sampleIds, skipWithoutWorkshop, workshopLpk } from './env.mjs';

if (skipWithoutWorkshop('ZIP 交叉验证')) process.exit(0);
const DEFAULT_PACKS = sampleIds.map((id) => workshopLpk(id)).filter((path) => path !== null);

/** 独立实现：手写中央目录解析 + node:zlib */
function extractWithNodeZlib(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65535; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('找不到 EOCD');
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder('utf-8');
  const out = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = utf8.decode(buffer.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(start, start + compressedSize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)));
    else throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

const packs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_PACKS;
let packsChecked = 0;
let entriesChecked = 0;
let failed = 0;

for (const pack of packs) {
  if (!existsSync(pack)) {
    console.log(`  （跳过，不存在）${pack}`);
    continue;
  }
  const buffer = new Uint8Array(readFileSync(pack));
  const archive = new ZipArchive(buffer);
  let reference;
  try {
    reference = extractWithNodeZlib(buffer);
  } catch (error) {
    console.log(`  ✘ ${pack}：独立实现解不开 —— ${error.message}`);
    failed += 1;
    continue;
  }

  let mismatched = 0;
  if (archive.entries.length !== reference.size) {
    console.log(`  ✘ 条目数不同：fflate ${archive.entries.length} vs zlib ${reference.size}`);
    failed += 1;
    continue;
  }
  for (const entry of archive.entries) {
    const mine = archive.read(entry);
    const theirs = reference.get(entry.name);
    if (!theirs || mine.length !== theirs.length || sha(mine) !== sha(theirs)) {
      mismatched += 1;
      if (mismatched <= 3) {
        console.log(`  ✘ ${entry.name}：长度 ${mine.length} vs ${theirs?.length}，哈希 ${sha(mine)} vs ${theirs ? sha(theirs) : '-'}`);
      }
    }
    entriesChecked += 1;
  }
  packsChecked += 1;
  const ok = mismatched === 0;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✔' : '✘'} ${pack.split('\\').pop()}：${archive.entries.length} 个条目，全部内容一致 ${ok}`);
}

console.log(`\n  ZIP 交叉验证：${packsChecked} 个包 / ${entriesChecked} 个条目，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
