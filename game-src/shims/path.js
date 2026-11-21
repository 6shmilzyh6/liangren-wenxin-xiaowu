// node:path 的浏览器替身：存档路径只有 "state/xxx.json" 这一种形状。
const norm = (p) => String(p ?? '').replace(/\\/g, '/');

export function dirname(p) {
  const s = norm(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}

export function basename(p, ext) {
  const s = norm(p).replace(/\/+$/, '');
  let name = s.slice(s.lastIndexOf('/') + 1);
  if (ext && name.endsWith(ext)) name = name.slice(0, -ext.length);
  return name;
}

export function extname(p) {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '';
}

export function join(...parts) {
  return parts.map(norm).filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}

export function resolve(...parts) { return join(...parts); }
export const sep = '/';
export const delimiter = ':';

export default { dirname, basename, extname, join, resolve, sep, delimiter };
