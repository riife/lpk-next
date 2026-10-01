/**
 * Vite 配置
 *
 * ## 解包产物目录（`LPK_OUT`）
 *
 *   * **dev**：读 `LPK_OUT`（没设就用 `<仓库>/out`），`/api/packages` 与 `/models/**`
 *     都从它取数据 —— 重新解包后刷新页面即可，不用重启；
 *   * **build**：**只有显式设了 `LPK_OUT` 才把它复制进产物**（`dist/models/`）。
 *     裸跑 `pnpm build` 不会复制任何东西：默认目录可能是几十 GB 的全量语料，
 *     一句构建就把它拷进 `dist/` 既意外又占地方。没有模型时页面是**纯内存模式**
 *     （拖入 `.lpk` 由浏览器解包），这对"本来就没有后端的静态部署"正是想要的结果。
 *     要发布已解包的资源就写清楚：`LPK_OUT=<只含要发布的包的目录> pnpm build`。
 *
 * 目录来源优先级：命令行 flag > `.env*` 文件 > 进程环境变量 > 默认 `<仓库>/out`。
 * **没有写死任何本机绝对路径**：默认值由本文件位置推出，换台机器同样成立。
 */
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join as nodeJoin, normalize as nodeNormalize, resolve as nodeResolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin, type ResolvedConfig } from 'vite';
/* 列表 JSON 的结构与 id 规则都来自解包器：CLI 的 /api/packages 用的是同一份，两边不会漂移 */
import { buildPackageIndex, isPackageId, type PackageIndexSource } from '@lpk/unpacker';

/** 仓库根目录（apps/web 往上两级），仅用于定位默认值之外的兜底路径 */
const REPO_ROOT = nodeResolve(import.meta.dirname, '..', '..');

/**
 * **执行命令的目录**：相对路径（`LPK_OUT=./dist-models`）与默认值都按它来解。
 *
 * 不能直接用 `process.cwd()`：`pnpm --filter @lpk/web build` 会把脚本的 cwd 换成
 * `apps/web`，于是 `LPK_OUT=out` 会解到 `apps/web/out` —— 与"我在仓库根敲的命令"不符。
 * npm/pnpm 为此提供了 `INIT_CWD`（命令被敲下时所在目录），优先用它。
 */
const INVOKE_CWD = process.env.INIT_CWD ?? process.cwd();

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.atlas': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.bin3': 'application/octet-stream',
  '.moc3': 'application/octet-stream',
  '.model3.json': 'application/json; charset=utf-8',
  '.motion3.json': 'application/json; charset=utf-8',
  '.physics3.json': 'application/json; charset=utf-8',
};

function contentType(path: string): string {
  for (const [suffix, type] of Object.entries(MIME)) {
    if (path.toLowerCase().endsWith(suffix)) return type;
  }
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** 产物目录里有哪些包（含 manifest.json 的目录） */
function listPackages(outDir: string): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isPackageId(entry.name) && existsSync(nodeJoin(outDir, entry.name, 'manifest.json')))
    .map((entry) => entry.name);
}

/** 目录总字节数（只用于日志：复制大目录前先说清楚有多大，免得以为卡住了） */
function listBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = nodeJoin(dir, entry.name);
    if (entry.isDirectory()) total += listBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

/**
 * 列表 JSON：扫描解包产物目录。
 *
 * 只负责"扫目录 + 读清单"这件 Node 侧的事，**结构由 @lpk/unpacker 的 buildPackageIndex 决定** ——
 * 与 CLI 的 /api/packages 共用同一份实现：同一个判断（结构与 id 规则）只能有一处，
 * 两边各写一份迟早会漂移（静态模式列出这个包、服务器模式列不出，这类问题最难查）。
 */
function buildIndex(outDir: string): unknown {
  const sources: PackageIndexSource[] = [];
  for (const id of listPackages(outDir)) {
    try {
      sources.push({
        id,
        base: `/models/${id}/`,
        manifestUrl: `/models/${id}/manifest.json`,
        manifest: JSON.parse(readFileSync(nodeJoin(outDir, id, 'manifest.json'), 'utf8')),
      });
    } catch {
      /* 清单坏了就跳过这个包 */
    }
  }
  return buildPackageIndex(sources);
}

