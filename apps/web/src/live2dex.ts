/**
 * Live2DViewerEX 交互脚本的解析（纯逻辑，不碰 DOM、不碰渲染）。
 *
 * 包里的动作条目用一套小脚本描述"点了之后干什么"：
 *   command   : "start_mtn switch:title;slot_opacities lock BS_1,BS_2 0"
 *   next_mtn  : "qiehuan1"        动作播完接哪一段（等价于一条 start_mtn）
 *   choices   : [{ text, next_mtn, sound }]  菜单
 *   var_floats: 变量条件 / 赋值（见 variables.js）
 *
 * 这里只把文本解析成结构化指令；具体执行（改槽位、播动作、弹菜单）由播放器和界面负责。
 */

/** 解析 "slot_opacities lock BS_1,BS_2 0;start_mtn switch:title" 这类指令串 */
export function parseCommand(command: any) {
  const result: any = { slotOpacities: [], slotUnlocks: [], startMotions: [], other: [] };
  for (const rawClause of String(command ?? '').split(';')) {
    const clause = rawClause.trim();
    if (!clause) continue;
    const parts = clause.split(/\s+/);
    const [head, action] = parts;

    if (head === 'slot_opacities' && (action === 'lock' || action === 'unlock')) {
      const slots = (parts[2] ?? '').split(',').filter(Boolean);
      if (slots.length === 0) continue;
      if (action === 'lock') {
        const value = Number(parts[3] ?? 1);
        result.slotOpacities.push({ slots, value: Number.isFinite(value) ? value : 1 });
      } else {
        result.slotUnlocks.push(slots);
      }
      continue;
    }

    if (head === 'start_mtn' && parts[1]) {
      result.startMotions.push(parts[1]);
      continue;
    }

    result.other.push(clause);
  }
  return result;
}

/** 把 "组" / "组:名字" 拆开 */
export function parseTarget(target: any) {
  const text = String(target ?? '');
  const colon = text.indexOf(':');
  if (colon < 0) return { group: text, name: null };
  return { group: text.slice(0, colon), name: text.slice(colon + 1) };
}

/**
 * 在交互表里找目标（原版的 start_mtn / next_mtn / 点击区域都是这个格式）。
 *
 * 匹配顺序：组内名字 → 组内标签 → text（Live2DViewerEX 的 hit_areas 里
 * `"motion": "选择"` 指向的其实是菜单条目的 text，而不是它的 name）。
 * @param {Array<object>} interactions
 * @param {string} target "组" 或 "组:名字"
 * @param {(list: object[]) => object|null} [pick] 同组多条时怎么挑（默认取第一条）
 */
export function findInteraction(interactions: any, target: any, pick: any = null) {
  const { group, name } = parseTarget(target);
  const all = interactions ?? [];

  // 没有指定组名时，允许按"名字/text"在全部交互里找（点击区域的 motion 有时只写了菜单名）
  const inGroup = all.filter((item: any) => item.group === group);
  if (inGroup.length === 0) {
    if (group) {
      const loose = all.filter((item: any) => item.name === group || item.label === group || item.text === group);
      if (loose.length > 0) return pick ? pick(loose) : loose[0];
    }
    return null;
  }
  if (name === null) return pick ? pick(inGroup) : inGroup[0];
  const candidates = inGroup.filter(
    (item: any) => item.name === name || item.label === name || item.text === name || item.groupLabel === name,
  );
  if (candidates.length === 0) return null;
  return pick ? pick(candidates) : candidates[0];
}

/** 组装一条"要执行的交互"：条件筛选 → 赋值 → 返回动作计划 */
export function planInteraction(interaction: any, store: any) {
  const plan = {
    interaction,
    animation: interaction?.animation ?? null,
    loop: Boolean(interaction?.loop),
    fadeInMs: Number.isFinite(interaction?.fadeInMs) ? interaction.fadeInMs : null,
    sound: interaction?.sound ?? null,
    choices: interaction?.choices ?? null,
    command: parseCommand(interaction?.command),
    assigned: [],
    nextTarget: interaction?.next ?? null,
  };
  if (interaction?.varFloats && store) plan.assigned = store.apply(interaction.varFloats);
  return plan;
}

/** 判断一个交互的变量条件当前是否成立 */
export function interactionAvailable(interaction: any, store: any) {
  if (!interaction?.varFloats || !store) return true;
  return store.matches(interaction.varFloats);
}

/**
 * 挑一个待机动作。
 *
 * 组的名字不一定正好是 "idle"：包里常见 `idle`、`idle#1`、`idlebg#1`。
 * `idle#1` 往往也是角色待机（用变量在 normal / normal2 之间切），`idlebg#1` 是背景层。
 * 只认 "idle" 这种写法的话，遇到 `idle#1` 就会找不到待机 ——
 * 模型从加载起就没有任何动画在播，点什么都像"卡住且回不来"（包 3427025959 就是这样）。
 *
 * @param {Array<object>} interactions
 * @param {import('./variables').VariableStore} store
 * @param {(name: string) => boolean} [hasAnimation] 骨架里是否真的有这段动画
 * @param {string[]} [animationNames] 骨架里的动画名清单（加载后才读得到；二进制骨架尤其需要）
 */
export function pickIdle(interactions: any, store: any, hasAnimation: any, animationNames: any) {
  const candidates = (interactions ?? []).filter(
    (item: any) => /^idle/i.test(item.group) && interactionAvailable(item, store),
  );
  const playable = candidates.filter((item: any) => item.animation && (!hasAnimation || hasAnimation(item.animation)));
  const pool = playable.length > 0 ? playable : candidates.filter((item: any) => item.animation);
  if (pool.length === 0) {
    /* 兜底一：包里**一个 idle* 组都没有**时（实测 3621347487 的 c262_00_skillcut-BG00
       只有一条叫 `animation` 的 Spine 动画），也要挑一条能播的当待机 ——
       否则这个角色从加载起就没有任何动画在播，看着就是"卡住且回不来"。
       优先挑标了循环的，再退回第一条可用的。 */
    const any = (interactions ?? []).filter((item: any) => item.animation && interactionAvailable(item, store));
    if (any.length > 0) {
      const looping = any.filter((item: any) => item.loop);
      return (looping.length > 0 ? looping : any)[0];
    }
    /* 兜底二：连"带动画的互动条目"都没有（实测 3006099166 的 Moranjianxindiaochan01、
       3155134958 的 H048）。这种包通常还是**二进制骨架** —— 动画表在 manifest 里是空的，
       要等播放器加载后才读得到，所以必须由调用方把清单传进来。
       挑法：名字像待机的优先，其次 normal/stand/loop，最后第一条。
       （应用与播放器自检共用这一条规则，两边挑出来的才是同一段。） */
    const names = (animationNames ?? []).filter(Boolean);
    const wanted =
      names.find((name: any) => /idle/i.test(name)) ??
      names.find((name: any) => /normal|stand|loop|default/i.test(name)) ??
      names[0];
    if (!wanted) return null;
    return { group: null, name: wanted, animation: wanted, loop: true, fadeInMs: 0 };
  }
  const plain = pool.filter((item: any) => item.group.toLowerCase() === 'idle');
  const list = plain.length > 0 ? plain : pool;
  return list[Math.floor(Math.random() * list.length)] ?? list[0];
}
