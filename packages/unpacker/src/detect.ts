/**
 * 资源类型识别：把解密后的字节流归类成"原始资源"
 */

export type AssetKind =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'mp3'
  | 'ogg'
  | 'wav'
  | 'moc3'
  | 'spine-skeleton'
  | 'spine-skeleton-binary'
  | 'spine-atlas'
  | 'live2dex-model'
  | 'live2dex-package'
  | 'live2d-model3'
  | 'json'
  | 'text'
  | 'binary';

export interface Detection {
  kind: AssetKind;
  /** 建议扩展名（含点） */
  ext: string;
  label: string;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 严格 UTF-8 解码；失败返回 null（加密后的乱码几乎必然失败） */
export function tryDecodeText(bytes: Uint8Array): string | null {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

export function tryParseJson(text: string): unknown | null {
  const head = text.slice(0, 64).trimStart();
  if (!head.startsWith('{') && !head.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function classifyJson(json: unknown): AssetKind {
  if (!isRecord(json)) return 'json';
  // Spine 骨架（JSON 导出）：skeleton 是对象，且带 bones/slots/skins/animations
  if (isRecord(json.skeleton) && (Array.isArray(json.bones) || Array.isArray(json.slots))) {
    return 'spine-skeleton';
  }
  // Live2DViewerEX 模型配置：skeleton 是字符串，atlases 是数组
  if (Array.isArray(json.atlases) && typeof json.skeleton === 'string') return 'live2dex-model';
  // Cubism 3/4 的 model3.json
  if (isRecord(json.FileReferences)) return 'live2d-model3';
  // LPK 包描述：type 是字符串（STM_1_0 / STD2_0 ...），带 list
  if (typeof json.type === 'string' && Array.isArray(json.list)) return 'live2dex-package';
  if (isRecord(json.skeleton) && Array.isArray(json.animations)) return 'spine-skeleton';
  return 'json';
}

/** Spine 图集文本：第一行是 "xxx.png"，后面跟 size/format/filter 等 */
export function looksLikeSpineAtlas(text: string): boolean {
  const lines = text.split(/\r?\n/, 8);
  const first = lines.find((l) => l.trim().length > 0);
  if (!first || !/\.(png|jpe?g|webp)$/i.test(first.trim())) return false;
  return /\bsize\s*:/i.test(text) || /\bformat\s*:/i.test(text) || /\bfilter\s*:/i.test(text);
}

/**
 * Spine 二进制骨架（.skel）头部识别
 *
 * 两种布局：
 *   · 3.8      ：varint(字符串长度+1) + hash 字符串 + varint(长度+1) + 版本（如 "3.8.97"）
 *   · 4.0 及以后：int32 lowHash + int32 highHash + varint(长度+1) + 版本（如 "4.0.56"）
 * 注意 Spine 的 readString 把长度存成 length+1（0 表示 null，1 表示空串）。
 *
 * ⚠ 这段逻辑在 `web/player.js` 里有一份**浏览器侧的副本**（`readSpineBinaryHeader` /
 * `readSpineBinaryVersion`，它额外返回版本号在字节里的位置，好就地改写版本号），
 * 两边已经各自演化过。改这里时请一并看那边（以及反过来）。
 */
export function readSpineBinaryHeader(bytes: Uint8Array): { hash: string; version: string } | null {
  const readVarintAt = (start: number): { value: number; size: number } | null => {
    let result = 0;
    let shift = 0;
    let offset = start;
    for (let i = 0; i < 5; i++) {
      if (offset >= bytes.length) return null;
      const byte = bytes[offset++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return { value: result >>> 0, size: offset - start };
      shift += 7;
    }
    return null;
  };

  /** 从 start 处读一个 "长度+1" 前缀的 ASCII 字符串，要求形如 1.2 或 1.2.3 */
  const readVersionAt = (start: number): string | null => {
    const varint = readVarintAt(start);
    if (!varint || varint.value <= 1) return null;
    const byteCount = varint.value - 1;
    if (byteCount > 16) return null;
    const begin = start + varint.size;
    if (begin + byteCount > bytes.length) return null;
    let out = '';
    for (let i = 0; i < byteCount; i++) {
      const byte = bytes[begin + i];
      if (byte < 0x20 || byte > 0x7e) return null;
      out += String.fromCharCode(byte);
    }
    return /^\d+\.\d+(\.\d+)?$/.test(out) ? out : null;
  };

  // 4.0+：int32 lowHash + int32 highHash（共 8 字节），紧跟版本字符串
  const version40 = bytes.length > 10 ? readVersionAt(8) : null;
  if (version40 && Number(version40.split('.')[0]) >= 4) {
    const hash = [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { hash, version: version40 };
  }

  // 3.8：varint(长度+1) + 字符串 hash + varint(长度+1) + 版本
  const hashVarint = readVarintAt(0);
  if (!hashVarint || hashVarint.value <= 1) return null;
  const hashBytes = hashVarint.value - 1;
  if (hashBytes > 255 || hashVarint.size + hashBytes >= bytes.length) return null;
  const version = readVersionAt(hashVarint.size + hashBytes);
  if (!version) return null;
  let printable = true;
  let hash = '';
  for (let i = 0; i < hashBytes; i++) {
    const byte = bytes[hashVarint.size + i];
    if (byte < 0x20 || byte > 0x7e) printable = false;
    hash += String.fromCharCode(byte);
  }
  return { hash: printable ? hash : [...hash].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join(''), version };
}

/** 图集里的一个页（贴图）声明 */
export interface AtlasPageInfo {
  name: string;
  /** 图集里声明的页尺寸，用来校验贴图是否配对正确 */
  width: number;
  height: number;
}

/**
 * 解析图集文本里的页声明：第一行是页名，随后几行里有 size: W,H
 *
 * ⚠ `web/player.js` 里有一份同名副本（`parseAtlasPages`，播放器要在浏览器侧读声明尺寸）：
 * 同一套"页名 + size"解析规则存在两份实现，改这里时请一并核对那边（以及反过来）。
 */
export function parseAtlasPages(text: string): AtlasPageInfo[] {
  const lines = text.split(/\r?\n/);
  const pages: AtlasPageInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].trim();
    if (!/^[^\s:]+\.(png|jpe?g|webp)$/i.test(name)) continue;
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

/** 读取图片尺寸（目前支持 PNG；用于校验图集声明与实际贴图是否一致） */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG：扫描 SOFn 段
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

export function detect(bytes: Uint8Array): Detection {
  if (bytes.length >= 8 && asciiAt(bytes, 0, '\u0089PNG')) return { kind: 'png', ext: '.png', label: 'PNG 图片' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'jpeg', ext: '.jpg', label: 'JPEG 图片' };
  }
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) return { kind: 'wav', ext: '.wav', label: 'WAV 音频' };
  if (asciiAt(bytes, 0, 'OggS')) return { kind: 'ogg', ext: '.ogg', label: 'OGG 音频' };
  if (asciiAt(bytes, 0, 'ID3')) return { kind: 'mp3', ext: '.mp3', label: 'MP3 音频' };
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { kind: 'mp3', ext: '.mp3', label: 'MP3 音频' };
  }
  if (asciiAt(bytes, 0, 'MOC3')) return { kind: 'moc3', ext: '.moc3', label: 'Live2D Cubism 模型' };
  if (asciiAt(bytes, 8, 'WEBP')) return { kind: 'webp', ext: '.webp', label: 'WebP 图片' };
  // 二进制骨架放在文本判定之前：它的头部是 hash + 版本号，可能被误当成文本
  if (readSpineBinaryHeader(bytes)) return { kind: 'spine-skeleton-binary', ext: '.skel', label: 'Spine 骨架（二进制）' };

  const text = tryDecodeText(bytes);
  if (text !== null) {
    const json = tryParseJson(text);
    if (json !== null) {
      const kind = classifyJson(json);
      return { kind, ext: '.json', label: JSON_LABELS[kind] ?? 'JSON' };
    }
    if (looksLikeSpineAtlas(text)) return { kind: 'spine-atlas', ext: '.atlas', label: 'Spine 图集' };
    return { kind: 'text', ext: '.txt', label: '文本' };
  }
  return { kind: 'binary', ext: '.bin', label: '未知二进制' };
}

const JSON_LABELS: Partial<Record<AssetKind, string>> = {
  'spine-skeleton': 'Spine 骨架 JSON',
  'spine-skeleton-binary': 'Spine 骨架（二进制）',
  'spine-atlas': 'Spine 图集',
  'live2dex-model': 'Live2DViewerEX 模型配置',
  'live2dex-package': 'Live2DViewerEX 包配置',
  'live2d-model3': 'Live2D model3.json',
  json: 'JSON',
};

/** 用于"明文 vs 解密"的判定：越像已知资源分越高 */
export function detectionScore(detection: Detection): number {
  switch (detection.kind) {
    case 'binary':
      return 0;
    case 'text':
      return 1;
    case 'json':
      return 2;
    default:
      return 3;
  }
}
