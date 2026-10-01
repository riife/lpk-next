# web/vendor

播放器需要的三套运行时，全部由 `npm run fetch-vendor` 下载（并打本地补丁），仓库里已经放好一份。

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `spine-webgl.js` | [spine-runtimes](https://github.com/EsotericSoftware/spine-runtimes) `3.8` 分支 `spine-ts/build/spine-webgl.js` | Spine 3.8（JSON + 二进制骨架） |
| `spine-webgl-4.0.js` | npm [`@esotericsoftware/spine-webgl@4.0.31`](https://www.npmjs.com/package/@esotericsoftware/spine-webgl) 的 `dist/iife/spine-webgl.js` | Spine 4.0.x 骨架 |
| `live2dcubismcore.min.js` | <https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js> | Live2D Cubism 核心（moc3 解析与求值） |
| `pixi-6.5.10.min.js` | npm [`pixi.js@6.5.10`](https://www.npmjs.com/package/pixi.js) | Cubism 渲染用的 WebGL 引擎 |
| `pixi-live2d-display-0.4.0.cubism4.min.js` | npm [`pixi-live2d-display@0.4.0`](https://www.npmjs.com/package/pixi-live2d-display) `dist/cubism4.min.js` | 把 Cubism 模型接进 PIXI 的封装 |

## 加载方式

- `spine-webgl.js` 用 `<script>` 引入，导出全局 `spine`（WebGL 类在 `spine.webgl` 下）。
- `spine-webgl-4.0.js` **不**直接用 `<script>`：它同样声明全局 `spine`，会覆盖上面那份。
  播放器抓取文本后在函数作用域里执行（`new Function`），只取出导出对象。
  注意 4.x 是**扁平导出**（`SceneRenderer` / `GLTexture` 直接挂在顶层，没有 `webgl` 命名空间）。
- Cubism 那三份在打开 Cubism 模型时按需加载（`pixi` → `Live2DCubismCore` → `pixi-live2d-display`，顺序不能换）。
  它们的全局名互不冲突，可以和 Spine 共存于同一个页面。

## 本地补丁

下载后会自动打一处补丁（`tools/fetch-vendor.mjs`，可重复执行）：
**去掉 3.8 运行时对 `3.8.75` 导出数据的硬拒绝**（两处 `if ("3.8.75" == skeletonData.version) throw ...`）。
LPK 里确实存在 3.8.75 导出的包，数据本身能正常解析
（见 [spine-runtimes#2428](https://github.com/EsotericSoftware/spine-runtimes/issues/2428)）。

其余问题都放在播放器一侧解决，vendor 文件尽量贴近官方版本：

| 问题 | 处理位置 |
| --- | --- |
| 贴图是预乘 alpha | `player.js`：`drawSkeleton(skeleton, true)` |
| 运行时默认开 two-color tint，但骨架没有暗色数据 | `player.js`：`new SceneRenderer(canvas, gl, false)` |
| 网格 UV 越界采到隔壁区域（细黑线） | `player.js`：给 `MeshAttachment.updateUVs` 打补丁，把 UV 夹回区域矩形 |

这样解包产物保持与 LPK 条目逐字节一致（`npm test` 里有校验），换运行时版本时补丁也不会丢。

## 许可

- **Spine Runtimes**（`spine-webgl.js`、`spine-webgl-4.0.js`）版权归 Esoteric Software LLC，
  使用受 [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license) 约束
  （在应用中集成 Spine 运行时需要有效的 Spine 编辑器授权）。
- **Live2D Cubism Core** 版权归 Live2D Inc.，适用
  [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
  与 [Cubism SDK Release License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html)；
  发布包含它的应用前请阅读相应条款。
- **PIXI** 与 **pixi-live2d-display** 均为 MIT 许可。

这里只是把官方发布的文件原样放在本地，方便离线打开播放器。
解包器（`src/`）不依赖它们，`npm run unpack` 永远是零依赖的。
