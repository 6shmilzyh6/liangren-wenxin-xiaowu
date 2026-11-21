// 玩家身份：谁是"你"。
//
// 单机、房主、客人三种身份用同一套键，于是事件面板里始终分得清谁做的。
// 只存本机 localStorage，不做账号、不上传。
const PID_KEY = 'dafiyu-player-id';
const NAME_KEY = 'home-actor-name';
const SIDE_KEY = 'dafiyu-my-side';
const NAME_SET_KEY = 'dafiyu-name-set';

export const DEFAULT_NAME = '小屋访客';

/** 这一端陪的是谁：'her' 小蓝鱼 / 'claude' Claude 小公主。空字符串表示还没定。 */
export function mySide() {
  let v = '';
  try { v = localStorage.getItem(SIDE_KEY) || ''; } catch { /* 忽略 */ }
  return v === 'claude' ? 'claude' : v === 'her' ? 'her' : '';
}

/** 定下这一端住哪一侧；进房时定一次，房内只能通过双方同意互换。 */
export function setMySide(side) {
  const v = side === 'claude' ? 'claude' : side === 'her' ? 'her' : '';
  try { v ? localStorage.setItem(SIDE_KEY, v) : localStorage.removeItem(SIDE_KEY); } catch { /* 忽略 */ }
  return v;
}

export function sideName(side) {
  return side === 'claude' ? '小公主' : '小蓝鱼';
}

export function otherSide(side) {
  return side === 'claude' ? 'her' : 'claude';
}

/** 同一台机器同一浏览器是同一个 pid；换设备就是另一个人。 */
export function playerId() {
  let pid = '';
  try { pid = localStorage.getItem(PID_KEY) || ''; } catch { /* 忽略 */ }
  if (!pid) {
    pid = `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    try { localStorage.setItem(PID_KEY, pid); } catch { /* 忽略 */ }
  }
  return pid;
}

export function playerName() {
  try { return (localStorage.getItem(NAME_KEY) || '').trim() || DEFAULT_NAME; } catch { return DEFAULT_NAME; }
}

/**
 * 这个名字是不是玩家自己定的。
 * 空名字会静默回落成「小屋访客」，两个人都不改名时就都叫这个 ——
 * 事件面板分不清谁做的，按名字记的账也会合并成一条。所以进门前必须问一次。
 */
export function nameSettled() {
  try {
    if (localStorage.getItem(NAME_SET_KEY) === '1') return true;
    const v = (localStorage.getItem(NAME_KEY) || '').trim();
    // 老存档：以前填过名字的（且不是默认值）就算定过了，不要再拦一次。
    return !!v && v !== DEFAULT_NAME;
  } catch { return false; }
}

export function setPlayerName(name) {
  const v = String(name || '').trim().slice(0, 12);
  try {
    if (v) {
      localStorage.setItem(NAME_KEY, v);
      localStorage.setItem(NAME_SET_KEY, '1');
    } else {
      localStorage.removeItem(NAME_KEY);
      localStorage.removeItem(NAME_SET_KEY);
    }
  } catch { /* 忽略 */ }
  return v || DEFAULT_NAME;
}

/** 是不是第一次开这个游戏（用过开局引导没有）。 */
export function hasOnboarded() {
  try { return localStorage.getItem('dafiyu-game-intro') === '1'; } catch { return false; }
}

export function markOnboarded() {
  try { localStorage.setItem('dafiyu-game-intro', '1'); } catch { /* 忽略 */ }
}
