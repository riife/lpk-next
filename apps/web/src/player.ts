/**
 * Spine 3.8 播放器封装
 *
 * 依赖全局 spine（web/vendor/spine-webgl.js，来自 EsotericSoftware/spine-runtimes 3.8 分支）。
 * 只做三件事：把解包出来的骨架 + 图集 + 贴图装进运行时、控制动画状态、把画面画到 canvas 上。
 */
/* global spine */

/**
 * 加载一份**非全局**的 spine 运行时（3.7 / 4.0 / 4.1）。
 *
 * 这些构建都会声明全局 `spine`，直接 <script> 引入会互相覆盖，
 * 所以在函数作用域里执行（`new Function`），只把导出的对象取出来用。
 * 3.7 与 3.8 一样把 WebGL 类放在 `spine.webgl` 下，4.x 是扁平导出 —— 两种都接受。
 */
const spineRuntimePromises = new Map();
function loadSpineRuntime(file = '/vendor/spine-webgl-4.0.js') {
  if (!spineRuntimePromises.has(file)) {
    spineRuntimePromises.set(
      file,
      (async () => {
        const response = await fetch(file);
        if (!response.ok) {
          throw new Error(`缺少 web/${file}，请运行 npm run fetch-vendor 下载`);
        }
        const source = await response.text();
        try {
          const factory = new Function(`${source}\n;return spine;`);
          const runtime = factory();
          const webgl = runtime?.webgl ?? runtime;
          if (!runtime || !webgl?.SceneRenderer || !runtime.Skeleton || !runtime.TextureAtlas) {
            throw new Error('导出对象里缺少 SceneRenderer/Skeleton/TextureAtlas');
          }
          return runtime;
        } catch (error: any) {
          throw new Error(`spine 运行时初始化失败（${file}）：${error && error.message ? error.message : error}`);
        }
      })(),
    );
  }
  return spineRuntimePromises.get(file);
}

/** 按骨架声明的版本挑运行时文件（4.1+ 用 4.1 那份） */
/**
 * 按骨架声明的版本挑运行时文件。
 *
 * Spine 只保证**同一 minor** 互读，而 LPK 里 3.7 / 3.8 / 4.0 / 4.1 都出现过：
 *   3.7 → vendor/spine-webgl-3.7.js（3.7 的 JSON 结构 3.8 读得进却画不出东西：实测
 *         3599601909/petmovie5782 能加载、动画也在，但一个可绘制附件都没有）
 *   3.8 → 页面里全局那份（index.html 用 <script> 引入，3.8 也是主用版本）
 *   4.0 / 4.1 → vendor/spine-webgl-4.0.js / -4.1.js
 */
export function spineRuntimeFileFor(version: any) {
  const [major, minor] = String(version ?? '')
    .split('.')
    .map((part: any) => Number.parseInt(part, 10));
  if (Number.isFinite(major) && major >= 4) {
    return Number.isFinite(minor) && minor >= 1 ? '/vendor/spine-webgl-4.1.js' : '/vendor/spine-webgl-4.0.js';
  }
  if (Number.isFinite(major) && major === 3 && Number.isFinite(minor) && minor <= 7) {
    return '/vendor/spine-webgl-3.7.js';
  }
  return null; // 3.8 及未知版本用页面里全局那份
}

/** WebGL 相关类所在的对象：3.8 在 runtime.webgl 下，4.x 是扁平导出 */
function webglOf(runtime: any) {
  return runtime.webgl ?? runtime;
}

/**
 * 让每一页贴图按**自己的** alpha 编码混合，同时**不破坏逐槽位的混合模式**。
 *
 * 为什么需要：Spine 的 drawSkeleton(skeleton, premultiplied) 只设一次"基础"混合函数，全局一个值。
 * 但实测 3299783566/Shenjiguimouguojia01 这类包的**人物页是预乘、背景页是直通**
 * （逐页统计：页1 反例 94.4%、页0/2/4 只有 0.4~0.7%）：
 * 用预乘 → 人物干净、背景成白块；用直通 → 背景正常、人物脸上出灰色残影。全局一个值必然错一半。
 *
 * 关键：**不能**在纹理绑定时直接 gl.blendFunc —— 那样会把渲染器按槽位设置的
 * additive / screen / multiply 覆盖成普通混合，画面就会出现白色光圈与亮带
 * （实测 Shenjiguimouguojia01 的嘴边光圈、发间亮带就是这么来的）。
 *
 * 做法：包装 WebGLBlendModeConverter.getSourceGLBlendMode，把渲染器**当时用的混合模式与预乘标志**
 * 记下来（渲染器先查 src 再查 dest，所以在这一步记录没有歧义 —— 不能靠 GL 枚举对反查：
 * Screen 与"Normal + 预乘"的枚举对完全一样），然后在 PolygonBatcher.draw(texture) 里
 * 只把预乘标志换成这张贴图自己的，按同一个混合模式重算枚举对。
 */
function patchTextureBlend(webgl: any, gl: any) {
  const Batcher = webgl?.PolygonBatcher;
  const Converter = webgl?.WebGLBlendModeConverter;
  if (!Batcher || !Converter || Batcher.prototype.__lpkBlendPatched) return;
  const originalSource = Converter.getSourceGLBlendMode;
  const originalSet = Batcher.prototype.setBlendMode;
  const originalDraw = Batcher.prototype.draw;
  if (typeof originalSource !== 'function' || typeof originalSet !== 'function' || typeof originalDraw !== 'function') return;

  /* 记录渲染器最近一次用的 (混合模式, 预乘标志) */
  Converter.getSourceGLBlendMode = function patchedGetSource(blendMode: any, premultipliedAlpha: any) {
    Converter.__lpkLastBlendMode = blendMode;
    Converter.__lpkLastPremultiplied = premultipliedAlpha;
    return originalSource.apply(this, arguments);
  };

  Batcher.prototype.setBlendMode = function patchedSetBlendMode() {
    this.__lpkBlendMode = Converter.__lpkLastBlendMode;
    this.__lpkBlendPremultiplied = Converter.__lpkLastPremultiplied;
    return originalSet.apply(this, arguments);
  };

  Batcher.prototype.draw = function patchedDraw(texture: any) {
    const wantPremultiplied = texture?.__lpkPremultiplied;
    if (wantPremultiplied !== undefined && this.__lpkBlendMode !== undefined && this.__lpkBlendPremultiplied !== wantPremultiplied) {
      gl.blendFunc(
        Converter.getSourceGLBlendMode(this.__lpkBlendMode, wantPremultiplied),
        Converter.getDestGLBlendMode(this.__lpkBlendMode),
      );
    }
    return originalDraw.apply(this, arguments);
  };

  Batcher.prototype.__lpkBlendPatched = true;
}

/**
 * 给运行时打补丁：把网格顶点的 UV 夹回所属图集区域的"打包矩形"内。
 *
 * 为什么需要：图集里被裁剪过的区域（orig 与 size 不一致、offset 非 0），
 * 它在图集上只占 `size` 那么大的格子，但网格的 UV 是按"未裁剪矩形"（orig）映射的，
 * 那块地方在图集里其实已经被**别的区域**占了（本包 59 个网格会越界，其中 29 个越界处
 * 正好压着邻居）。于是每个片子的边缘都会采到隔壁区域的像素——视觉上就是模型上多出
 * 一圈细黑线，脸部轮廓、身体接缝处最明显。
 *
 * 夹回打包矩形后，边缘只会重复自己的边缘像素（等价于 edge padding），不会串图，
 * 内部的映射完全不变，所以画面内容不变。改的是运行时对象，不动解包出来的资源。
 */
/* 每个区域的"别的区域矩形"缓存（按区域对象缓存；图集在加载时挂在 runtime.__lpkAtlas 上） */
const otherRegionRectsCache = new WeakMap();

/**
 * 收集"本区域之外"的所有矩形，用**UV 包围盒**表示（对旋转区域同样正确）。
 * 单位与 UV 一致（0~1），乘上页宽高就是纹素坐标。
 */
function otherRegionRects(region: any, atlas: any) {
  if (!atlas?.regions) return null;
  const cached = otherRegionRectsCache.get(region);
  if (cached) return cached;
  const rects = [] as any[];
  for (const other of atlas.regions) {
    if (!other || other === region) continue;
    if (other.u === undefined || other.page !== region.page) continue;
    rects.push({
      x1: Math.min(other.u, other.u2),
      x2: Math.max(other.u, other.u2),
      y1: Math.min(other.v, other.v2),
      y2: Math.max(other.v, other.v2),
    });
  }
  otherRegionRectsCache.set(region, rects);
  return rects;
}

