// 浏览器单机版的存档层：把原来 Node 侧的 state/*.json 换成一个可持久化的虚拟文件表。
// 上层（home-state.js / garden-store.js）只认 read/write/rename/remove，
// 不知道自己不在 Node 里跑。
//
// 三条纪律：
//   1. localStorage 打不开（file:// 某些策略、隐私模式）就退回内存，游戏照样能玩；
//   2. 写盘做 400ms 防抖，轮询 1.2 秒一次也不会把 localStorage 写爆；
//   3. 导出/导入走同一份 JSON，换电脑能接着玩。
//
// 联机版不用这里：服务器的唯一状态源直接落在真实文件上（game-src/server/server.mjs）。
// 这个文件刻意不 import 任何 node:*，否则 shims/fs.js 与它会形成循环依赖。
if (!globalThis.process) {
  // home-state.js 的 saveHomeState 会拼临时文件名，只需要一个 pid。
  globalThis.process = { pid: 0, env: {}, platform: 'browser', version: 'v0' };
}

const KEY = 'dafiyu-game-save-v1';
const baseOf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || 'save.json';

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

const state = {
  files: Object.create(null),
  backend: 'memory',
  dirty: false,
  timer: 0,
  onWrite: null
};

// 只有浏览器才有 localStorage；Node 里直接是内存后端（服务器用 disk store）。
(function boot() {
  if (typeof localStorage === 'undefined') {
    state.backend = 'memory';
    return;
  }
  const raw = safeGet(KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
        for (const [k, v] of Object.entries(parsed.files)) {
          if (typeof v === 'string') state.files[k] = v;
        }
        state.backend = 'localStorage';
        return;
      }
    } catch { /* 存档坏了就当新档，旧字符串留在原 key 里不覆盖 */ }
  }
  state.backend = safeSet(`${KEY}.probe`, '1') ? 'localStorage' : 'memory';
  try { localStorage.removeItem(`${KEY}.probe`); } catch { /* 忽略 */ }
})();

function serialize() {
  return JSON.stringify({ v: 1, at: Date.now(), files: state.files });
}

function flush() {
  state.timer = 0;
  if (!state.dirty) return;
  state.dirty = false;
  if (state.backend === 'localStorage') {
    if (!safeSet(KEY, serialize())) state.backend = 'memory';
  }
  try { state.onWrite?.(); } catch { /* 忽略 */ }
}

function touch() {
  state.dirty = true;
  if (state.timer) return;
  state.timer = setTimeout(flush, 400);
}

export const store = {
  get backend() { return state.backend; },
  get keys() { return Object.keys(state.files); },
  read(path) {
    const v = state.files[baseOf(path)];
    return v == null ? null : v;
  },
  write(path, text) {
    state.files[baseOf(path)] = typeof text === 'string' ? text : String(text ?? '');
    touch();
  },
  rename(from, to) {
    const name = baseOf(from);
    if (state.files[name] == null) return;
    state.files[baseOf(to)] = state.files[name];
    delete state.files[name];
    touch();
  },
  remove(path) {
    if (state.files[baseOf(path)] == null) return;
    delete state.files[baseOf(path)];
    touch();
  },
  has(path) { return state.files[baseOf(path)] != null; },
  flushNow() { flush(); },
  exportText() { return serialize(); },
  importText(text) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
      throw new Error('这不是一份养成屋存档');
    }
    const next = Object.create(null);
    for (const [k, v] of Object.entries(parsed.files)) {
      if (typeof v === 'string') next[k] = v;
    }
    for (const k of Object.keys(state.files)) delete state.files[k];
    Object.assign(state.files, next);
    touch();
    return Object.keys(next);
  },
  reset() {
    for (const k of Object.keys(state.files)) delete state.files[k];
    touch();
  },
  onWrite(fn) { state.onWrite = fn; }
};

// 关页面前把没落盘的那一次写完。
// （服务器端也会 import 这个模块取 createProfile，那边没有 window，要判一下。）
if (typeof addEventListener === 'function') {
  addEventListener('pagehide', () => { state.dirty = true; flush(); });
  if (typeof document !== 'undefined') {
    addEventListener('visibilitychange', () => { if (document.hidden) { state.dirty = true; flush(); } });
  }
}
