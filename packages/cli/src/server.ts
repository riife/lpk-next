/**
 * hono 服务器：静态托管前端 + 四个 /api 路由。
 *
 * 路由分工：
 *   * `GET  /api/health`            —— 前端用它判断"是否有后端"（有就是服务器模式）
 *   * `GET  /api/packages`          —— 列表 JSON（与 Vite 插件共用 buildPackageIndex）
 *   * `POST /api/unpack`            —— 上传 .lpk，服务器解包并落盘
 *   * `DELETE /api/packages/:id`    —— 从列表移除**并删磁盘目录**
 * 其余路径都交给前端的静态产物。
 *
 * 只监听本机（默认 127.0.0.1）：前端"探测是否有后端"要足够快，前提就是后端在本机。
 */
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPackageIndex, isPackageId, unpackLpk, type PackageIndexSource } from '@lpk/unpacker';
import { nodeFsIO, removeTree } from './io-node.ts';

export interface ServerOptions {
  /** 解包产物目录（列表与 /models 的数据来源） */
  outDir: string;
  /** 前端静态产物目录；不存在时只提供 /api */
  webRoot?: string | null;
  /** 日志 */
  log?: (line: string) => void;
}

/** 扫描产物目录，读每个包的 manifest —— 只有 Node 侧才能做这件事 */
export function scanPackages(outDir: string): PackageIndexSource[] {
  const sources: PackageIndexSource[] = [];
  if (!existsSync(outDir)) return sources;
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isPackageId(entry.name)) continue;
    const manifestPath = join(outDir, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      sources.push({
        id: entry.name,
        base: `/models/${entry.name}/`,
        manifestUrl: `/models/${entry.name}/manifest.json`,
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
      });
    } catch {
      /* 清单坏了就跳过这个包，不让它毁掉整个列表 */
    }
  }
  return sources;
}

export function createServer(options: ServerOptions) {
  const log = options.log ?? ((): void => {});
  const outDir = resolve(options.outDir);
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true, mode: 'server', out: outDir }));

  app.get('/api/packages', (c) => c.json(buildPackageIndex(scanPackages(outDir))));

  /* 上传解包：接收 .lpk（以及可选的 config.json —— STM_1_0 包解密需要它） */
  app.post('/api/unpack', async (c) => {
    const form = await c.req.formData();
    const lpk = form.get('lpk');
    if (!(lpk instanceof File)) return c.json({ error: '缺少 lpk 文件' }, 400);
    const config = form.get('config');

    const bytes = new Uint8Array(await lpk.arrayBuffer());
    const base = lpk.name.replace(/\.lpk$/i, '');
    let id = /^\d+$/.test(base) ? base : `upload-${Date.now()}`;
    /* 同名包再传一次时就换个后缀，避免覆盖已有结果 */
    if (existsSync(join(outDir, id))) id = `${id}-${Date.now().toString(36)}`;

    const externalConfig =
      config instanceof File
        ? { bytes: new Uint8Array(await config.arrayBuffer()), name: config.name }
        : null;

    try {
      mkdirSync(join(outDir, id), { recursive: true });
      const result = unpackLpk({
        bytes,
        name: lpk.name,
        outDir: id,
        io: nodeFsIO(outDir),
        externalConfig,
        log: (line) => log(`  ${line}`),
      });
      log(`解包完成：${id}（${result.manifest.characters.length} 个角色）`);
      const [entry] = buildPackageIndex(scanPackages(outDir)).packages.filter((p) => p.id === id);
      return c.json({ id, entry: entry ?? null });
    } catch (error) {
      /* 失败就把半成品删掉，免得列表里留下一个打不开的包 */
      removeTree(join(outDir, id));
      const message = error instanceof Error ? error.message : String(error);
      log(`解包失败：${message}`);
      return c.json({ error: message }, 500);
    }
  });

  /* 删除：列表与磁盘一起删 */
  app.delete('/api/packages/:id', (c) => {
    const id = c.req.param('id');
    if (!/^\d+$/.test(id) && !/^upload-[\w-]+$/.test(id)) return c.json({ error: 'id 不合法' }, 400);
    const target = join(outDir, id);
    if (!existsSync(target)) return c.json({ error: '没有这个包' }, 404);
    removeTree(target);
    log(`已删除 ${id}（列表与磁盘目录）`);
    return c.json({ ok: true, id });
  });

  /* 解包产物：/models/<包 id>/<包内路径> */
  app.get('/models/*', (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/models\//, '');
    const target = resolve(join(outDir, rel));
    if (!target.startsWith(outDir) || !existsSync(target)) return c.text('not found', 404);
    return new Response(new Uint8Array(readFileSync(target)));
  });

  /* 前端静态产物；没有产物时给一条明确的提示 */
  if (options.webRoot && existsSync(options.webRoot)) {
    app.use('/*', serveStatic({ root: options.webRoot }));
    app.get('*', (c) => c.html(readFileSync(join(options.webRoot!, 'index.html'), 'utf8')));
  } else {
    app.get('/', (c) => c.text('前端还没构建：先跑 pnpm --filter @lpk/web build'));
  }

  return app;
}
