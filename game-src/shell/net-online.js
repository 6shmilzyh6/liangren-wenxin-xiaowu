// 联机服务器模式：所有人打开同一个服务器地址，共用一份存档在服务器上。
//
// 这不是默认玩法了（默认由玩家在主菜单里选），但保留它，因为：
//   · 两个人想"长期同住一间屋"时，服务器比"谁开房谁托管"更省事；
//   · 它也是唯一能做"离线结算在服务器上、换设备也能接着玩"的方式。
//
// 这个文件只做两件事：
//   1. 包一层 fetch，把 pid / 名字带上（app.js 一行不改）；
//   2. 挂「屋里的人」面板（UI 在 net-ui.js，和点对点双人共用一块）。
import { playerId, playerName } from './identity.js';
import { mountNetUI, absorbNet, setLinkState, renderNet, netState } from './net-ui.js';

const isOnline = () => location.protocol === 'http:' || location.protocol === 'https:';

/** 包 fetch：给 home 相关接口补上身份，并顺手吸收在线名单。 */
function installOnlineFetch() {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
    let url;
    try { url = new URL(raw, location.origin); } catch { return original(input, init); }

    if (!url.pathname.includes('/api/')) return original(input, init);

    // /api/home/state 是 GET，身份走查询串；其余所有 POST 的 JSON body 补上 pid / by，
    // 这样 home 的摸头投喂、菜园的浇水收菜、以及以后新加的接口都能分得清是谁做的。
    if (url.pathname.endsWith('/api/home/state')) {
      url.searchParams.set('pid', playerId());
      url.searchParams.set('name', playerName());
      input = url.toString();
    } else if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          body.pid = playerId();
          if (!body.by) body.by = playerName();
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch { /* 不是 JSON 就原样发出 */ }
    }

    const res = await original(input, init);

    // 顺势把在线名单与玩家动态抓出来，省一次请求。
    if (url.pathname.endsWith('/api/home/state') || url.pathname.endsWith('/api/home/act')) {
      try { absorbNet(await res.clone().json()); } catch { /* 忽略 */ }
    }
    return res;
  };
}

/**
 * 启动联机层。只在 http(s) 下有意义。
 * @returns true 表示这次是联机模式（调用方不要再装单机 shim）
 */
export function mountOnline() {
  if (!isOnline()) return false;
  installOnlineFetch();
  mountNetUI();
  setLinkState('connected');

  // 心跳：让对方的名单里一直有自己，同时把屋里其他人的名单和动态拉回来。
  // 上来先打一拍（不要等 8 秒）——不然刚进屋子的人名单里只有自己，
  // 状态条会先显示「你在屋里」，对面明明已经进来了。
  const beat = () => {
    fetch('/api/net/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: playerId(), name: playerName() })
    }).then((r) => r.json()).then((d) => {
      if (!d.ok) return;
      // 心跳只回名单，没有动态。这里绝不能塞一个空 feed —— 否则 absorbNet
      // 会把刚拉到的"谁做了什么"冲掉，面板永远是空的。
      absorbNet({ net: { players: d.players || [], you: d.you || playerId() } });
      if (netWasBad) { netWasBad = false; setLinkState('connected'); }
    }).catch(() => {
      // 服务器没了：状态条要说清楚，否则玩家只会觉得"她不动了"。
      if (!netWasBad) { netWasBad = true; setLinkState('disconnected', '服务器上不去了'); }
    });
  };
  beat();
  setInterval(beat, 4000);

  globalThis.__net = { playerId, renderNet, state: netState };
  return true;
}

let netWasBad = false;

// 兼容旧名字：别的模块里可能 import 过 playerId / playerName。
export { isOnline, playerId, playerName };
