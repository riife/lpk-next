# lpk-next

Live2DViewerEX `.lpk` 的解包器 + 播放器，一个 pnpm monorepo。

* `packages/unpacker` —— 解包器。**两端同码**：同一份代码在 Node 与浏览器里都能跑，
  内部不出现任何 `node:*`（`tsconfig` 里 `types: []`，写了 Node API 直接编译不过）。
  压缩用 `fflate`，摘要用 `@noble/hashes`，读写通过注入的 `UnpackIO`。
* `apps/web` —— 前端（Vite + 全 TypeScript）。**自动识别运行模式**：
  探测到 `/api/health` 就是服务器模式，否则是静态模式。第三方 SDK 原样放在 `public/vendor/`。
* `packages/cli` —— 命令行与本地服务器（`hono`）：`unpack` 解包到磁盘，`serve` 起服务。

## 两种运行模式

| | 服务器模式（`/api` 存活） | 静态模式（没有 `/api`，例如把 `dist/` 丢给静态服务器） |
|---|---|---|
| 包列表 | `GET /api/packages` | 构建期生成的 `packages.json` |
| 拖入 `.lpk` | 上传给服务器解包，**结果落盘** | **在浏览器里解包**，结果只放内存（刷新即失效） |
| 删除 | 列表与磁盘目录一起删 | 只从内存列表移除 |
| 启动方式 | `pnpm serve` | `pnpm dev`（仅前端）或部署 `dist/` |

## 打包下载（`#zip`）

首页右上角的「打包下载」进入这个页面（路由 `#zip`）：

* **输入**：装着 `.lpk` 的目录（拖进去或选择目录），也可以直接选若干 `.lpk` 文件；
  目录里有多个包时会**逐个解包**，`STM_1_0` 包需要的同级 `config.json` 与它指定的预览图
  会一起被认出来；
* **输出**：一个 zip，结构与 CLI 的 `lpk unpack` 产物一致 ——
  `<包名>/manifest.json`、`<包名>/<角色>/…`、以及 `source.config.json`；
* 解包与压缩**都在浏览器里完成**（解包用 `@lpk/unpacker`、压缩用 `fflate`），不上传任何文件，
  所以服务器模式与纯内存的静态模式行为一致；页面上会逐包打印进度与结果。

## 解包产物目录（`LPK_OUT`）

前端、CLI、vite 用**同一个环境变量**指定"解出来的包放在哪"，默认 `<仓库>/out`：

| 场景 | 这个目录怎么用 |
|---|---|
| `pnpm dev`（vite 开发服务器） | **直接读**它：`/api/packages` 扫出列表、`/models/**` 直接吐文件。重新解包后刷新页面即可，不用重启 |
| `pnpm build` | **只有显式设了 `LPK_OUT` 才复制它**进 `dist/models/`；裸跑 `pnpm build` 不复制任何东西 |
| `pnpm serve` / `lpk serve --out <目录>` | 服务器把它当数据源：列表来自它，`/models/**` 从它读，删除会删它里面的目录 |
| `pnpm unpack <lpk> -o <目录>` | 解包写到它 |

要点：

* **构建默认不复制**，因为默认目录可能是几十 GB 的全量语料 —— 一句 `pnpm build`
  就把它整套拷进 `dist/` 既意外又占地方。要发布已解包的资源就写清楚：

  ```bash
  LPK_OUT=<只含要发布的包的目录> pnpm build
  ```

  构建日志会报出包数与体积。dev 侧不受影响（它只读、不复制）。
* **没有模型时页面是纯内存模式**：产物里不含 `models/`、列表为空，
  把 `.lpk` 拖进去由浏览器解包（刷新即失效）。这对"本来就没有后端的静态部署"正是想要的结果；
  目录为空或不存在时构建照常成功。
* 优先级：命令行 flag（`--out`）> `.env*` 文件 > 进程环境变量 > 默认值。
  **相对路径与默认值都按"你在哪个目录敲的命令"解析** ——
  `pnpm build` 会把脚本的 cwd 换成 `apps/web`，所以内部用 `INIT_CWD` 拿回真正的调用目录，
  `LPK_OUT=./models` 在仓库根敲就指 `<仓库>/models`，不会跑到 `apps/web/models` 去。
  两种模式所需的一切都可以写在 `.env.local` 里，例如：

```
LPK_OUT=D:\steam-out
LPK_WORKSHOP=D:\SteamLibrary\steamapps\workshop\content\616720
```

