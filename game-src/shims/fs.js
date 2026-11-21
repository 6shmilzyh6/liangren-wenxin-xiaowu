// node:fs 的浏览器替身。只实现 game engine 真正用到的那几个同步 API，
// 全部转给 engine/storage.js 的虚拟文件表。
import { store } from '../engine/storage.js';

function enoent(p) {
  const e = new Error(`ENOENT: no such file, open '${p}'`);
  e.code = 'ENOENT';
  e.errno = -2;
  e.path = p;
  return e;
}

export function readFileSync(path, options) {
  const text = store.read(path);
  if (text == null) throw enoent(path);
  const enc = typeof options === 'string' ? options : options?.encoding;
  if (enc) return text;
  return new TextEncoder().encode(text);
}

export function writeFileSync(path, data) {
  store.write(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
}

export function mkdirSync() { /* 虚拟文件表没有目录 */ }

export function renameSync(from, to) { store.rename(from, to); }

export function unlinkSync(path) { store.remove(path); }

export function existsSync(path) { return store.has(path); }

export const promises = {
  readFile: async (p, o) => readFileSync(p, o),
  writeFile: async (p, d) => writeFileSync(p, d),
  mkdir: async () => {},
  rename: async (a, b) => renameSync(a, b),
  unlink: async (p) => unlinkSync(p)
};

export default { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync, promises };
