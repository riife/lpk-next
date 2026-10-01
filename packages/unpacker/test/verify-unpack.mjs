/**
 * 逐字节比对：新解包器（平台无关、fflate + noble/hashes + IO 注入）的产物
 * 必须与**旧实现**的产物逐文件相同。
 *
 * 旧实现已经不在磁盘上了，所以参照物是**仓库里的基线文件**
 * （test/fixtures/reference-hashes.json：355 个包 / 26224 个文件的长度与 sha256，
 * 抓取时归一化掉 manifest.json 里必然不同的 generatedAt 与 tool）。
 * 这样这条验收在任何机器上都能跑 —— 只要本机有对应的 .lpk，不需要旧工程还在旁边。
 *
 * 运行：node packages/unpacker/test/verify-unpack.mjs [包 id ...]
 *   需要 LPK_WORKSHOP 指向创意工坊包目录；没有就跳过（并说明怎么配）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin, relative } from 'node:path';
import { unpackLpk } from '../src/unpack.ts';
import { MemoryIO } from '../src/io.ts';
import { sampleIds, skipWithoutWorkshop, workshopConfig, workshopDir, workshopLpk } from './env.mjs';

const BASELINE_PATH = nodeJoin(import.meta.dirname, 'fixtures', 'reference-hashes.json');
const BASELINE = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null;
const DEFAULT_IDS = sampleIds;

/** Node 侧 IO 适配器：解包器只认 POSIX 相对路径，这里映射到真实目录 */
function nodeFsIO(root) {
  const abs = (rel) => nodeJoin(root, ...rel.split('/'));
  return {
    readFile: (rel) => {
      const p = abs(rel);
      return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
    },
    mkdir: (rel) => mkdirSync(abs(rel), { recursive: true }),
    writeFile: (rel, data) => {
      mkdirSync(nodeJoin(abs(rel), '..'), { recursive: true });
      writeFileSync(abs(rel), data);
    },
  };
}