> 两种模式都需要把 `.lpk` 与**同目录的 `config.json` 一起**拖进来（或直接拖整个包目录）：
> `STM_1_0` 包的密钥要用 `config.json` 里的字段推导，浏览器读不到磁盘，
> 服务器模式下包又是上传上来的，都没有"同级目录"可读。缺了它只会提示你补上，
> 不会静默解出一堆认不出的文件。

## 上手

```bash
pnpm install

# 构建前端产物到 apps/web/dist（只做这一件事；类型检查是单独的命令）
pnpm build

# 解包（可以给单个 .lpk，也可以给一个装着 .lpk 的目录）
pnpm unpack <某个.lpk> -o out

# 起服务器：静态托管前端 + /api（--out 指定要服务的产物目录）
pnpm serve                       # 默认 http://127.0.0.1:5599/
node packages/cli/src/cli.ts serve --out <产物目录> --port 5599

# 只开前端（静态模式，拖 .lpk 进页面即可）
pnpm dev
# 想让它读另一个产物目录：LPK_OUT=<目录> pnpm dev

# 类型检查（三个包）与包内测试
pnpm typecheck
pnpm test
```

类型检查是**零容忍**的：`pnpm typecheck` 会因为任何一条类型错误失败，
不存在"忽略若干条已知问题"的开关；`pnpm build` 只管构建前端，不替你做类型检查。

## 环境变量

代码里**没有任何写死的本机路径** —— 需要机器相关信息时一律通过环境变量传入，
没配就明确提示或跳过，而不是回退到某个开发者电脑上的路径。

| 变量 | 用途 | 默认 |
|---|---|---|
| `LPK_OUT` | **解包产物目录**（前端 dev 直接读、构建复制进 `dist/models`、CLI 当数据源） | `<仓库>/out` |
| `LPK_WORKSHOP` | 创意工坊包目录（`<steam>/steamapps/workshop/content/616720`），包内测试与 vite 的取包路由用 | 无（相关测试会跳过并提示） |
| `LPK_SAMPLE_IDS` | 测试抽样用的包 id，逗号分隔 | `3140192145,3572004785,3299783566` |

命令行 flag 优先于环境变量：`lpk unpack -o <目录>`、`lpk serve --out <目录>`。

## 测试

```bash
pnpm --filter @lpk/unpacker test     # MD5 / ZIP / 路径 交叉验证 + 与旧实现逐字节比对
```

每条都用**独立参照**，不是自己跟自己比：

* **MD5**：`@noble/hashes` 的结果与 `node:crypto` 逐例比对（26 例）；
* **ZIP**：`fflate` 解出的内容与另一套实现（手写中央目录解析 + `node:zlib`）逐条比对；
* **路径**：自研的 POSIX 路径处理与 `node:path` 逐例比对（70 例）；
* **逐字节**：解包产物与 `test/fixtures/reference-hashes.json` 比对 ——
  那是**旧实现产物的哈希基线**（355 个包 / 26224 个文件，
  抓取时归一化掉 manifest 里必然不同的 `generatedAt` 与 `tool`）。
  有了它，"新实现与旧实现逐字节相同"这条验收在任何机器上都能跑，不需要旧工程还在旁边。

需要真 `.lpk` 的用例要先设 `LPK_WORKSHOP`；没设会打印怎么配然后跳过，
与平台无关的用例照常运行。

## 目录

```
packages/unpacker/src
  lpk.ts          md5 与密钥推导（@noble/hashes）
  zip.ts          ZIP 容器（fflate）
  posix.ts        平台无关的路径处理（与 node:path 行为一致，有 70 个用例比对）
  io.ts           UnpackIO 接口与 MemoryIO
  detect.ts       按内容识别资源类型
  index-build.ts  列表 JSON 的唯一产出点（Vite 插件与 CLI 共用）
  unpack.ts       主流程
packages/unpacker/test
  env.mjs         测试用的可移植配置（唯一一处；无任何本机绝对路径）
  verify-*.mjs    MD5 / ZIP / 路径 / 逐字节 四条比对
  fixtures/       旧实现产物的哈希基线
apps/web          index.html + src/（app / player / cubism / gallery / sources / net / audio / variables）
apps/web/public/vendor   第三方 SDK（spine / pixi / cubism core / sheerly），原样入库
packages/cli/src  cli.ts（parseArgs + styleText）/ server.ts（hono）/ io-node.ts
```