/**
 * 网格 UV 越界时**按数据决定**夹不夹。
 *
 * 坑 7 的原始修法是把越界 UV 一律夹回本区域（≈ edge padding），它假设"区域外紧挨着别的区域"。
 * 但有一批包的图集里区域外是**同一张图的留白**（padding），夹回去正好把那段留白抹掉，
 * 边缘反而出现暗色涂抹/黑圈 —— 用户报的"面部黑色圈线"就是它（实测 3140192145/Melody：
 * 关掉夹取后涂抹消失，翻转 alpha 只会整体过曝，说明与 alpha 无关）。
 *
 * 所以判据改成：**只有当这个越界点真的落在别的区域矩形内**（会采到别人的像素）才夹，
 * 落在空白处就保持原样（那是作者留的 padding，采它才是对的）。
 */
function patchMeshUvClamp(runtime: any, enabled = true) {
  const MeshAttachment = runtime.MeshAttachment;
  if (!MeshAttachment || MeshAttachment.__lpkUvClamped) return;
  if (!enabled) return;
  const original = MeshAttachment.prototype.updateUVs;
  if (typeof original !== 'function') return;
  MeshAttachment.prototype.updateUVs = function () {
    original.call(this);
    const region = this.region;
    const uvs = this.uvs;
    if (!region || !uvs || region.u === undefined) return;
    const minU = Math.min(region.u, region.u2);
    const maxU = Math.max(region.u, region.u2);
    const minV = Math.min(region.v, region.v2);
    const maxV = Math.max(region.v, region.v2);
    const others = otherRegionRects(region, runtime.__lpkAtlas);
    const inOther = (u: any, v: any) => {
      if (!others) return true; // 拿不到图集就退回老行为（一律夹）
      for (const rect of others) {
        if (u >= rect.x1 && u <= rect.x2 && v >= rect.y1 && v <= rect.y2) return true;
      }
      return false;
    };
    for (let i = 0; i < uvs.length; i += 2) {
      const u = uvs[i];
      const v = uvs[i + 1];
      const outU = u < minU || u > maxU;
      const outV = v < minV || v > maxV;
      if (!outU && !outV) continue;
      /* 越界点落在留白上：保留原值（那段是 padding，采它是对的） */
      if (!inOther(u, v)) continue;
      if (outU) uvs[i] = u < minU ? minU : maxU;
      if (outV) uvs[i + 1] = v < minV ? minV : maxV;
    }
  };
  MeshAttachment.__lpkUvClamped = true;
}

/**
 * 把同角色**其它贴图套**的图集并入当前图集（只并入活动图集里没有的区域名）。
 *
 * 为什么需要：有的包把人物本体与背景拆到两套图集里（实测 2965558829/Bg_taichici01：
 * 第 1 套 11 个区域全是背景，人物本体两百多个区域在第 2 套）。原版显然两套都用；
 * 我们只加载"活动那套"，于是骨架一引用人物区域就报 `Region not found in atlas`。
 *
 * 为什么安全：只并入**活动图集里找不到**的区域名。真正的换装包（同一批区域名的不同画法）
 * 命中率 100%，一个都不会被并入 —— 也就不会把两套服装混在一起。
 *
 * 只在调用方明确传了 extras 时才做（应用侧只在小包上传，避免 202 个角色的包把贴图全加载一遍）。
 */
async function mergeExtraTextureSets({ runtime, atlas, isSpine4, source, gl, webgl, extras, textures, sizeNotices }: any) {
  if (!Array.isArray(extras) || extras.length === 0 || typeof atlas?.findRegion !== 'function') return 0;
  let merged = 0;
  for (const extra of extras) {
    try {
      if (!extra?.atlas) continue;
      const text = normalizeAtlasText(await source.text(extra.atlas));
      const pagePaths = new Map((extra.pages ?? []).filter((page: any) => page?.path).map((page: any) => [page.name, page.path]));
      const loaded = new Map();
      const loadTexture = async (pageName: any) => {
        if (loaded.has(pageName)) return loaded.get(pageName);
        const path = pagePaths.get(pageName);
        if (!path) return null;
        const image = await source.image(path);
        const texture = new webgl.GLTexture(gl, image);
        textures.push(texture);
        loaded.set(pageName, texture);
        return texture;
      };
      let extraAtlas;
      if (isSpine4) {
        extraAtlas = new runtime.TextureAtlas(text);
        for (const page of extraAtlas.pages) page.texture = await loadTexture(page.name);
      } else {
        /* 3.8 的构造器要求**同步**返回纹理，而且立刻会调 page.texture.getImage() 读尺寸 ——
           取图是异步的，所以先用一份"占位纹理"把图集建好，再把真正的纹理换上去。
           占位纹理必须实现 getImage()，否则构造器直接抛错（注意：合并静默失败，
           症状和没修一样）。尺寸用图集里声明的，和主图集的处理保持一致。 */
        const declared = new Map((parseAtlasPages(text) ?? []).map((page: any) => [page.name, page]));
        extraAtlas = new runtime.TextureAtlas(text, (pageName: any) => {
          const meta = declared.get(pageName);
          const size = {
            width: meta?.width > 0 ? meta.width : 1,
            height: meta?.height > 0 ? meta.height : 1,
          };
          /* 占位纹理要把运行时可能用到的接口都摆出来：渲染时它会调 bind()（少了就报
             "this.lastTexture.bind is not a function"）。真正能取到图的页会在下面被替换掉，
             这个对象只服务于"清单里没有路径、根本加载不出来"的页。 */
          return {
            placeholder: true,
            getImage: () => size,
            bind() {},
            unbind() {},
            update() {},
            setFilters() {},
            setWraps() {},
            dispose() {},
          };
        });
        for (const page of extraAtlas.pages) {
          const texture = await loadTexture(page.name);
          if (texture) {
            page.texture = texture;
            page.rendererObject = texture;
          } else {
            /* 这张页没有可用路径：把它的区域整批排除掉，免得渲染时用到占位纹理。 */
            for (const region of extraAtlas.regions ?? []) {
              if (region?.page === page) region.__lpkNoTexture = true;
            }
          }
        }
      }
      for (const region of extraAtlas.regions ?? []) {
        if (!region?.name || region.__lpkNoTexture) continue;
        if (atlas.findRegion(region.name)) continue;
        atlas.regions.push(region);
        merged += 1;
      }
    } catch (error: any) {
      sizeNotices.push(`并入其它贴图套失败（${extra?.atlas ?? '?'}）：${error.message}`);
    }
  }
  if (merged > 0) sizeNotices.push(`已从其它贴图套并入 ${merged} 个图集区域`);
  return merged;
}

/**
 * 骨架引用了图集里没有的区域时，让 `findRegion` 现造一个**占位区域**，而不是让运行时抛错。
 *
 * 背景：真凶通常是包本身不完整 —— 实测 3473139733 是"皮肤包"，只带皮肤自己的页，
 * 缺的区域来自**基础模型**（原版靠已安装的基础模型补上，我们手上只有这一个包）。
 * Spine 的 AtlasAttachmentLoader 遇到找不到的区域会直接抛错，整个模型打不开；
 * 补一个占位区域能让模型正常打开，缺的那块由 silencePlaceholderAttachments 置为全透明。
 *
 * 占位区域复用第一个区域的**页**与 UV 起点（保证页/纹理有效），宽高记 0 并打标记。
 * 最多造 24 个，防病态包把这里变成死循环。
 */
function ensurePlaceholderLoader(runtime: any, atlas: any, limit = 24) {
  if (!atlas || atlas.__lpkPlaceholder || typeof atlas.findRegion !== 'function') return false;
  const original = atlas.findRegion.bind(atlas);
  let added = 0;
  atlas.findRegion = (name: any) => {
    const found = original(name);
    if (found || added >= limit) return found;
    const template = atlas.regions?.[0];
    if (!template) return found;
    const region = Object.assign(Object.create(Object.getPrototypeOf(template)), template);
    region.name = name;
    region.u = region.u2 = template.u;
    region.v = region.v2 = template.v;
    region.width = 0;
    region.height = 0;
    region.originalWidth = 0;
    region.originalHeight = 0;
    region.offsetX = 0;
    region.offsetY = 0;
    region.rotate = false;
    if ('degrees' in region) region.degrees = 0;
    region.__lpkPlaceholder = true;
    atlas.regions.push(region);
    added += 1;
    return region;
  };
  atlas.__lpkPlaceholder = true;
  return true;
}

