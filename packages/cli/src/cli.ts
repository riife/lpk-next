/**
 * CLI 入口：用 Node 24 自带的 `parseArgs` 解析参数、`styleText` 上色（不引第三方 CLI 框架）。
 *
 * 子命令：
 *   unpack <lpk 或目录> [-o 输出目录]   解包到磁盘
 *   serve [-p 端口] [--out 目录]        起 hono 服务器（静态托管 + /api）
 *
 * 直接 `node src/cli.ts …` 运行 TypeScript（Node 的类型擦除），所以本包开 erasableSyntaxOnly。
 */
import { parseArgs, styleText } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { unpackLpk } from '@lpk/unpacker';
import { nodeFsIO } from './io-node.ts';
import { createServer } from './server.ts';

const HELP = `
${styleText('bold', 'lpk —— Live2DViewerEX .lpk 解包与本地服务器')}

用法：
  lpk unpack <lpk 文件或包目录> [选项]    解包到磁盘
  lpk serve [选项]                        起本地服务器（前端 + /api）
  lpk --help

unpack 选项：
  -o, --out <目录>     输出目录（默认 $LPK_OUT，否则 <cwd>/out）
  -q, --quiet          安静模式
  --force              输出目录已存在时也覆盖

serve 选项：
  -p, --port <端口>    监听端口（默认 5599）
  --out <目录>         要服务的解包产物目录（默认 $LPK_OUT，否则 <cwd>/out）
  --web <目录>         前端静态产物目录（默认自动找 apps/web/dist）
  --host <地址>        默认 127.0.0.1（只监听本机，前端探测才快）

环境变量：
  LPK_OUT              解包产物目录（与 vite 用的是同一个变量，两边默认值一致）
`;

/** 解包一个 .lpk（同时读同目录的 config.json 与 config.json 指定的预览图） */
function unpackOne(lpkPath: string, outDir: string, log: (line: string) => void): string {
  const id = basename(lpkPath).replace(/\.lpk$/i, '');
  const dir = resolve(outDir, id);
  mkdirSync(dir, { recursive: true });

  const configPath = join(lpkPath, '..', 'config.json');
  const externalConfig = existsSync(configPath)
    ? { bytes: new Uint8Array(readFileSync(configPath)), name: 'config.json' }
    : null;
  if (!externalConfig) log(styleText('yellow', '  提示：同目录没有 config.json，STM_1_0 包可能解不开'));

  /* 预览图由 config.json 的 previewFile 指定（解包器不碰文件系统，所以在这里读） */
  let preview: { bytes: Uint8Array; name: string } | null = null;
  if (externalConfig) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(externalConfig.bytes)) as { previewFile?: string };
      if (typeof parsed.previewFile === 'string' && parsed.previewFile.length > 0) {
        const previewPath = join(lpkPath, '..', parsed.previewFile);
        if (existsSync(previewPath)) preview = { bytes: new Uint8Array(readFileSync(previewPath)), name: parsed.previewFile };
      }
    } catch {
      /* 配置坏了就当没有预览 */
    }
  }

  const result = unpackLpk({
    bytes: new Uint8Array(readFileSync(lpkPath)),
    name: basename(lpkPath),
    outDir: id,
    io: nodeFsIO(outDir),
    externalConfig,
    preview,
    keepRaw: false,
    log,
  });
  log(
    styleText('green', `  ✔ ${id}`) +
      `：${result.manifest.characters.length} 个角色 / ${result.manifest.entries.length} 个条目`,
  );
  return id;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      port: { type: 'string', short: 'p' },
      web: { type: 'string' },
      host: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  const cwd = process.cwd();
  const quiet = Boolean(values.quiet);
  const log = (line: string): void => {
    if (!quiet) console.log(line);
  };

  if (command === 'unpack') {
    const target = positionals[1];
    if (!target) throw new Error('unpack 需要一个 .lpk 文件或包含 .lpk 的目录');
    /* 与 serve / vite 用同一个约定：--out 优先，其次 LPK_OUT，最后 <cwd>/out */
    const outDir = resolve(values.out ?? process.env.LPK_OUT ?? join(cwd, 'out'));

    /* 目录形式：把里面每个 .lpk 都解一遍 */
    const stats = statSync(target);
    const lpkFiles = stats.isDirectory()
      ? readdirSync(target, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.lpk'))
          .map((e) => join(target, e.name))
      : [target];
    if (lpkFiles.length === 0) throw new Error(`${target} 里没有 .lpk`);

    for (const lpkPath of lpkFiles) {
      log(styleText('bold', `解包 ${basename(lpkPath)} → ${outDir}`));
      unpackOne(lpkPath, outDir, log);
    }
    return;
  }

  if (command === 'serve') {
    /* 产物目录：--out 优先，其次 LPK_OUT 环境变量（与 vite 用同一个变量），最后 <cwd>/out */
    const outDir = resolve(values.out ?? process.env.LPK_OUT ?? join(cwd, 'out'));
    /* 前端产物：默认在 monorepo 里找 apps/web/dist */
    const webCandidates = [
      values.web,
      join(cwd, 'apps', 'web', 'dist'),
      join(cwd, '..', '..', 'apps', 'web', 'dist'),
      join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'dist'),
    ].filter((p): p is string => typeof p === 'string');
    const webRoot = webCandidates.find((p) => existsSync(p)) ?? null;
    const port = Number(values.port ?? 5599);
    const host = values.host ?? '127.0.0.1';

    /* 目录不存在或里面没有解出来的包时，列表必然是空的 —— 提前说清楚，
       免得用户以为是服务坏了（这时仍可把 .lpk 拖进页面，由前端解包到内存）。 */
    const packCount = existsSync(outDir)
      ? readdirSync(outDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(outDir, e.name, 'manifest.json'))).length
      : 0;

    const app = createServer({ outDir, webRoot, log: (line) => console.log(line) });
    const { serve } = await import('@hono/node-server');
    const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      console.log(styleText('green', `lpk serve 已启动`));
      console.log(`  地址      ${styleText('bold', `http://${host}:${info.port}/`)}`);
      console.log(`  产物目录  ${outDir}${existsSync(outDir) ? `（${packCount} 个包）` : styleText('yellow', '（还不存在）')}`);
      console.log(`  前端产物  ${webRoot ?? styleText('yellow', '未找到（只提供 /api）')}`);
      console.log(`  探测点    http://${host}:${info.port}/api/health`);
      if (packCount === 0) {
        console.log(
          styleText(
            'yellow',
            `  提示：产物目录里还没有解出来的包，列表会是空的。\n` +
              `        用 lpk unpack 解包，或把 .lpk 拖进页面（浏览器内解包，只放内存）。\n` +
              `        要换个目录：lpk serve --out <目录>，或设环境变量 LPK_OUT。`,
          ),
        );
      }
    });
    /* Ctrl+C 时干净退出，避免端口残留 */
    process.on('SIGINT', () => {
      server.close();
      process.exit(0);
    });
    return;
  }

  throw new Error(`未知子命令：${command}（试试 lpk --help）`);
}

main().catch((error: unknown) => {
  console.error(styleText('red', `✘ ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