/**
 * dev 期插件：把解包产物与"取包"接口挂在 vite 的中间件上。
 * 这些都是**开发期**的路由，生产构建里不存在 ——
 * 前端探测 `/api/health` 失败后会自己回到静态模式。
 */
function devServerPlugin(options: { outDir: string; workshop: string | null }): Plugin {
  const { outDir, workshop } = options;
  return {
    name: 'lpk-dev-server',
    configureServer(server) {
      const json = (res: any, payload: unknown): void => {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
      };

      /* 静态模式用的列表 JSON：构建产物里也有一份同名文件（见下面的构建插件） */
      server.middlewares.use('/packages.json', (_req, res) => json(res, buildIndex(outDir)));
      server.middlewares.use('/api/packages', (_req, res) => json(res, buildIndex(outDir)));
      /* 存活探测：dev 下有它 → 前端按服务器模式跑 */
      server.middlewares.use('/api/health', (_req, res) => json(res, { ok: true, mode: 'dev', out: outDir }));

      /* 解包产物：/models/<包 id>/<包内路径> */
      server.middlewares.use('/models', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const target = nodeNormalize(nodeJoin(outDir, rel));
        /* 防目录穿越：必须仍在产物目录之内 */
        if (!target.startsWith(nodeNormalize(outDir)) || !existsSync(target) || !statSync(target).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('content-type', contentType(target));
        res.end(readFileSync(target));
      });

      /* 取一个包的三样东西：.lpk、config.json、config.json 里 previewFile 指向的预览图 */
      server.middlewares.use('/@lpk/package', (req, res) => {
        if (!workshop) {
          res.statusCode = 501;
          res.end('没有配置创意工坊目录：请设置 LPK_WORKSHOP=<steam>/steamapps/workshop/content/616720 后重启 vite');
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const id = url.searchParams.get('id') ?? '';
        if (!/^\d+$/.test(id)) {
          res.statusCode = 400;
          res.end('id 必须是数字');
          return;
        }
        const dir = nodeJoin(workshop, id);
        const lpkPath = nodeJoin(dir, `${id}.lpk`);
        if (!existsSync(lpkPath)) {
          res.statusCode = 404;
          res.end(`找不到 ${lpkPath}`);
          return;
        }
        const configPath = nodeJoin(dir, 'config.json');
        const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
        let preview: { name: string; data: Buffer } | null = null;
        if (config) {
          try {
            const parsed = JSON.parse(config) as { previewFile?: string };
            if (typeof parsed.previewFile === 'string' && parsed.previewFile.length > 0) {
              const previewPath = nodeJoin(dir, parsed.previewFile);
              if (existsSync(previewPath)) preview = { name: parsed.previewFile, data: readFileSync(previewPath) };
            }
          } catch {
            /* 配置坏了就当没有预览 */
          }
        }
        json(res, {
          id,
          name: `${id}.lpk`,
          lpk: readFileSync(lpkPath).toString('base64'),
          config,
          preview: preview ? { name: preview.name, data: preview.data.toString('base64') } : null,
        });
      });

      /* 列出工坊里有哪些包 */
      server.middlewares.use('/@lpk/list', (_req, res) => {
        const ids =
          workshop && existsSync(workshop)
            ? readdirSync(workshop, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name) && existsSync(nodeJoin(workshop, entry.name, `${entry.name}.lpk`)))
                .map((entry) => entry.name)
            : [];
        json(res, { workshop, ids });
      });
    },
  };
}

/**
 * 把解包产物逐个包复制进构建产物，并**逐包打印进度**。
 *
 * 两点考虑：
 *   * 不用一次 `cpSync(整个目录)`：大目录要拷几分钟，只在结束时打一行"已完成"，
 *     中途完全看不出在动、也不知道卡在哪个包上；
 *   * 进度在**拷贝前**打印（而不是拷完之后）：单个包很大时也总有"正在做什么"可看，
 *     拷完再打的话那一行会迟迟不出现。总用时在最后的汇总里给。
 */