/** 把落在占位区域上的附件改成全透明（否则零面积 UV 会被拉成一块纯色矩形） */
function silencePlaceholderAttachments(loader: any) {
  for (const method of ['newRegionAttachment', 'newMeshAttachment']) {
    const original = loader?.[method];
    if (typeof original !== 'function') continue;
    loader[method] = (...args: any[]) => {
      const attachment = original.apply(loader, args);
      const region = attachment?.region;
      if (region?.__lpkPlaceholder) {
        if (attachment.color && typeof attachment.color === 'object') attachment.color.a = 0;
        else attachment.color = { r: 1, g: 1, b: 1, a: 0 };
      }
      return attachment;
    };
  }
}

/**
 * 让 `SkeletonData.findSkin(name)` 在查不到时**现造**一个别名皮肤。
 *
 * 为什么必须在解析**之前**挂上：Spine 解析 linked mesh 时会立刻按名字查皮肤
 * （`Skin not found: default`），解析中途抛错的话，事后再补别名已经晚了。
 * 别名皮肤的附件表取"当时已解析出的所有皮肤的并集"—— linked mesh 的父网格可能在其中任何一个；
 * 这样一个别名就能覆盖多皮肤骨架的各种引用，且不复制任何附件对象。
 *
 * 只在运行时对象上包一层（和 patchMeshUvClamp 同一路数），不动 vendored 文件。
 */
function patchSkinFallback(runtime: any) {
  const proto = runtime?.SkeletonData?.prototype;
  const Skin = runtime?.Skin;
  if (!proto || typeof proto.findSkin !== 'function' || typeof Skin !== 'function') return false;
  /* 附件的**空名字兜底**：有的包的 deform 时间线引用了一个空名字（实测
     3599601909/petmovie5782），Spine 解析动画时按 皮肤+槽位+附件名 查附件，
     查不到就抛 `Deform attachment not found: undefined`，整个模型打不开。
     包本身缺这个附件（数据问题），我们能做的和"缺图集区域"一样：
     给它一个占位附件（零面积区域 + 全透明），让模型能打开、该 deform 不起作用，
     而不是整个模型加载失败。只在名字为空/查不到时兜底，正常附件完全不受影响。 */
  const skinProto = Skin.prototype;
  if (typeof skinProto.getAttachment === 'function' && !skinProto.__lpkAttachmentFallback) {
    const originalGetAttachment = skinProto.getAttachment;
    skinProto.getAttachment = function(slotIndex: any, name: any) {
      const found = originalGetAttachment.call(this, slotIndex, name);
      if (found) return found;
      if (name !== undefined && name !== null && String(name) !== '') return found;
      const Placeholder = runtime.RegionAttachment;
      if (typeof Placeholder !== 'function') return found;
      const stub = new Placeholder(String(name ?? ''));
      /* 零面积 + 全透明：画不出任何像素，deform 也只是对着一块空区域算 */
      stub.width = 0;
      stub.height = 0;
      if (stub.color && typeof stub.color === 'object') stub.color.a = 0;
      return stub;
    };
    skinProto.__lpkAttachmentFallback = true;
  }
  if (proto.__lpkSkinFallback) return true;
  const original = proto.findSkin;
  proto.findSkin = function(name: any) {
    const found = original.call(this, name);
    if (found || !name) return found;
    /* 别名**不注册进 this.skins**：注册了会让后续 findSkin('default') 命中这个并集别名，
       把真正的默认皮肤挤掉 —— 实测那样会引发 `Deform attachment not found: undefined`
       （deform 时间线要按皮肤+槽位+附件名解析，并集里没有对应附件）。
       改为按名字缓存在旁路表里，行为上只补"查不到"这一种情况。 */
    const cache = (this.__lpkSkinAliases ??= {});
    if (cache[name]) return cache[name];
    const skins = Array.isArray(this.skins) ? this.skins : [];
    const alias = new Skin(name);
    const union: Record<string, any> = {};
    for (const skin of skins) {
      const attachments = skin?.attachments;
      if (!attachments) continue;
      if (Array.isArray(attachments)) {
        attachments.forEach((slotAttachments: any, index: any) => {
          if (!slotAttachments) return;
          union[index] = Object.assign(union[index] ?? {}, slotAttachments);
        });
      } else {
        for (const [index, slotAttachments] of Object.entries(attachments)) {
          if (!slotAttachments) continue;
          union[index] = Object.assign(union[index] ?? {}, slotAttachments);
        }
      }
    }
    alias.attachments = union;
    cache[name] = alias;
    return alias;
  };
  proto.__lpkSkinFallback = true;
  return true;
}

/**
 * 骨架里没有名为 `default` 的皮肤时补一个别名（附件表与默认皮肤**共用同一份**）。
 *
 * 为什么需要：Spine 的 linked mesh 记录的是"父网格所在皮肤的名字"，导出工具默认写 `default`。
 * 有包把默认皮肤改了名（实测 3592625918/laimuhao_2 的 3.8.99 骨架），运行时解析到 linked mesh
 * 就抛 `Skin not found: default`，模型直接打不开。补别名而不是改数据（资源不动）。
 *
 * @returns {boolean} 是否真的补了（用于给用户一条可解释的提示）
 */
function ensureDefaultSkinAlias(skeletonData: any, runtime: any) {
  try {
    const skins = skeletonData?.skins;
    if (!Array.isArray(skins) || skins.length === 0) return false;
    if (typeof skeletonData.findSkin !== 'function') return false;
    if (skeletonData.findSkin('default')) return false;
    const source = skeletonData.defaultSkin ?? skins[0];
    const Skin = runtime?.Skin;
    if (!source || typeof Skin !== 'function') return false;
    const alias = new Skin('default');
    /* 3.8 的 Skin.attachments 是"槽位索引 → 附件"的对象，4.x 是数组 —— 两种都直接引用同一份，
       既不复制也不转换，保证与默认皮肤始终一致。 */
    if (source.attachments !== undefined) alias.attachments = source.attachments;
    if (typeof source.getAttachments === 'function' && alias.getAttachments !== source.getAttachments) {
      try {
        alias.setAttachment = source.setAttachment?.bind(source) ?? alias.setAttachment;
      } catch {
        /* 4.x 的访问器不同，能共用 attachments 就够了 */
      }
    }
    skins.push(alias);
    return true;
  } catch {
    return false;
  }
}

/** 把单个网格的 UV 夹回它所属图集区域的打包矩形（见 patchMeshUvClamp 的说明） */
function clampMeshAttachmentUvs(mesh: any) {
  const region = mesh?.region;
  const uvs = mesh?.uvs;
  if (!region || !uvs || region.u === undefined) return false;
  const minU = Math.min(region.u, region.u2);
  const maxU = Math.max(region.u, region.u2);
  const minV = Math.min(region.v, region.v2);
  const maxV = Math.max(region.v, region.v2);
  let changed = false;
  for (let i = 0; i < uvs.length; i += 2) {
    if (uvs[i] < minU) {
      uvs[i] = minU;
      changed = true;
    } else if (uvs[i] > maxU) {
      uvs[i] = maxU;
      changed = true;
    }
    if (uvs[i + 1] < minV) {
      uvs[i + 1] = minV;
      changed = true;
    } else if (uvs[i + 1] > maxV) {
      uvs[i + 1] = maxV;
      changed = true;
    }
  }
  return changed;
}

/**
 * Spine 4.1 去掉了 `MeshAttachment.updateUVs`，钩子挂不上，
 * 所以载入完成后遍历皮肤把每个网格的 UV 夹一遍（结果和 3.8/4.0 上的钩子一致）。
 * 3.8 的 `getAttachments()` 返回的是 {attachment} 包装，4.x 直接返回附件本身，两种都兼容。
 */
function clampAllMeshUvs(skeletonData: any) {
  let count = 0;
  for (const skin of skeletonData?.skins ?? []) {
    let entries = [] as any[];
    try {
      entries = skin.getAttachments?.() ?? [];
    } catch {
      entries = [] as any[];
    }
    for (const entry of entries) {
      const attachment = entry?.attachment ?? entry;
      if (attachment && clampMeshAttachmentUvs(attachment)) count++;
    }
  }
  return count;
}

