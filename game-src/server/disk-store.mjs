// 服务器版存档：和浏览器那份 store 接口一致，落在真实目录。
//
// 联机模式的唯一状态源必须在服务器上 —— 两个浏览器各存一份就等于各玩各的。
// 接口刻意与 engine/storage.js 的 store 对齐，于是 home-engine.js / profile.js
// 一行不用改就能在 Node 里跑起来。
//
// 写盘先写 tmp 再 rename（和原版 saveHomeState 一个做法）：半截文件永远不会被读到。
import fs from 'node:fs';
import path from 'node:path';

const baseOf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || 'save.json';

export function createDiskStore(root) {
  const files = Object.create(null);
  const timers = new Map();
  const fileOf = (name) => path.join(root, baseOf(name));

  function flushOne(name) {
    timers.delete(name);
    if (files[name] == null) return;
    const tmp = `${fileOf(name)}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(tmp, files[name], { mode: 0o600 });
      fs.renameSync(tmp, fileOf(name));
    } catch { /* 下一次写还会重试 */ }
  }

  function touchDisk(name) {
    if (timers.has(name)) return;
    timers.set(name, setTimeout(() => flushOne(name), 300));
  }

  function loadFromDisk(name) {
    try {
      const text = fs.readFileSync(fileOf(name), 'utf8');
      files[name] = text;
      return text;
    } catch { return null; }
  }

  return {
    get backend() { return 'disk'; },
    get keys() { return Object.keys(files); },
    /** 只读文件，不进内存缓存（给"最近一次"这类查询用）。 */
    peek(p) { return files[baseOf(p)] ?? loadFromDisk(baseOf(p)); },
    read(p) {
      const name = baseOf(p);
      return files[name] != null ? files[name] : loadFromDisk(name);
    },
    write(p, text) {
      const name = baseOf(p);
      files[name] = typeof text === 'string' ? text : String(text ?? '');
      touchDisk(name);
    },
    rename(from, to) {
      const name = baseOf(from);
      if (files[name] == null && loadFromDisk(name) == null) return;
      files[baseOf(to)] = files[name];
      delete files[name];
      touchDisk(baseOf(to));
    },
    remove(p) {
      const name = baseOf(p);
      delete files[name];
      try { fs.unlinkSync(fileOf(name)); } catch { /* 本来就没有 */ }
    },
    has(p) {
      const name = baseOf(p);
      if (files[name] != null) return true;
      return loadFromDisk(name) != null;
    },
    flushNow() {
      for (const name of [...timers.keys()]) { clearTimeout(timers.get(name)); flushOne(name); }
    },
    exportText() { return JSON.stringify({ v: 1, at: Date.now(), files }); },
    importText(text) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !parsed.files) throw new Error('这不是一份养成屋存档');
      for (const [k, v] of Object.entries(parsed.files)) {
        if (typeof v === 'string') { files[k] = v; touchDisk(k); }
      }
      return Object.keys(parsed.files);
    },
    reset() { for (const k of Object.keys(files)) this.remove(k); },
    onWrite() { /* 服务器不需要这个钩子 */ }
  };
}
