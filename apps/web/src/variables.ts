/**
 * Live2DViewerEX 的变量系统（var_floats / VarFloats）。
 *
 * 包里的动作条目可以带一组"变量指令"，用来做皮肤/服装切换这类状态机：
 *   type 1（条件）：只有条件成立时这个条目才可用，例如 { name:"pi", type:1, code:"equal 0" }
 *   type 2（动作）：执行这个条目时改变量，例如 { name:"pi", type:2, code:"assign 1" }
 *
 * 同一组里往往有多条同名动作，靠条件区分（例如 pi=0 用 Stand、pi=1 用 Stand_s01），
 * 所以"播某个动作组"必须先按当前变量挑出匹配的那一条。
 *
 * 这个模块只做纯逻辑（不碰 DOM、不碰渲染），两个播放器共用。
 */

/** 变量指令的字段名在 Spine 配置里是 snake_case、在 Cubism 配置里是 CamelCase */
function normalize(entry: any) {
  if (!entry || typeof entry !== 'object') return null;
  const name = entry.name ?? entry.Name;
  const type = entry.type ?? entry.Type;
  const code = entry.code ?? entry.Code;
  if (typeof name !== 'string' || !name) return null;
  if (typeof code !== 'string' || !code) return null;
  return { name, type: Number(type), code: code.trim() };
}

/** 把 "equal 0" / "assign 1" / "init 0" 拆成 { op, value } */
function parseCode(code: any) {
  const match = /^([a-z_]+)\s+(.+)$/i.exec(code);
  if (!match) return null;
  const value = Number(match[2]);
  return { op: match[1].toLowerCase(), value: Number.isFinite(value) ? value : match[2] };
}

const CONDITIONS: Record<string, (a: any, b: any) => boolean> = {
  equal: (a: any, b: any) => a === b,
  not_equal: (a: any, b: any) => a !== b,
  greater: (a: any, b: any) => a > b,
  less: (a: any, b: any) => a < b,
  greater_equal: (a: any, b: any) => a >= b,
  less_equal: (a: any, b: any) => a <= b,
  /* 别名：包里也写 lower / upper（实测 35 个包里有 12 处 `lower`）。
     不做别名的话这些条件会被当成"不认识"直接跳过 —— 等于永远成立，
     换装那种"按参数档位选变体"的逻辑就会挑错条目。 */
  lower: (a: any, b: any) => a < b,
  upper: (a: any, b: any) => a > b,
};

export class VariableStore {
  /* 字段声明：迁移时按 tsc 的 TS2339 报错逐条补出，类型暂为 any（后续按模块收紧） */
  parameterOf: any;
  values: any;

  constructor() {
    this.values = new Map();
    /**
     * 读取模型参数的回调（`@名字` 条件用）。播放器在加载模型后设置它。
     * 放在 store 上是为了让 `matches(list)` 的调用点都不用改。
     */
    this.parameterOf = null;
  }

  reset() {
    this.values.clear();
  }

  get(name: any) {
    return this.values.get(name) ?? 0;
  }

  set(name: any, value: any) {
    this.values.set(name, value);
  }

  /**
   * 该条目当前是否可用：没有条件，或所有条件都成立。
   *
   * 条件里的名字有两种（实测 【碧蓝航线】不挠 的 UI 命令条目）：
   *   `@CD_UI`  —— 带 `@` 前缀，指**模型参数**的当前值
   *   `CD_UI`   —— 不带前缀，指**变量**的值
   * 所以 `{Name:"@CD_UI",Type:1,Code:"equal 0"}` 是"参数还是 0 的时候"，而
   * `{Name:"CD_UI",Type:2,Code:"assign 10"}` 是把变量设成 10。
   * 这也是"同一条命令有两个变体（set_10 / set_0）"的判据：靠参数当前值决定按哪一条。
   *
   * @param {Array<unknown>} list
   * @param {(name: string) => number} [parameterOf] 读取模型参数（没有就按 0 处理）
   */
  matches(list: any) {
    for (const raw of list ?? []) {
      const entry = normalize(raw);
      if (!entry || entry.type !== 1) continue;
      const parsed = parseCode(entry.code);
      if (!parsed) continue;
      const compare = CONDITIONS[parsed.op];
      if (!compare) continue;
      const isParameter = entry.name.startsWith('@');
      const actual = isParameter
        ? Number(this.parameterOf?.(entry.name.slice(1)) ?? 0)
        : this.get(entry.name);
      if (!compare(actual, parsed.value)) return false;
    }
    return true;
  }

  /** 执行条目上的赋值类指令 */
  apply(list: any) {
    const applied = [] as any[];
    for (const raw of list ?? []) {
      const entry = normalize(raw);
      if (!entry || entry.type !== 2) continue;
      const parsed = parseCode(entry.code);
      if (!parsed || typeof parsed.value !== 'number') continue;
      if (parsed.op === 'assign' || parsed.op === 'init' || parsed.op === 'set') {
        this.values.set(entry.name, parsed.value);
        applied.push(`${entry.name}=${parsed.value}`);
      }
    }
    return applied;
  }

  /** 有没有条件指令（用来判断"这一组是否需要按变量挑选"） */
  static hasConditions(list: any) {
    return (list ?? []).some((raw: any) => {
      const entry = normalize(raw);
      return entry && entry.type === 1;
    });
  }
}

/**
 * 从一组候选里挑出当前变量条件下可用的一条。
 * @param {Array<{varFloats?: unknown[]}>} candidates
 * @param {VariableStore} store
 * @param {() => number} [random] 同一条件下有多条时随机挑（原版的同一组多条=随机语音）
 */
export function pickVariant(candidates: any, store: any, random = Math.random) {
  if (!candidates || candidates.length === 0) return null;
  const usable = candidates.filter((item: any) => !item.varFloats || store.matches(item.varFloats));
  const pool = usable.length > 0 ? usable : candidates;
  return pool[Math.floor(random() * pool.length)] ?? pool[0];
}