/**
 * 判断贴图是"预乘 alpha"还是"直通 alpha"。
 *
 * 导出工具可以选择把 RGB 预先乘上 alpha（Unity/Cubism 那条链路常见）。
 * 预乘数据里半透明像素的 RGB 一定 ≤ alpha；直通数据里半透明像素的 RGB 常常大于 alpha。
 * 两者必须配对应的混合方式，配错的症状正好相反：
 *   · 预乘数据按直通混合 → 半透明像素被乘两次 alpha，暗部/边缘出现黑线；
 *   · 直通数据按预乘混合 → 半透明像素按原亮度直接叠加，亮部炸开成白块。
 * LPK 里两种包都有，所以按包实测，别写死。
 */
function detectPremultiplied(images: any, texType: any = null, stats: any[] | null = null) {
  let semi = 0;
  let straight = 0;
  const tile = 384;
  for (const image of images) {
    const width = image.naturalWidth || image.width || 0;
    const height = image.naturalHeight || image.height || 0;
    if (!width || !height) continue;
    /* 采样点从"三个角 + 中间"扩成 3×3 网格：图集大多是**不透明**的，半透明像素只出现在
       各素材的边缘。只取三个角很容易采不到足够样本，统计就退化成噪声。 */
    const spots = [] as any[];
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        spots.push([
          Math.min(Math.max(0, Math.round((width - tile) * (gx / 2))), Math.max(0, width - tile)),
          Math.min(Math.max(0, Math.round((height - tile) * (gy / 2))), Math.max(0, height - tile)),
        ]);
      }
    }
    for (const [sx, sy] of spots) {
      const w = Math.min(tile, width - sx);
      const h = Math.min(tile, height - sy);
      if (w <= 0 || h <= 0) continue;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;
      // 必须 1:1 取样：缩放会让相邻像素插值，凭空造出 RGB > alpha 的像素
      ctx.drawImage(image, sx, sy, w, h, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0 || alpha >= 250) continue;
        semi++;
        if (Math.max(data[i], data[i + 1], data[i + 2]) > alpha + 8) straight++;
      }
      if (semi >= 3000) break;
    }
    if (semi >= 3000) break;
  }
  if (semi < 200) {
    if (stats) stats.push({ semi, straight, verdict: 'premultiplied', reason: '半透明样本太少' });
    return true; // 几乎没有半透明像素，两种混合看不出差别
  }
  const straightRatio = straight / semi;
  /* 统计明确时听统计的：几乎没有反例 → 预乘；反例很多 → 直通。 */
  if (straightRatio >= 0.2) {
    if (stats) stats.push({ semi, straight, verdict: 'straight', reason: `反例占比 ${(straightRatio * 100).toFixed(1)}%` });
    return false;
  }
  if (straightRatio < 0.01) {
    if (stats) stats.push({ semi, straight, verdict: 'premultiplied', reason: `反例占比 ${(straightRatio * 100).toFixed(2)}%` });
    return true;
  }
  /* 统计落在灰色地带（1%~20%）时用**包自己声明的 tex_type** 兜底：
     实测 3572004785/Fazheng02 的贴图是预乘编码，但按统计只是"略超 1%"被判成直通，
     画面上就是脸和胸口的一层灰色残影（预乘数据当直通渲染会把半透明处压暗）。
     包里 options.tex_type = 0，按它取预乘后画面干净。没有这个字段就仍旧按统计来。 */
  if (texType === 0) {
    if (stats) stats.push({ semi, straight, verdict: 'premultiplied', reason: `灰色地带 ${(straightRatio * 100).toFixed(1)}%，听 tex_type=0` });
    return true;
  }
  if (texType === 1) {
    if (stats) stats.push({ semi, straight, verdict: 'straight', reason: `灰色地带 ${(straightRatio * 100).toFixed(1)}%，听 tex_type=1` });
    return false;
  }
  if (stats) stats.push({ semi, straight, verdict: 'straight', reason: `灰色地带 ${(straightRatio * 100).toFixed(1)}%，无 tex_type` });
  return straightRatio < 0.01;
}

export class SpinePlayer {
  /* 字段声明：迁移时按 tsc 的 TS2339 报错逐条补出，类型暂为 any（后续按模块收紧） */
  alphaMode: any;
  gl: any;
  sizeNotices: any;
  textures: any;

  /* 字段声明：迁移时从构造函数里的 this.x 赋值推导，类型暂为 any（后续按模块收紧） */
  alphaStats: any;
  animationState: any;
  backgroundColor: any;
  bounds: any;
  canvas: any;
  clampMeshUvs: any;
  current: any;
  debugRenderer: any;
  hitUnit: any;
  loadResult: any;
  lockedSlots: any;
  modelOffset: any;
  pagePremultiplied: any;
  premultipliedAlpha: any;
  previousAnimation: any;
  renderer: any;
  runtime: any;
  showDebug: any;
  skeleton: any;
  skeletonBytes: any;
  skeletonData: any;
  uvClampCount: any;
  view: any;

  constructor(canvas: any) {
    if (typeof spine === 'undefined') {
      throw new Error('未找到 spine 运行时，请先执行 npm run fetch-vendor 下载 web/vendor/spine-webgl.js');
    }
    this.canvas = canvas;
    const gl =
      canvas.getContext('webgl', { alpha: false, antialias: true, premultipliedAlpha: false }) ||
      canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('当前浏览器不支持 WebGL');

    this.gl = gl;
    // 渲染器在 load() 里按骨架版本创建（3.8 与 4.x 的对象不能混用）
    this.runtime = null;
    this.renderer = null;
    this.debugRenderer = null;

    this.skeleton = null;
    this.skeletonData = null;
    this.animationState = null;
    this.textures = [] as any[];
    this.bounds = { x: 0, y: 0, width: 100, height: 100 };
    this.view = { zoom: 1, panX: 0, panY: 0 };
    this.backgroundColor = [0.055, 0.06, 0.08, 1];
    this.showDebug = false;
    /**
     * 贴图是否按预乘 alpha 渲染（默认是）。
     * LPK 里的贴图在 Unity 侧是按预乘 alpha 加载的；如果这里按普通 alpha 混合，
     * 半透明像素会被乘两次 alpha，每个贴图片的边界都会出现一圈黑线（脸部轮廓最明显）。
     * 可以在 load 的 options 里覆盖，用于对比排查。
     */
    this.premultipliedAlpha = true;
    /** 上一次播过的动作（"互动结束后回到互动前的动画"用） */
    this.previousAnimation = null;
    /** Live2DViewerEX 的 slot_opacities lock：换装就是锁住衣服槽位的透明度 */
    this.lockedSlots = new Map();
    this.current = null;
    this.hitUnit = 100;
    /** 加载过程中发现的"图集声明尺寸与图片实际尺寸不一致"等提示 */
    this.sizeNotices = [] as any[];
  }

  /** 渲染器必须和骨架来自同一份运行时，切换版本时重建 */
  ensureRenderer(runtime: any) {
    if (this.renderer && this.runtime === runtime) return;
    if (this.renderer) {
      try {
        this.renderer.dispose();
      } catch {
        /* 忽略 */
      }
    }
    this.runtime = runtime;
    /* UV 夹取**默认关闭**：它假设"区域外紧挨着别的区域"，但实测（3299783566、3659797861 等 6 个包）
       图集里有覆盖整页的大区域，任何越界点都会被判成"落在别的区域里" → 全部夹回去 →
       画面直接崩坏（整块空白/黑）。而这些区域的越界 UV 其实指向打包工具留的边距，
       采那里才是对的。保留成显式开关：只有确实需要"防描边"的包才打开。
       详细结论见 README 坑 7 与坑 10。 */
    /* UV 夹取**默认关闭**：实测（放大 3.8 倍逐帧对照）开启时头发上会出现一道灰色涂抹横过脸颊 ——
       这就是用户报的"面部黑圈/残影"。原因是这些包的区域外紧挨着的是**同一张图的延续/留白**，
       把越界 UV 拉回区域边界等于把一个边缘像素拉满整个网格 → 灰道。
       保留成显式开关：只有确认需要"防描边"的包才打开。详见 README 坑 7 / 坑 11 附近的记录。 */
    patchMeshUvClamp(runtime, this.clampMeshUvs === true);
    const webgl = webglOf(runtime);
    // 第三个参数是 twoColorTint，官方默认 true。
    // 但 two-color tint 要求骨架导出时勾选过该选项（每个顶点带"暗色"）；
    // 没勾过的骨架里 slot.darkColor 为空，运行时会退化成纯黑，
    // 于是**所有半透明像素都会被往黑色混合**：脸部轮廓、网格接缝处会出现一圈黑线。
    // LPK 里的包都是普通导出，所以这里显式关掉。
    this.renderer = new webgl.SceneRenderer(this.canvas, this.gl, false);
    this.debugRenderer = new webgl.SkeletonDebugRenderer(this.gl);
    this.debugRenderer.drawBones = true;
    this.debugRenderer.drawRegionAttachments = false;
    this.debugRenderer.premultipliedAlpha = false;
  }

