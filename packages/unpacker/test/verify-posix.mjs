/**
 * 路径工具与 IO 实现的验证：与 node:path 的 POSIX 行为逐项比对。
 *
 * 为什么要比对：我们自己实现的 join/dirname/basename 一旦与 node:path 有差异，
 * 解包出来的目录结构就会与既有工程不同（文件名、层级全都可能错），
 * 而这种错很难在"看起来能跑"的情况下发现。
 *
 * 运行：node packages/unpacker/test/verify-posix.mjs
 */
import { posix } from 'node:path';
import { basename, dirname, isInside, join, normalize } from '../src/posix.ts';
import { MemoryIO } from '../src/io.ts';

let total = 0;
let failed = 0;
const check = (label, expected, actual) => {
  total += 1;
  if (expected !== actual) {
    failed += 1;
    if (failed <= 10) console.log(`  ✘ ${label}：node:path=${JSON.stringify(expected)} 我们=${JSON.stringify(actual)}`);
  }
};

const inputs = [
  'a/b/c',
  'a/b/',
  '/a/b/c',
  '/a/b/',
  'a',
  '',
  '.',
  './a',
  'a/./b',
  'a/../b',
  '../a',
  'a/b/../../c',
  'Melody/Melody.model3.json',
  '碧蓝航线 天城换装「红鸢的闲暇片刻」/model3.json',
  'a//b///c',
  'out/3140192145/_raw/x.bin',
];

for (const input of inputs) {
  check(`normalize(${JSON.stringify(input)})`, posix.normalize(input) === '' ? '.' : posix.normalize(input), normalize(input));
  /* node:path 的 dirname/basename 对空串的行为与 normalize 不同，这里按同样输入直接比 */
  check(`dirname(${JSON.stringify(input)})`, posix.dirname(input) || '.', dirname(input));
  check(`basename(${JSON.stringify(input)})`, posix.basename(input), basename(input));
}

/* join 的多参数组合 */
const joinCases = [
  ['a', 'b'],
  ['a/', '/b'],
  ['out', '3140192145', 'manifest.json'],
  ['out', '..', 'x'],
  ['/root', 'a', '..', 'b'],
  ['', 'a', 'b'],
  ['a', ''],
];
for (const parts of joinCases) {
  check(`join(${JSON.stringify(parts)})`, posix.join(...parts), join(...parts));
}

/* basename 带后缀 */
check("basename('a/b.lpk', '.lpk')", posix.basename('a/b.lpk', '.lpk'), basename('a/b.lpk', '.lpk'));
check("basename('a/.lpk', '.lpk')", posix.basename('a/.lpk', '.lpk'), basename('a/.lpk', '.lpk'));

/* isInside：防目录逃逸的关键函数 */
const insideCases = [
  ['out/1', 'out/1/a/b', true],
  ['out/1', 'out/1', true],
  ['out/1', 'out/10/a', false],
  ['out/1', 'out/2/a', false],
  ['out/1', 'out/1/../2', false],
  /* outDir 为 `.` 是最常见的用法（解包到当前目录），必须判为在内 */
  ['.', 'Melody/Melody.json', true],
  ['.', './Melody/Melody.json', true],
  ['.', '.', true],
  ['.', '../x', false],
  ['.', '..', false],
];
for (const [parent, child, expected] of insideCases) {
  total += 1;
  const actual = isInside(parent, child);
  if (actual !== expected) {
    failed += 1;
    console.log(`  ✘ isInside(${parent}, ${child})：期望 ${expected}，实际 ${actual}`);
  }
}

/* MemoryIO：静态模式要用的实现 */
const io = new MemoryIO();
io.mkdir('out/1');
io.writeFile('out/1/a.txt', new TextEncoder().encode('hello'));
io.writeFile('out/1/b.txt', io.readFile('out/1/a.txt') ?? new Uint8Array());
check('MemoryIO.readFile 命中', 'hello', new TextDecoder().decode(io.readFile('out/1/a.txt') ?? new Uint8Array()));
check('MemoryIO 二次写入', 'hello', new TextDecoder().decode(io.readFile('out/1/b.txt') ?? new Uint8Array()));
check('MemoryIO 未命中返回 null', null, io.readFile('out/1/none.txt'));

console.log(`  路径/IO 比对：${total} 个用例，失败 ${failed} 个`);
process.exit(failed === 0 ? 0 : 1);
