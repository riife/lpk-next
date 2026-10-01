/**
 * 文件名/目录名处理：让输出既能当普通文件系统路径，也能直接当 URL 使用
 */
import type { AssetKind } from './detect.ts';

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFileName(name: string, fallback = 'unnamed'): string {
  let out = name.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!out) out = fallback;
  if (RESERVED.test(out)) out = `_${out}`;
  return out.length > 120 ? out.slice(0, 120) : out;
}

export function sanitizeFolderName(name: string, fallback = 'character'): string {
  return sanitizeFileName(name, fallback);
}

export function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export const AUDIO_EXTENSIONS: Partial<Record<AssetKind, string>> = {
  mp3: '.mp3',
  ogg: '.ogg',
  wav: '.wav',
};

export function isAudioKind(kind: AssetKind): boolean {
  return kind === 'mp3' || kind === 'ogg' || kind === 'wav';
}

export function isImageKind(kind: AssetKind): boolean {
  return kind === 'png' || kind === 'jpeg' || kind === 'webp';
}

export function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`;
}