  /* ---------------------------------------------------------------- *
   * 加载
   * ---------------------------------------------------------------- */

  /**
   * @param {object} character manifest 里的角色条目
   * @param {{text:(p:string)=>Promise<string>, image:(p:string)=>Promise<HTMLImageElement>}} source 资源来源
   * @param {{idle?:string|null}} [options]
   */
  async load(character: any, source: any, options: any = {}) {
    this.dispose(false);
    this.sizeNotices = [] as any[];
    if (options.premultipliedAlpha !== undefined) this.premultipliedAlpha = Boolean(options.premultipliedAlpha);
    if (options.clampMeshUvs !== undefined) this.clampMeshUvs = Boolean(options.clampMeshUvs);

    const isBinary = character.skeletonFormat === 'binary' || /\.skel$/i.test(character.skeleton || '');
    let declaredVersion = 'unknown';
    let skeletonDoc = null;

    if (isBinary) {
      // 二进制骨架：直接交给 SkeletonBinary 解析，版本号从头部读出来仅用于显示
      this.skeletonBytes = await source.binary(character.skeleton);
      declaredVersion = readSpineBinaryHeader(this.skeletonBytes)?.version ?? 'unknown';
    } else {
      const skeletonText = await source.text(character.skeleton);
      skeletonDoc = JSON.parse(skeletonText);
      declaredVersion = skeletonDoc?.skeleton?.spine ?? 'unknown';
      // 说明：官方 3.8 运行时原本会拒绝 3.8.75 导出的数据，
      // public/vendor 里的那份已经本地打过补丁，
      // 所以这里不需要再改写骨架数据。
    }

    /* 运行时按骨架版本选择：3.7 用单独一份（3.8 的解析器读 3.7 的 JSON 会画不出东西）、
       3.8 用随页面加载的全局那份、4.x 用按需加载的 4.0 / 4.1。 */
    const runtimeFile = spineRuntimeFileFor(declaredVersion);
    const runtime = runtimeFile ? await loadSpineRuntime(runtimeFile) : spine;
    /* 4.x 与 3.x 的差异只在这几处：图集构造（4.x 只吃文本、贴图要自己挂）与 UV 夹取钩子。
       3.7 / 3.8 走同一支（两者的 TextureAtlas 都是"构造时回调取图"的形态）。 */
    const isSpine4 = Number.parseInt(String(declaredVersion).split('.')[0], 10) >= 4;
    this.ensureRenderer(runtime);

    /* 贴图套：一个图集一套，默认第一套；Live2DViewerEX 用它切换服装/和谐版 */
    const textureSets = Array.isArray(character.textureSets) ? character.textureSets : [];
    const setIndex = Math.min(Math.max(Number(options.textureSet) || 0, 0), Math.max(textureSets.length - 1, 0));
    const activeSet = textureSets[setIndex] ?? null;

    /* 图集文本要做两处**最小干预**的规整（磁盘上的解包产物不动 —— 那是资源，不该改）。
       证据来自骨架二进制：里面的名字是"长度前缀 + 字节"，实测同时存在
         \x0e hero_bg_list2   （14 字节，无空格）
         \x0f hero_bg_list2␠  （15 字节，带尾随空格）
       而 3473216664/heroframe.atlas 写的是**带空格**那一版，附件引用的却是不带的，
       于是 `Region not found in atlas: hero_bg_list2`；同一个文件第一行还是空行，
       会被解析成一个空名字的页，把后面的 `heroframe.png` 挤成区域。
       所以：① 去掉行尾空白；② 去掉开头的空行（**中间的**空行要留着，那是分页标记）。
       **绝不改缩进** —— 图集靠缩进区分"名字"与"key: value"，
       我试过给顶格的区域名补缩进，结果报 `Invalid line:   herocard/…`，更糟。 */
    const rawAtlasText = await source.text(activeSet?.atlas ?? character.atlas);
    const atlasText = normalizeAtlasText(rawAtlasText);
    const atlasPages = parseAtlasPages(atlasText);
    const pageNames = atlasPages.map((page: any) => page.name);
    const pagePaths = [] as any[];
    for (let i = 0; i < pageNames.length; i++) {
      const name = pageNames[i];
      const planned = activeSet?.pages?.find((page: any) => page.name === name)?.path;
      const candidate = planned || (character.textures || []).find((p: any) => basename(p) === name) || character.textures?.[i];
      if (!candidate) throw new Error(`图集引用的贴图在清单中缺失：${name}`);
      pagePaths.push(candidate);
    }

    const textureByPage = new Map();
    const webgl = webglOf(runtime);
    patchTextureBlend(webgl, this.gl);
    const pageImages = [] as any[];
    for (let i = 0; i < pageNames.length; i++) {
      const image = await source.image(pagePaths[i]);
      pageImages.push(image);
      const texture = new webgl.GLTexture(this.gl, image);

      // 图集声明的页尺寸与图片实际尺寸不一致时（打包工具常把图片补到 2 的幂），
      // 必须让运行时按"声明尺寸"算 UV：顶点 UV 是按声明尺寸烘焙的，用图片实际尺寸会整片错位。
      // 3.8 的运行时会拿 getImage() 覆盖 page.width/height，所以这里让它报告声明尺寸。
      const declared = atlasPages[i];
      if (
        declared &&
        declared.width > 0 &&
        declared.height > 0 &&
        (image.naturalWidth !== declared.width || image.naturalHeight !== declared.height)
      ) {
        const size = { width: declared.width, height: declared.height };
        texture.getImage = () => size;
        this.sizeNotices.push(
          `页 ${declared.name} 图集声明 ${declared.width}x${declared.height}，图片实际 ${image.naturalWidth}x${image.naturalHeight}，已按声明尺寸计算 UV`,
        );
      }

      textureByPage.set(pageNames[i], texture);
      this.textures.push(texture);
    }

    // 贴图的 alpha 编码按包实测（见 detectPremultiplied 的说明），配错会分别表现为黑边或白块
    if (options.premultipliedAlpha === undefined) {
      /* **逐页**判定：实测 3299783566/Shenjiguimouguojia01 的人物页是预乘、背景页不是，
         全局一个开关必然有一半是错的（人物干净时背景成白块，反之人物出灰残影）。
         统计 + 包里的 tex_type 一起用，见 detectPremultiplied。 */
      this.pagePremultiplied = [] as any[];
      this.alphaStats = [] as any[];
      for (const image of pageImages) {
        const stats = [] as any[];
        this.pagePremultiplied.push(detectPremultiplied([image], character?.texType ?? null, stats));
        this.alphaStats.push(stats[0] ?? null);
      }
      this.premultipliedAlpha = this.pagePremultiplied.filter(Boolean).length >= this.pagePremultiplied.length / 2;
      this.alphaMode = this.premultipliedAlpha ? '预乘 alpha' : '直通 alpha';
      this.textures.forEach((texture: any, index: any) => {
        texture.__lpkPremultiplied = this.pagePremultiplied[index] !== false;
      });
      if (new Set(this.pagePremultiplied).size > 1) {
        this.sizeNotices.push(
          `贴图页的 alpha 编码不一致：${this.pagePremultiplied.map((flag: any, i: any) => `${pageNames[i]}=${flag ? '预乘' : '直通'}`).join('、')}，已按页分别混合`,
        );
      }
      if (character?.texType === 0) {
        this.sizeNotices.push(`包声明 tex_type=0（预乘 alpha），与像素统计不一致时以包为准`);
      }
    } else {
      this.alphaMode = this.premultipliedAlpha ? '预乘 alpha（指定）' : '直通 alpha（指定）';
      this.sizeNotices.push(`贴图 alpha 混合方式被显式指定为 ${this.alphaMode}`);
    }

    /* 4.x 的 TextureAtlas 只吃文本，贴图要自己挂到 page 上；3.8 则在构造时回调取图 */
    let atlas;
    if (isSpine4) {
      atlas = new runtime.TextureAtlas(atlasText);
      for (const page of atlas.pages) {
        const texture = textureByPage.get(page.name);
        if (!texture) throw new Error(`图集中引用的贴图未加载：${page.name}`);
        page.texture = texture;
      }
    } else {
      atlas = new runtime.TextureAtlas(atlasText, (pageName: any) => {
        const texture = textureByPage.get(pageName);
        if (!texture) throw new Error(`图集中引用的贴图未加载：${pageName}`);
        return texture;
      });
    }

    // 排查用：强制点采样（不插值就不会采到区域外的像素）
    if (options.textureFilter === 'nearest') {
      for (const texture of this.textures) texture.setFilters(this.gl.NEAREST, this.gl.NEAREST);
    }

    /* 把图集挂到运行时对象上：网格 UV 越界时"该不该夹"要看**别的区域在哪**
       （见 patchMeshUvClamp —— 落在别的区域里就夹，落在留白上就保持原样）。
       必须在这里挂：patchMeshUvClamp 是在 ensureApp 里装的钩子，那时图集还没建出来。 */
    runtime.__lpkAtlas = atlas;

    /* 骨架引用了图集里没有的区域时，Spine 会**直接抛错**，整个模型打不开：
       `Region not found in atlas: hero_bg_list2`。
       真凶通常是包本身不完整 —— 实测 3473139733 是"皮肤包"，只带皮肤自己的页，
       区域来自**基础模型**（原版靠已安装的基础模型补上，我们只有这一个包）。
       做法：从报错信息里取出缺失的区域名，给图集补一个**零面积**的占位区域再重试。
       零面积 = 该附件画不出任何像素（等于"这块不显示"），比整个模型打不开好得多，
       而且不会误画成别的图案（复用第一个区域的页与 UV 起点，宽高为 0）。
       最多补 24 个，防病态包把这里变成死循环。 */
    ensurePlaceholderLoader(runtime, atlas);

    /* 同角色的**其它贴图套**里可能有活动图集缺少的区域。
       实测 2965558829/Bg_taichici01：第 1 套只有背景的 11 个区域，人物本体（含 TSC_WP_02 等
       两百多个区域）全在第 2 套里，只加载活动那套就会 `Region not found in atlas`
       （占位区域也救不了 —— 缺两百多个，占位上限 24 个，第 25 个照样抛错）。
       只并入"活动图集里没有的区域"，所以对真正的换装包（两套是同一批区域名的不同画法）
       不会有任何副作用 —— 那套的区域名全都能在活动图集里找到，一个都不会被并入。
       代价是每套多一张贴图，只有该角色自己的套数，不会牵涉同包其它角色。 */
    await mergeExtraTextureSets({
      runtime,
      atlas,
      isSpine4,
      source,
      gl: this.gl,
      webgl,
      extras: options.extraTextureSets ?? (character.textureSets ?? []).filter((_: any, index: any) => index !== setIndex),
      textures: this.textures,
      sizeNotices: this.sizeNotices,
    });

    const atlasLoader = new runtime.AtlasAttachmentLoader(atlas);
    /* 占位区域对应的附件要**完全透明**：只是把 UV 缩成零面积的话，顶点还在，
       运行时会用那一个像素拉出一整块纯色矩形 —— 比缺一块还难看。 */
    silencePlaceholderAttachments(atlasLoader);
    /* 皮肤名兜底（解析期）：linked mesh 在**解析骨架的过程中**就会按名字查它所属的皮肤
       （Spine 的报错 `Skin not found: default` 就是这么来的），等解析完再补别名已经来不及
       —— 实测 3599601909/petmovie5782 就卡在这一步，而 3592625918 那种"解析后才需要"的
       由下面的 ensureDefaultSkinAlias 处理。这里包一层 findSkin：查不到就现造一个别名，
       附件表取当时已解析出的所有皮肤的**并集**（linked mesh 的父网格可能在其中任何一个里）。 */
    patchSkinFallback(runtime);
    if (isBinary) {
      const skeletonBinary = new runtime.SkeletonBinary(atlasLoader);
      this.skeletonData = skeletonBinary.readSkeletonData(this.skeletonBytes);
    } else {
      const skeletonJson = new runtime.SkeletonJson(atlasLoader);
      this.skeletonData = skeletonJson.readSkeletonData(skeletonDoc);
    }
    this.skeletonBytes = null;
    /* 皮肤名兜底：Spine 的 linked mesh 会按**名字**引用它所属的皮肤，而导出工具通常写成
       `default`。有包把默认皮肤改了名（实测 3592625918/laimuhao_2），于是加载时报
       `Skin not found: default` —— 模型直接打不开。这里在建立 Skeleton 之前补一个
       名为 default 的别名皮肤，附件表**共用同一份**（不复制，避免内存翻倍与不同步）。 */
    const skinAlias = ensureDefaultSkinAlias(this.skeletonData, runtime);
    if (skinAlias) this.sizeNotices.push('骨架里没有名为 default 的皮肤，已补一个别名（linked mesh 会按名字引用它）');
    // 4.1 没有 updateUVs 钩子，这里补一遍（其它版本钩子已经处理过，这里是幂等的）
    if (this.clampMeshUvs !== false && !runtime.MeshAttachment?.prototype?.updateUVs) {
      this.uvClampCount = clampAllMeshUvs(this.skeletonData);
    }
    this.skeleton = new runtime.Skeleton(this.skeletonData);
    this.skeleton.setToSetupPose();
    this.skeleton.updateWorldTransform();

    const animationStateData = new runtime.AnimationStateData(this.skeletonData);
    animationStateData.defaultMix = 0.2;
    this.animationState = new runtime.AnimationState(animationStateData);

    // 取景范围：优先用清单里的画布尺寸 → 骨架数据自带的尺寸 → setup pose 包围盒
    const manifestBounds = character.bounds || {};
    const dataBounds = {
      x: Number(this.skeletonData.x) || 0,
      y: Number(this.skeletonData.y) || 0,
      width: Number(this.skeletonData.width) || 0,
      height: Number(this.skeletonData.height) || 0,
    };
    const chosen =
      Number(manifestBounds.width) > 0 && Number(manifestBounds.height) > 0
        ? {
            x: Number(manifestBounds.x) || 0,
            y: Number(manifestBounds.y) || 0,
            width: Number(manifestBounds.width),
            height: Number(manifestBounds.height),
          }
        : dataBounds.width > 0 && dataBounds.height > 0
          ? dataBounds
          : null;
    this.bounds = chosen ?? this.measureBounds();
    this.hitUnit = Math.max(this.bounds.width, this.bounds.height) / 16;
    /* 包里指定的模型摆放位置（live2dex.model.json 的 options.position_x/position_y）。
       以前这两个字段解包时就丢了、播放器也从不使用，于是带偏移的包会被画偏：
       例如 3631002471/kansasi_2 的 position_y = -17.9，表现出来就是"人物缺了一块"，
       而且可触发区域红框是按骨骼世界坐标算的，也会一起对不上原版。
       这里只做**相机平移**：模型和它的红框一起移动，两者的相对关系不受影响。
       注意不要拿去改 this.bounds —— 那个值还参与 hitUnit 的计算。 */
    this.modelOffset = {
      x: Number(character.positionX) || 0,
      y: Number(character.positionY) || 0,
    };
    this.view = { zoom: 1, panX: 0, panY: 0 };
    this.current = null;

    // 骨架里真实的动画清单（二进制骨架在解包阶段读不出来，只能这里补全）
    const animations = (this.skeletonData.animations || []).map((animation: any) => animation.name);
    const result = {
      pageNames,
      pagePaths,
      spineVersion: declaredVersion,
      animations,
      textureSet: setIndex,
      textureSetCount: textureSets.length,
      alphaMode: this.alphaMode,
      sizeNotices: this.sizeNotices,
    };
    this.loadResult = result;
    return result;
  }

