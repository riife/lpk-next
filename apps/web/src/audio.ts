/**
 * 语音播放。
 *
 * 三件事容易踩坑，都在这里处理：
 *   1. 切换动作/角色时必须把上一段语音停掉——记录所有创建过的音频元素，一次性全停；
 *   2. 浏览器的自动播放策略会拦下没有用户交互时的播放，这里记下来等第一次点击再补播，
 *      而不是抛一个看不懂的错误；
 *   3. 被自己的停止操作打断（AbortError）是正常现象，不该报错。
 */
export class VoicePlayer {
  /* 字段声明：迁移时按 tsc 的 TS2339 报错逐条补出，类型暂为 any（后续按模块收紧） */
  analysers: any;
  audioContext: any;

  /* 字段声明：迁移时从构造函数里的 this.x 赋值推导，类型暂为 any（后续按模块收紧） */
  elements: any;
  onStatus: any;
  pending: any;
  resolveUrl: any;

  constructor({ onStatus }: { onStatus?: (message: string, isError?: boolean) => void } = {}) {
    this.onStatus = onStatus ?? (() => {});
    this.elements = new Set();
    this.pending = null;
    this.resolveUrl = null;
  }

  /** @param {(path: string) => string | undefined} resolveUrl 把包内路径转成可播放的 URL */
  setUrlResolver(resolveUrl: any) {
    this.resolveUrl = resolveUrl;
  }

  /** 当前是否有语音在播 */
  get playing() {
    return this.elements.size > 0;
  }

  play(relativePath: any) {
    const url = this.resolveUrl?.(relativePath);
    if (!url) return;
    this.stop();
    const audio = new Audio(url);
    // 记下路径：播放失败时要凭它把元素从集合里摘掉（见 handleError）
    (audio as HTMLAudioElement & { __lpkPath?: string }).__lpkPath = relativePath;
    this.elements.add(audio);
    this.analyserFor(audio);
    audio.addEventListener('ended', () => this.elements.delete(audio));
    audio.play().catch((error: any) => this.handleError(error, relativePath));
  }

  /**
   * 给一段语音挂上音量分析器（口型同步用，原版的 LipSync 控制器）。
   *
   * 说明：`createMediaElementSource` 会把音频**改道**进 AudioContext，
   * 所以必须 connect 到 destination，否则就静音了。浏览器不支持 / 上下文被挂起时
   * 一律安静降级（口型不动，但语音照常播）。
   * 每个元素只能 createMediaElementSource 一次，所以结果缓存在元素上。
   */
  analyserFor(audio: any) {
    try {
      const Ctor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
      if (!Ctor) return null;
      const context = (this.audioContext ??= new Ctor());
      if (context.state === 'suspended') context.resume?.().catch(() => {});
      if (!audio.__lpkSource) {
        const source = context.createMediaElementSource(audio);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        source.connect(analyser);
        analyser.connect(context.destination);
        audio.__lpkSource = source;
        audio.__lpkAnalyser = analyser;
        audio.__lpkBuffer = new Uint8Array(analyser.fftSize);
        this.analysers ??= new Set();
        this.analysers.add(analyser);
      }
      return audio.__lpkAnalyser ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 当前语音的音量（0~1），口型同步用。没有语音在播就返回 0。
   * 用**波形**的均方根而不是频谱平均，呼吸/噪声不会被当成"在说话"。
   */
  getLevel() {
    if (this.elements.size === 0) return 0;
    let peak = 0;
    for (const audio of this.elements) {
      const analyser = audio.__lpkAnalyser;
      const buffer = audio.__lpkBuffer;
      if (!analyser || !buffer) continue;
      try {
        analyser.getByteTimeDomainData(buffer);
      } catch {
        continue;
      }
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = (buffer[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buffer.length);
      // 语音的 RMS 通常 < 0.3，乘个系数再夹到 0~1，看起来才像"在说话"
      peak = Math.max(peak, Math.min(1, rms * 3));
    }
    return peak;
  }

  /**
   * 停止并**释放**所有播放过的语音。
   *
   * 只 pause 是不够的：媒体元素会继续占着已缓冲/已解码的资源，切模型之后旧语音还可能接着响。
   * 这里把 src 摘掉再 load() 一次，浏览器才会真正释放；同时清掉等待补播的那条
   * （否则切完模型后第一次点击会把**旧模型**的语音补播出来）。
   */
  stop() {
    this.pending = null;
    for (const audio of this.elements) {
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.removeAttribute('src');
        audio.load();
        /* 音频图也要拆：每个元素都挂着一个 MediaElementSource + Analyser，
           只清元素的话 analysers 这个 Set 会随着每条语音无限增长（实测一场下来几十个），
           而且旧节点还连着 destination。断开之后再从集合里删掉。 */
        try {
          audio.__lpkSource?.disconnect?.();
          audio.__lpkAnalyser?.disconnect?.();
        } catch {
          /* 忽略：某些实现下重复 disconnect 会抛 */
        }
        if (audio.__lpkAnalyser) this.analysers?.delete(audio.__lpkAnalyser);
        audio.__lpkSource = null;
        audio.__lpkAnalyser = null;
      } catch {
        /* 忽略 */
      }
    }
    this.elements.clear();
  }

  /** 用户第一次交互后补播被浏览器拦下的语音 */
  resumePending() {
    if (!this.pending) return;
    const path = this.pending;
    this.pending = null;
    this.play(path);
  }

  handleError(error: any, relativePath: any) {
    const message = error?.message ?? '';
    // 被自己的 stop() 打断
    if (error?.name === 'AbortError' || /interrupted by a call to pause/i.test(message)) return;
    /* 播放失败的元素**要从集合里摘掉**：只有 'ended' 会摘，
       否则 playing 恒为 true、getLevel() 一直去问一个不会出声的元素，
       口型同步也就一直挂在那里空转。失败的元素本来就废了，下次是新建的。 */
    for (const audio of this.elements) {
      if (audio.__lpkPath === relativePath || !relativePath) this.elements.delete(audio);
    }
    if (error?.name === 'NotAllowedError') {
      this.pending = relativePath;
      this.onStatus('浏览器限制自动播放：点一下页面即可听到语音。');
      return;
    }
    this.onStatus(`语音播放失败：${message}`, true);
  }
}
