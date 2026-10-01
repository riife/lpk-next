/**
 * 全局声明：第三方 SDK（vendor 里的 <script> 全局）与本站自己的全局对象。
 *
 * 为什么需要：`web/vendor/*` 是原样搬进来的第三方构建，它们挂在 window 上
 * （spine / PIXI / Live2DCubismCore / sheerly）。播放器代码直接使用这些全局，
 * 没有类型声明的话 TS 会把它们全判成"不存在的名字"。
 *
 * 这里**只声明用到的部分**，并且刻意用较松的类型（`any` / 索引签名）：
 * 第三方内部结构不是我们要维护的东西，声明太细反而会在升级 vendor 时处处报错。
 * 我们自己写的代码（app/player/cubism/…）仍然照常做类型检查。
 */

/* ---------- Spine 运行时（3.7 / 3.8 挂 spine；4.x 由 player.ts 动态求值取得） ---------- */
declare const spine: any;

/* ---------- PixiJS 与 Live2D Cubism（Cubism 播放器用） ---------- */
declare const PIXI: any;
declare const Live2D: any;
declare const Live2DCubismCore: any;

/* ---------- 界面组件库 sheerly ---------- */
declare const sheerly: any;

/* ---------- 本站全局对象（app.ts 暴露给控制台与自动化用） ---------- */
interface LpkAppGlobal {
  /** 应用状态（控制台与自动化会读它） */
  state: any;
  /** 路由应用（改 hash 后调用） */
  applyRoute: (hash: string) => void;
  /** 其它由 app.ts 挂上去的东西 */
  [key: string]: any;
}

interface Window {
  lpk: LpkAppGlobal;
  spine?: any;
  PIXI?: any;
  Live2D?: any;
  Live2DCubismCore?: any;
  sheerly?: any;
  /** 自检/验证页面用来回传结果 */
  __P2?: unknown;
}