  /**
   * 应用 Live2DViewerEX 的 slot_opacities 指令（换装的核心）。
   * 解析在 live2dex.js 里做，这里只负责落到骨架上。
   */
  applySlotOpacities(pending: any) {
    for (const { slots, value } of pending?.slotOpacities ?? []) {
      for (const name of slots) this.lockedSlots.set(name, value);
    }
    for (const slots of pending?.slotUnlocks ?? []) {
      for (const name of slots) this.lockedSlots.delete(name);
    }
    this.applySlotLocks();
  }

  /** 把锁定的槽位透明度写回骨架（动画每帧都会改它，所以要在 apply 之后再写一次） */
  applySlotLocks() {
    if (this.lockedSlots.size === 0 || !this.skeleton) return;
    for (const [name, value] of this.lockedSlots) {
      const slot = this.skeleton.findSlot(name);
      if (!slot) continue;
      slot.color.a = value;
    }
  }

  /** 动画是否存在于骨架中 */
  hasAnimation(name: any) {
    return Boolean(this.skeletonData && name && this.skeletonData.findAnimation(name));
  }

  /** 骨架里没有声明画布大小时，用 setup pose 的实际包围盒兜底 */
  measureBounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const bone of this.skeleton.bones) {
      minX = Math.min(minX, bone.worldX);
      minY = Math.min(minY, bone.worldY);
      maxX = Math.max(maxX, bone.worldX);
      maxY = Math.max(maxY, bone.worldY);
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 100, height: 100 };
    const pad = Math.max(maxX - minX, maxY - minY) * 0.25 || 50;
    return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
  }

  /* ---------------------------------------------------------------- *
   * 播放控制
   * ---------------------------------------------------------------- */

  /** @returns {boolean} 动画是否存在 */
  /**
   * 播一段动画。
   *
   * 播放器只负责"播"：一次性动作结束后要做什么（回待机、停下、回到上一段）
   * 由界面决定，通过 options.onComplete 回调通知——因为"待机是哪一段"取决于包里的变量
   * （例如 pi=0 用 Stand、pi=1 用 Stand_s01），那是界面层才知道的事。
   */
  play(name: any, options: any = {}) {
    if (!this.animationState || !this.skeletonData || !name) return false;
    const animation = this.skeletonData.findAnimation(name);
    if (!animation) return false;
    const loop = options.loop ?? false;
    const track = Number.isInteger(options.track) ? options.track : 0;
    const state = this.animationState;

    const entry = state.setAnimation(track, name, loop);
    // 交叉淡化时长：spine 默认用骨架里的 transition/mix 设置，这里可以按需覆盖
    if (entry && Number.isFinite(options.mix)) entry.mixDuration = Math.max(0, options.mix);
    // 背景层（原版的 idlebg 这类）走第 1 条轨道，不参与"当前动作"的状态
    if (track === 1) return true;

    this.current = { name, loop, duration: animation.duration };
    if (!loop && entry) {
      // 用 complete 回调而不是 addAnimation 的 delay：
      // addAnimation 的 delay 是按"当前动画开始后多少秒"计时的（spine-ts 3.8 里
      // nextTime = trackLast - next.delay，trackLast 从 0 开始涨），
      // 写成 addAnimation(0, idle, true, 0.35) 会在 0.35 秒处就把动画掐掉，看起来就是"点一下立刻闪回"。
      entry.listener = {
        complete: () => options.onComplete?.(),
      };
    }
    return true;
  }

  /**
   * 进入待机：先把待机动作接上，再立刻算一次姿势。
   * 这样加载后的第一帧就是待机姿势，而不会先画一帧 setup pose（看起来像"闪一下"）。
   */
  enterIdle(animationName: any) {
    if (animationName) this.play(animationName, { loop: true });
    if (this.animationState && this.skeleton) {
      this.animationState.update(0);
      this.animationState.apply(this.skeleton);
      this.applySlotLocks();
      this.skeleton.updateWorldTransform();
    }
    return Boolean(animationName);
  }

  stop() {
    if (!this.animationState) return;
    this.animationState.clearTracks();
    this.skeleton.setToSetupPose();
    this.applySlotLocks();
    this.current = null;
  }

  get isPlaying() {
    return Boolean(this.current);
  }

  update(deltaSeconds: any) {
    if (!this.skeleton || !this.animationState) return;
    this.animationState.update(deltaSeconds);
    this.animationState.apply(this.skeleton);
    // 锁定的槽位透明度要在动画之后写回（换装状态不能被动画冲掉）
    this.applySlotLocks();
    this.skeleton.updateWorldTransform();
  }

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */

  resizeViewport() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 量父容器而不是 canvas：隐藏期间（首页/抽屉）容器是 0 尺寸，别把位图压成 1×1
    const host = this.canvas.parentElement ?? this.canvas;
    const cssWidth = Math.round(host.clientWidth);
    const cssHeight = Math.round(host.clientHeight);
    if (cssWidth < 2 || cssHeight < 2) return;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    // 改动画布尺寸后必须同步 GL 视口，否则画面只会画在左下角的一小块里
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  updateCamera() {
    if (!this.renderer) return;
    const camera = this.renderer.camera;
    const bounds = this.bounds;
    const width = Math.max(bounds.width, 1);
    const height = Math.max(bounds.height, 1);
    const aspect = this.canvas.width / this.canvas.height;
    let viewWidth = width * 1.08;
    let viewHeight = height * 1.08;
    if (viewWidth / viewHeight > aspect) viewHeight = viewWidth / aspect;
    else viewWidth = viewHeight * aspect;

    camera.viewportWidth = viewWidth / this.view.zoom;
    camera.viewportHeight = viewHeight / this.view.zoom;
    /* 相机往"模型应处的反方向"平移，模型看起来就落在包里指定的位置上。
       offset 未设置时是 {0,0}，行为与之前完全一致。 */
    const offset = this.modelOffset ?? { x: 0, y: 0 };
    camera.position.x = bounds.x + width / 2 + this.view.panX - offset.x;
    camera.position.y = bounds.y + height / 2 + this.view.panY - offset.y;
    camera.update();
  }

  render() {
    if (!this.renderer) return; // 还没有加载任何模型
    const gl = this.gl;
    this.resizeViewport();
    this.updateCamera();
    gl.clearColor(this.backgroundColor[0], this.backgroundColor[1], this.backgroundColor[2], this.backgroundColor[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.skeleton) return;
    this.renderer.begin();
    this.renderer.drawSkeleton(this.skeleton, this.premultipliedAlpha);
    if (this.showDebug) this.renderer.drawSkeletonDebug(this.skeleton, this.premultipliedAlpha);
    this.renderer.end();
  }

  /* ---------------------------------------------------------------- *
   * 坐标换算 / 点击检测
   * ---------------------------------------------------------------- */

  /**
   * 世界 → 裁剪空间的矩阵（4x4，列主序）。
   *
   * 两个坑：
   *   1. spine 的 Matrix4 把数据放在 `.values`（Float32Array）里，直接给矩阵对象取下标
   *      会拿到 undefined → NaN，画面会整块消失；
   *   2. 必须用 `projectionView` 而不是 `projection`：`OrthoCamera.update()` 把相机位置
   *      放进了 view 矩阵，Shader 用的 MVP 也是 `camera.projectionView.values`。
   *      只用 projection 会漏掉相机位移，坐标换算与画面不一致。
   */
  projectionValues() {
    const camera = this.renderer?.camera;
    if (!camera) return null;
    return camera.projectionView?.values ?? camera.projection?.values ?? camera.projection;
  }

  /** 世界坐标 → canvas CSS 像素坐标（缩放/平移都自动生效） */
  worldToCanvas(worldX: any, worldY: any) {
    this.updateCamera();
    const p = this.projectionValues();
    if (!p) return null;
    const ndcX = p[0] * worldX + p[4] * worldY + p[12];
    const ndcY = p[1] * worldX + p[5] * worldY + p[13];
    return {
      x: (ndcX * 0.5 + 0.5) * this.canvas.clientWidth,
      y: (0.5 - ndcY * 0.5) * this.canvas.clientHeight,
    };
  }

  /** canvas CSS 像素坐标 → 世界坐标 */
  canvasToWorld(cssX: any, cssY: any) {
    this.updateCamera();
    const p = this.projectionValues();
    if (!p) return null;
    const ndcX = (cssX / Math.max(1, this.canvas.clientWidth)) * 2 - 1;
    const ndcY = 1 - (cssY / Math.max(1, this.canvas.clientHeight)) * 2;
    const determinant = p[0] * p[5] - p[1] * p[4];
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
    const dx = ndcX - p[12];
    const dy = ndcY - p[13];
    return {
      x: (dx * p[5] - dy * p[4]) / determinant,
      y: (p[0] * dy - p[1] * dx) / determinant,
    };
  }

  /**
   * 命中测试：Live2DViewerEX 的 hit_areas 指定了骨骼与范围（近似判断）
   * @returns {object|null} 命中的区域
   */
  hitTest(cssX: any, cssY: any, hitAreas: any) {
    if (!this.skeleton || !Array.isArray(hitAreas) || hitAreas.length === 0) return null;
    const point = this.canvasToWorld(cssX, cssY);
    if (!point) return null;
    let best = null;
    let bestArea = Infinity;
    for (const area of hitAreas) {
      const rect = this.hitAreaRect(area);
      if (!rect) continue;
      if (
        point.x >= rect.worldX - rect.worldHalfWidth &&
        point.x <= rect.worldX + rect.worldHalfWidth &&
        point.y >= rect.worldY - rect.worldHalfHeight &&
        point.y <= rect.worldY + rect.worldHalfHeight
      ) {
        const size = rect.worldHalfWidth * rect.worldHalfHeight;
        if (size < bestArea) {
          bestArea = size;
          best = area;
        }
      }
    }
    return best;
  }

  /** 一个点击区域对应的矩形（世界坐标 + 画布坐标，画布坐标用于"可触发区域"红框） */
  hitAreaRect(area: any) {
    if (!this.skeleton || !area?.bone) return null;
    const bone = this.skeleton.findBone(area.bone);
    if (!bone) return null;
    const halfWidth = ((Math.abs(area.width) || 1) * this.hitUnit) / 2;
    const halfHeight = ((Math.abs(area.height) || 1) * this.hitUnit) / 2;
    const topLeft = this.worldToCanvas(bone.worldX - halfWidth, bone.worldY - halfHeight);
    const bottomRight = this.worldToCanvas(bone.worldX + halfWidth, bone.worldY + halfHeight);
    if (!topLeft || !bottomRight) return null;
    return {
      name: area.name,
      worldX: bone.worldX,
      worldY: bone.worldY,
      worldHalfWidth: halfWidth,
      worldHalfHeight: halfHeight,
      x: Math.min(topLeft.x, bottomRight.x),
      y: Math.min(topLeft.y, bottomRight.y),
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y),
    };
  }

  /** 当前所有点击区域的画布矩形（"可触发区域"叠加层用） */
  hitAreaRects(hitAreas: any) {
    const out = [] as any[];
    for (const area of hitAreas ?? []) {
      const rect = this.hitAreaRect(area);
      if (rect) out.push(rect);
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * 视图操作
   * ---------------------------------------------------------------- */

  panBy(deltaCssX: any, deltaCssY: any) {
    const camera = this.renderer.camera;
    const scaleX = camera.viewportWidth / this.canvas.clientWidth;
    const scaleY = camera.viewportHeight / this.canvas.clientHeight;
    this.view.panX -= deltaCssX * scaleX;
    this.view.panY += deltaCssY * scaleY;
  }

  zoomBy(factor: any, cssX: any, cssY: any) {
    const before = cssX !== undefined ? this.canvasToWorld(cssX, cssY) : null;
    this.view.zoom = Math.min(6, Math.max(0.2, this.view.zoom * factor));
    if (before) {
      this.updateCamera();
      const after = this.canvasToWorld(cssX, cssY);
      // 让光标下的那个点在缩放前后保持不动（NaN 防护：宁可不动也不能把相机弄丢）
      if (after && Number.isFinite(after.x) && Number.isFinite(after.y)) {
        this.view.panX += before.x - after.x;
        this.view.panY += before.y - after.y;
      }
    }
    if (!Number.isFinite(this.view.panX) || !Number.isFinite(this.view.panY)) this.resetView();
    this.updateCamera();
  }

  resetView() {
    this.view = { zoom: 1, panX: 0, panY: 0 };
  }

  dispose(clearCanvas = true) {
    for (const texture of this.textures) {
      try {
        texture.dispose();
      } catch {
        /* 忽略 */
      }
    }
    this.textures = [] as any[];
    this.skeleton = null;
    this.skeletonData = null;
    this.animationState = null;
    this.current = null;
    if (clearCanvas) {
      this.gl.clearColor(0, 0, 0, 1);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
  }
}

/**
 * 图集文本的**最小干预**规整（只在运行时做，磁盘上的资源不动）。
 *
 * ① 去掉行尾空白：实测 3473216664/heroframe.atlas 里 `hero_bg_list2 ` 带一个尾随空格，
 *    而骨架里附件引用的是 14 字节的无空格版本（二进制里能看到 `\x0ehero_bg_list2`），
 *    Spine 解析器把整行当区域名，于是永远找不到 → `Region not found in atlas`。
 * ② 去掉**开头**的空行：同一个文件第一行就是空行，会被当成一个空名字的页，
 *    `heroframe.png` 反而成了区域。中间的空行必须保留 —— 它是分页标记。
 * **不动缩进**：图集靠缩进区分"名字"与"key: value"，补缩进会得到
 * `Invalid line:   herocard/…`（常见错误，注意规避）。
 */
export function normalizeAtlasText(atlasText: any) {
  const out = String(atlasText)
    .split(/\r?\n/)
    .map((line: any) => line.replace(/[ \t]+$/, ''));
  let start = 0;
  while (start < out.length && out[start].trim() === '') start += 1;
  return out.slice(start).join('\n');
}

/** 从图集文本里取出页（贴图）文件名与声明的尺寸，顺序与 atlas 一致 */
export function parseAtlasPages(atlasText: any) {
  const lines = String(atlasText).split(/\r?\n/);
  const pages = [] as any[];
  for (let i = 0; i < lines.length; i++) {
    /* 页名是图集里的**顶格行**，且以图片扩展名结尾。两条都不能少：
       - 必须顶格：区域名也顶格、键值行有缩进，靠缩进区分（和 Spine 解析器一致）；
       - 扩展名判断**必须允许空格**：实测 3662410639 的页名是 `CGCharacter _200601.png`，
         以前写成 [^\s:]+ 就把它漏掉了 —— 页没被登记，加载时报"图集中引用的贴图未加载"。 */
    if (/^[ \t]/.test(lines[i])) continue;
    const name = lines[i].trim();
    if (!/^[^:]+\.(png|jpe?g|webp)$/i.test(name)) continue;
    let width = 0;
    let height = 0;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const line = lines[j].trim();
      const match = /^size:\s*(\d+)\s*,\s*(\d+)/i.exec(line);
      if (match) {
        width = Number(match[1]);
        height = Number(match[2]);
        break;
      }
      if (line === '') break;
    }
    pages.push({ name, width, height });
  }
  return pages;
}

/**
 * 从二进制骨架（.skel）头部读出版本号及其在字节里的位置（用于就地改写被运行时拒绝的版本号）
 * 3.8：varint(长度+1) + hash 字符串 + varint(长度+1) + 版本
 * 4.0：int32 lowHash + int32 highHash + varint(长度+1) + 版本
 * Spine 把字符串长度存成 length+1（0 = null，1 = 空串），见 BinaryInput.readString。
 */
export function readSpineBinaryHeader(bytes: any) {
  if (!bytes || bytes.length < 6) return null;
  let offset = 0;
  const readVarintAt = (start: any) => {
    let result = 0;
    let shift = 0;
    let cursor = start;
    for (let i = 0; i < 5; i++) {
      if (cursor >= bytes.length) return null;
      const byte = bytes[cursor++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return { value: result >>> 0, size: cursor - start };
      shift += 7;
    }
    return null;
  };
  const readVersionAt = (start: any) => {
    const varint = readVarintAt(start);
    if (!varint || varint.value <= 1) return null;
    const length = varint.value - 1;
    if (length > 16) return null;
    const begin = start + varint.size;
    if (begin + length > bytes.length) return null;
    let text = '';
    for (let i = 0; i < length; i++) {
      const byte = bytes[begin + i];
      if (byte < 0x20 || byte > 0x7e) return null;
      text += String.fromCharCode(byte);
    }
    return /^\d+\.\d+(\.\d+)?$/.test(text) ? { version: text, offset: begin, length } : null;
  };

  // 4.0 起：8 字节二进制 hash
  const version40 = bytes.length > 10 ? readVersionAt(8) : null;
  if (version40 && Number(version40.version.split('.')[0]) >= 4) return { hash: '', ...version40 };

  // 3.8：字符串 hash
  const hashVarint = readVarintAt(0);
  if (!hashVarint || hashVarint.value <= 1) return null;
  const hashBytes = hashVarint.value - 1;
  if (hashBytes > 255 || hashVarint.size + hashBytes >= bytes.length) return null;
  const version = readVersionAt(hashVarint.size + hashBytes);
  if (!version) return null;
  let hash = '';
  for (let i = 0; i < hashBytes; i++) hash += String.fromCharCode(bytes[hashVarint.size + i]);
  return { hash, ...version };
}

/** 只要版本号（sources.js 用来判断是不是二进制骨架） */
export function readSpineBinaryVersion(bytes: any) {
  return readSpineBinaryHeader(bytes)?.version ?? null;
}

function basename(path: any) {
  return String(path).split('/').pop();
}