function copyPackages(outDir: string, target: string, log: (line: string) => void): void {
  const packs = listPackages(outDir);
  const sized = packs.map((id) => ({ id, bytes: listBytes(nodeJoin(outDir, id)) }));
  const totalBytes = sized.reduce((sum, item) => sum + item.bytes, 0);
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  log(`  lpk: 开始复制 ${sized.length} 个包（合计 ${mb(totalBytes)}）→ ${target}`);
  const started = Date.now();
  sized.forEach((item, index) => {
    log(`  lpk: [${index + 1}/${sized.length}] ${item.id}（${mb(item.bytes)}）…`);
    cpSync(nodeJoin(outDir, item.id), nodeJoin(target, item.id), { recursive: true });
  });
  log(`  lpk: 复制完成：${sized.length} 个包 / ${mb(totalBytes)}，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * 构建期插件：写列表 JSON，并在**显式指定了 `LPK_OUT` 时**把解包产物复制进构建产物。
 *
 * 为什么默认不复制：产物目录的默认值是 `<仓库>/out`，那可能是几十 GB 的全量语料。
 * 一句 `pnpm build` 就把它整套拷进 `dist/` 既意外又占地方 —— 复制必须是**明确要求的**。
 * 所以规则是：
 *   * 设了 `LPK_OUT` → 只复制这个目录（构建日志逐包报出进度）；
 *   * 没设 `LPK_OUT` → 什么都不复制，列表 JSON 为空，页面是**纯内存模式**
 *     （拖入 .lpk 由浏览器解包）。静态部署时如果本来就没有后端，这正是想要的结果。
 */
function buildArtifactsPlugin(options: { outDir: string | null }): Plugin {
  const { outDir } = options;
  let resolved: ResolvedConfig | null = null;
  return {
    name: 'lpk-build-artifacts',
    apply: 'build',
    configResolved(config) {
      resolved = config;
    },
    generateBundle() {
      /* 没指定目录就没有模型可发布，索引留空（静态模式下列表为空，等用户拖入 .lpk） */
      const index = outDir ? buildIndex(outDir) : buildPackageIndex([]);
      this.emitFile({ type: 'asset', fileName: 'packages.json', source: JSON.stringify(index, null, 2) });
    },
    closeBundle() {
      const log = (line: string): void => resolved?.logger.info(line);
      if (!outDir) {
        log('  lpk: 没有设置 LPK_OUT 环境变量 —— 构建不含任何模型，页面为纯内存模式：拖入 .lpk 由浏览器解包');
        log('  lpk: 想把已解包的资源一起发布：LPK_OUT=<只含要发布的包的目录> pnpm build');
        return;
      }
      const distDir = resolved ? nodeResolve(resolved.root, resolved.build.outDir) : nodeJoin(REPO_ROOT, 'apps', 'web', 'dist');
      const packs = listPackages(outDir);
      if (packs.length === 0) {
        log(`  lpk: 解包产物目录为空（${outDir}）—— 构建结果不含模型，页面为纯内存模式：拖入 .lpk 由浏览器解包`);
        return;
      }
      const target = nodeJoin(distDir, 'models');
      try {
        copyPackages(outDir, target, log);
      } catch (error) {
        log(`  lpk: 复制解包产物失败：${(error as Error).message}`);
        throw error;
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  /* 第三个参数传空串：读**所有**环境变量（不加 VITE_ 前缀的也要），
     这样 LPK_OUT / LPK_WORKSHOP 既能写在 .env 文件里，也能直接从命令行给。
     `.env*` 文件按**执行命令的目录**找（与相对路径的解析基准一致）。 */
  const env = { ...loadEnv(mode, INVOKE_CWD, ''), ...process.env };
  /** 相对路径按"执行命令的目录"解；绝对路径原样使用 */
  const resolveFromCwd = (value: string): string => nodeResolve(INVOKE_CWD, value);
  /** 显式指定时才参与"构建复制"：见 buildArtifactsPlugin 的说明 */
  const explicitOut = env.LPK_OUT ? resolveFromCwd(env.LPK_OUT) : null;
  /** dev 侧仍可用默认目录（只读，不复制）：默认 <执行命令的目录>/out，与 CLI 一致 */
  const devOutDir = explicitOut ?? nodeJoin(INVOKE_CWD, 'out');
  const workshop = env.LPK_WORKSHOP ? resolveFromCwd(env.LPK_WORKSHOP) : null;

  return {
    plugins: [devServerPlugin({ outDir: devOutDir, workshop }), buildArtifactsPlugin({ outDir: explicitOut })],
    server: { port: 5610, strictPort: true },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
