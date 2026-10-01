/**
 * 首页：路由为 `/`（hash 为空）时展示的资源列表。
 *
 * 数据来自 `/api/packages`（服务器模式）或构建期的 `packages.json`（静态模式）。
 * 点卡片进入播放页（把 hash 设成 `#<包>/<角色>`）。
 *
 * **一张卡片 = 一个资源包**（列表以包为维度）。包里往往有多个角色/多套模型，
 * 按角色铺开会让列表迅速膨胀成一个包占好几张卡，找包反而更难；
 * 包内的角色在播放页左侧的"角色"下拉里切换。
 */

/** 卡片上显示的类型标签（一个包里可能两种都有，所以返回数组） */
function kindLabels(pkg: any): Array<{ label: string; variant: string }> {
  const kinds: string[] = Array.isArray(pkg.kinds) && pkg.kinds.length > 0 ? pkg.kinds : ['spine'];
  const out: Array<{ label: string; variant: string }> = [];
  if (kinds.includes('cubism')) out.push({ label: 'Live2D Cubism', variant: 'blue' });
  if (kinds.includes('spine')) out.push({ label: 'Spine', variant: 'success' });
  return out;
}

/** 包在搜索里能被命中的文本：标题、作者、包 id，以及包内角色名 */
function searchText(pkg: any): string {
  return [pkg.title, pkg.author, pkg.id, ...(Array.isArray(pkg.characterIds) ? pkg.characterIds : [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function createGallery({
  grid,
  search,
  kindSelect,
  summary,
  empty,
  onOpen,
  onDelete,
  confirmAction,
  loadIndex,
  localPackageId = 'local',
}: any) {
  /** 静态模式下"浏览器内解包"那条用的合成 id（删除时文案不同） */
  const LOCAL_PACKAGE_ID = localPackageId;
  /* 显式标注：不然 TS 会把这两个字段推成 null，后面所有赋值都报错 */
  const state: { packages: any[] | null; loading: Promise<any[]> | null } = { packages: null, loading: null };

  /**
   * 加载包列表。
   *
   * 只取索引本身，**不再逐包拉 manifest**（那正是静态模式卡住的原因）：
   * 卡片需要的东西索引里都有（标题、作者、角色 id、类型、预览图）。
   * 列表从哪来由调用方注入（`loadIndex`）：服务器模式走 /api，静态模式走 packages.json。
   */
  async function load() {
    if (state.packages) return state.packages;
    if (!state.loading) {
      state.loading = (async () => {
        const index = loadIndex ? await loadIndex() : null;
        if (!index) throw new Error('没有注入列表来源');
        const list = index.packages ?? [];
        state.packages = list;
        return list;
      })();
    }
    return state.loading;
  }

  /**
   * 过滤后的包列表：**一个包一张卡片**（列表以资源包为维度）。
   *
   * 只吃索引里的字段，不逐包去拉 manifest：静态部署下 models/ 未必跟着发布，
   * 那种做法会让几百个请求全部 404、列表永远停在"正在读取"。
   * 卡片需要的东西索引里都有（标题、作者、角色 id、类型、预览图）。
   */
  function visiblePackages(list: any[]) {
    const query = (search.value ?? '').trim().toLowerCase();
    const kind = kindSelect.value;
    const out: any[] = [];
    for (const pkg of list) {
      const kinds: string[] = Array.isArray(pkg.kinds) && pkg.kinds.length > 0 ? pkg.kinds : ['spine'];
      if (kind !== 'all' && !kinds.includes(kind)) continue;
      if (query && !searchText(pkg).includes(query)) continue;
      out.push(pkg);
    }
    return out;
  }

  /** 加载期间的骨架卡片，避免"空白 + 文字跳动"的观感 */
  function skeletons(count = 12) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const card = document.createElement('div');
      card.className = 'pkg-card skeleton';
      card.innerHTML =
        '<div class="sheerly-skeleton card-thumb"></div>' +
        '<div class="pkg-card-header"><div class="sheerly-skeleton sk-line w70"></div>' +
        '<div class="sheerly-skeleton sk-line w45"></div></div>';
      fragment.append(card);
    }
    grid.replaceChildren(fragment);
    empty.hidden = true;
  }

  function render() {
    const list = state.packages ?? [];
    const visible = visiblePackages(list);
    const totalChars = list.reduce((sum: number, pkg: any) => {
      const count = Array.isArray(pkg.characterIds) ? pkg.characterIds.length : 1;
      return sum + count;
    }, 0);
    /* 汇总同时给出包数与角色数：列表以**包**为维度，角色数是内容量 */
    summary.textContent =
      list.length > 0
        ? `共 ${list.length} 个资源包 · ${totalChars} 个角色${visible.length === list.length ? '' : `（筛选中：${visible.length} 个包）`}`
        : '正在读取资源包列表 …';

    /* 两种"空"要分开：
       * 列表本身是空的（还没拖入任何东西）→ 交给首页的引导（拖放区 + 选择按钮）；
       * 有包但筛选没命中 → 才显示"换个关键词"。 */
    empty.hidden = visible.length > 0 || list.length === 0;
    const fragment = document.createDocumentFragment();
    visible.forEach((pkg: any, cardIndex: number) => {
      const labels = kindLabels(pkg);
      const characters: string[] = Array.isArray(pkg.characterIds) ? pkg.characterIds : [];
      // 首页卡片自己实现（.pkg-card）：组件库的卡片是 inset 阴影描边 + header/content 各带内边距，
      // 想要"图片贴边且边框可见"就得一路覆盖它，反而更脆。这里用组件库的**变量**自己搭一个，
      // 边框是真的 border（画在 padding 之外，贴边的图片盖不住），其余颜色/圆角仍取自组件库。
      const card = document.createElement('div');
      card.className = 'pkg-card';
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      /* 卡片标题用包名（没有就用包内第一个角色名，再没有就用包 id） */
      const displayName = pkg.title || characters[0] || pkg.id;
      card.title = `${displayName}（${labels.map((l) => l.label).join(' / ')}）`;
      /* 把包 id 落在 DOM 上：调试与自动化都靠它精确定位 */
      card.dataset.packageId = pkg.id;

      const thumb = document.createElement('img');
      thumb.className = 'card-thumb';
      // 首屏几张直接加载（否则截图/首屏看着像空卡片），其余懒加载
      thumb.loading = cardIndex < 8 ? 'eager' : 'lazy';
      thumb.decoding = 'async';
      thumb.alt = '';
      const thumbnail = pkg.preview || pkg.avatar;
      if (thumbnail) thumb.src = thumbnail;
      thumb.addEventListener('error', () => thumb.remove());

      const header = document.createElement('div');
      header.className = 'pkg-card-header';

      const title = document.createElement('h3');
      title.className = 'pkg-card-title';
      title.textContent = displayName;

      const sub = document.createElement('p');
      sub.className = 'pkg-card-sub card-sub';
      /* 副标题给"包"的信息：作者与包 id（包名已经在标题上了） */
      const parts = [] as any[];
      if (pkg.author) parts.push(pkg.author);
      parts.push(pkg.id);
      sub.textContent = parts.join(' · ');
      sub.title = sub.textContent;
      header.append(title, sub);

      const meta = document.createElement('div');
      meta.className = 'pkg-card-meta card-meta';
      for (const { label, variant } of labels) {
        const badge = document.createElement('span');
        badge.className = 'sheerly-badge';
        badge.dataset.variant = variant;
        badge.textContent = label;
        meta.append(badge);
      }
      /* 一个包里往往不止一个角色：数量标出来，点进去在左侧"角色"下拉里切换 */
      const count = document.createElement('span');
      count.className = 'sheerly-badge';
      count.dataset.variant = 'secondary';
      count.textContent = `${characters.length || 1} 个角色`;
      if (characters.length > 1) count.title = characters.join('\n');
      meta.append(count);

      /* 删除：服务器模式会连磁盘目录一起删，所以这里做二次确认 */
      if (onDelete) {
        const del = document.createElement('button');
        del.className = 'pkg-card-delete sheerly-button';
        del.dataset.variant = 'secondary';
        del.dataset.size = 'xs';
        del.type = 'button';
        del.textContent = '删除';
        del.title = '从列表移除（服务器模式下同时删除磁盘目录）';
        del.addEventListener('click', async (event: any) => {
          event.stopPropagation();
          const label = displayName;
          /* 二次确认走调用方注入的对话框（组件库的 sheerly-dialog），
             不用 window.confirm —— 原生弹窗样式与主题都跟不上，也没法自定义文案。 */
          if (confirmAction) {
            const ok = await confirmAction({
              title: `删除「${label}」？`,
              description: pkg.id === LOCAL_PACKAGE_ID ? '这个包只在内存里，删掉后需要重新拖入。' : '服务器模式下会同时删除磁盘上的解包目录，此操作不可撤销。',
              confirmText: '删除',
            });
            if (!ok) return;
          }
          del.disabled = true;
          try {
            await onDelete(pkg.id);
            /* 删完**重新拉列表并重绘**：调用方（服务器模式）会让缓存失效，
               这时只从本地数组里删是删不掉的（数组可能已经是 null）。
               重新拉一次才是唯一可靠的更新方式。 */
            await reload();
          } catch (error: any) {
            del.disabled = false;
            summary.textContent = `删除失败：${error.message}`;
          }
        });
        meta.append(del);
      }

      card.append(thumb, header, meta);
      /* 点卡片进播放页：带包内**第一个角色**（其余角色在播放页左侧下拉里切） */
      const open = () => onOpen(pkg.id, characters[0] ?? '');
      card.addEventListener('click', open);
      // 用 div 而不是 button：button 的 UA 边框/内边距会破坏卡片描边，键盘可达性自己补
      card.addEventListener('keydown', (event: any) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      });
      fragment.append(card);
    });
    grid.replaceChildren(fragment);
  }

  search.addEventListener('input', render);
  kindSelect.addEventListener('change', render);

  /** 往列表里追加一个包（静态模式拖入 .lpk 解包后用它，见需求"拖入后追加"） */
  function add(entry: any) {
    if (!state.packages) state.packages = [];
    const list = state.packages.filter((item: any) => item.id !== entry.id);
    list.unshift(entry);
    state.packages = list;
    render();
  }

  /**
   * 丢掉缓存重新拉列表并重绘。
   * 删除之后必须走这条路：如果只从本地数组里删，而调用方已经让缓存失效
   * （服务器模式下的正常流程），数组就是 null，删不掉也不会重绘 —— 表现就是
   * "删了但列表没变"。这里以"重新拉一次"为唯一更新途径。
   */
  async function reload() {
    state.packages = null;
    state.loading = null;
    try {
      await load();
    } catch (error: any) {
      summary.textContent = `读取资源包列表失败：${error.message}`;
      return;
    }
    render();
  }

  return {
    /** 每次显示首页时调用 */
    async show() {
      if (!state.packages) skeletons();
      try {
        await load();
      } catch (error: any) {
        summary.textContent = `读取资源包列表失败：${error.message}`;
        grid.replaceChildren();
        empty.hidden = false;
        return;
      }
      render();
    },
    add,
    reload,
    /** 列表内容变了（例如服务器上删了一个包）就丢掉缓存，下次显示时重新拉 */
    invalidate() {
      state.packages = null;
      state.loading = null;
    },
  };
}