const walk = (dir, base = dir, out = []) => {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const p = nodeJoin(dir, item.name);
    if (item.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
};

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/**
 * 基线的 manifest 哈希与长度都是"忽略 generatedAt 与 tool"之后算的，这里保持一致。
 *
 * 注意用 TextDecoder 解字节：`Uint8Array.prototype.toString()` **不认参数**，
 * 传 'utf8' 也会得到 "123,34,103,…" 这种逗号拼接的数字串，正则永远匹配不上 ——
 * 于是时间戳留在里面、哈希必然不同。
 *
 * `tool` 也要忽略：新工程写的是 lpk-next（8 字节），基线（旧实现产物）里是 lpk-studio（10 字节），
 * 归一化必须**连长度一起算** —— 只抹哈希不抹长度，就会出现"内容一样却差 2 字节"的误报。
 */
const normalizeManifest = (bytes) =>
  new TextDecoder()
    .decode(bytes)
    .replace(/"generatedAt": "[^"]*"/, '"generatedAt": "<ignored>"')
    .replace(/"tool": "[^"]*"/, '"tool": "<ignored>"');
const manifestHash = (bytes) => sha(Buffer.from(normalizeManifest(bytes), 'utf8'));

if (skipWithoutWorkshop('逐字节比对')) process.exit(0);
if (!BASELINE) {
  console.log('  （跳过逐字节比对：找不到基线文件 test/fixtures/reference-hashes.json）');
  process.exit(0);
}

const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_IDS;
let packsChecked = 0;
let filesChecked = 0;
let failed = 0;

for (const id of ids) {
  const lpkPath = workshopLpk(id);
  const baseline = BASELINE.packages[id];
  if (!lpkPath || !baseline) {
    console.log(`  （跳过，缺少 lpk 或基线）${id}`);
    continue;
  }

  const tempRoot = mkdtempSync(nodeJoin(tmpdir(), `lpk-verify-${id}-`));
  try {
    const bytes = new Uint8Array(readFileSync(lpkPath));
    const extra = {};
    const configPath = workshopConfig(id);
    if (configPath) {
      const configBytes = new Uint8Array(readFileSync(configPath));
      extra.externalConfig = { bytes: configBytes, name: 'config.json' };
      /* 预览图由 config.json 的 previewFile 指定（文件在 .lpk 同级）。
         读它是**调用方（CLI）的职责** —— 解包器只收字节，不碰文件系统。 */
      try {
        const parsed = JSON.parse(Buffer.from(configBytes).toString('utf8'));
        if (typeof parsed.previewFile === 'string' && parsed.previewFile.length > 0) {
          const previewPath = nodeJoin(workshopDir(), id, parsed.previewFile);
          if (existsSync(previewPath)) {
            extra.preview = { bytes: new Uint8Array(readFileSync(previewPath)), name: parsed.previewFile };
          }
        }
      } catch {
        /* 配置坏了就当没有预览图 */
      }
    }
    unpackLpk({
      bytes,
      name: `${id}.lpk`,
      outDir: '.',
      io: nodeFsIO(tempRoot),
      ...extra,
      log: () => {},
    });

    const produced = walk(tempRoot).sort();
    const expected = Object.keys(baseline.files).sort();

    let mismatched = 0;
    const onlyMine = produced.filter((f) => !expected.includes(f));
    const onlyBaseline = expected.filter((f) => !produced.includes(f));
    if (onlyMine.length > 0 || onlyBaseline.length > 0) {
      console.log(`  ✘ ${id} 文件清单不同：新多出 ${onlyMine.slice(0, 3).join(',') || '无'}；基线多出 ${onlyBaseline.slice(0, 3).join(',') || '无'}`);
      mismatched += 1;
    }

    for (const rel of produced) {
      const want = baseline.files[rel];
      if (!want) continue;
      const mine = new Uint8Array(readFileSync(nodeJoin(tempRoot, ...rel.split('/'))));
      filesChecked += 1;
      /* 归一化过的条目（manifest.json）：长度也要按归一化之后算 */
      const actualSize = want.normalized ? Buffer.byteLength(normalizeManifest(mine), 'utf8') : mine.length;
      const actual = want.normalized ? manifestHash(mine) : sha(mine);
      if (actualSize !== want.size || actual !== want.sha256) {
        mismatched += 1;
        if (mismatched <= 3) console.log(`  ✘ ${id}/${rel}：${actualSize}B/${actual.slice(0, 12)} vs 基线 ${want.size}B/${want.sha256.slice(0, 12)}`);
      }
    }

    packsChecked += 1;
    if (mismatched > 0) failed += 1;
    console.log(`  ${mismatched === 0 ? '✔' : '✘'} ${id}：新产物 ${produced.length} 个文件，与基线一致 ${mismatched === 0}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/* 顺带证明浏览器侧可行：同一个包用 MemoryIO 解一遍，文件数应当与基线一致 */
const scratchId = ids.find((id) => workshopLpk(id) && BASELINE.packages[id]);
if (scratchId) {
  const io = new MemoryIO();
  const extra = {};
  const configPath = workshopConfig(scratchId);
  if (configPath) {
    const configBytes = new Uint8Array(readFileSync(configPath));
    extra.externalConfig = { bytes: configBytes, name: 'config.json' };
    try {
      const parsed = JSON.parse(Buffer.from(configBytes).toString('utf8'));
      if (typeof parsed.previewFile === 'string' && parsed.previewFile.length > 0) {
        const previewPath = nodeJoin(workshopDir(), scratchId, parsed.previewFile);
        if (existsSync(previewPath)) extra.preview = { bytes: new Uint8Array(readFileSync(previewPath)), name: parsed.previewFile };
      }
    } catch {
      /* 忽略 */
    }
  }
  unpackLpk({ bytes: new Uint8Array(readFileSync(workshopLpk(scratchId))), name: `${scratchId}.lpk`, outDir: '.', io, ...extra, log: () => {} });
  const expectedCount = Object.keys(BASELINE.packages[scratchId].files).length;
  const ok = io.files.size === expectedCount;
  console.log(`  ${ok ? '✔' : '✘'} MemoryIO（浏览器侧路径）：${io.files.size} 个文件 vs 基线 ${expectedCount} 个`);
  if (!ok) failed += 1;
}

console.log(`\n  逐字节比对：${packsChecked} 个包 / ${filesChecked} 个文件，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
