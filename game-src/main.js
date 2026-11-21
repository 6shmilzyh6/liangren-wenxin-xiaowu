// 游戏入口。
//
// 现在的流程是：先弹主菜单（单机 / 双人 / 连服务器），玩家选完、并且需要联网的
// 模式已经真的连上了，才继续往下走。模式不再是"你怎么打开这个文件"的副作用。
//
// 顺序不能改：
//   1. 主菜单 —— 它负责把网络层装好（单机装引擎替身；双人连上以后再往下走）；
//   2. mountGameShell() —— 状态条与引导要在 loading 层之上、app 启动之前就位；
//   3. import('./boot-app.js') —— 原版 app.js 原样打包进来，一行没改。
//
// 注意：iife 产物不支持顶层 await，所以用 promise 链。
import { mountGameShell } from './shell/game-shell.js';
import { showModeMenu } from './shell/mode-menu.js';

// 页面关掉时跟「开始玩.exe」告个别，让它知道人可以走了（它再多等 90 秒确认没有新请求
// 就自己退出，这样不会在托盘里留一个僵尸进程）。用 file:// 打开时没有这个端点，
// 报了错也不管。keepalive 让请求能在页面卸载过程中发出去。
function sayBye() {
  try {
    fetch('/__bye', { method: 'GET', keepalive: true, cache: 'no-store' }).catch(() => {});
  } catch { /* 无所谓 */ }
}
addEventListener('pagehide', sayBye);
addEventListener('beforeunload', sayBye);

function fatal(err) {
  console.error('[game] 启动失败', err);
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;max-height:40vh;overflow:auto;'
    + 'background:rgba(60,10,20,.92);color:#ffd7dd;font:12px/1.5 monospace;padding:12px;'
    + 'border-radius:10px;z-index:99;white-space:pre-wrap';
  box.textContent = `启动失败：${err?.message || err}\n\n${err?.stack || ''}`;
  document.body.appendChild(box);
  // 菜单里已经报过错了就不要再盖一层：把菜单还回来，玩家能重试。
  const menu = document.getElementById('gxMenu');
  if (menu) menu.style.display = '';
}

showModeMenu()
  .then(async (choice) => {
    if (!choice) throw new Error('没有选玩法');

    let mode = 'solo';
    if (choice.mode === 'online') {
      // 老玩法：所有人在同一个服务器上，共用一份存档。
      const { mountOnline } = await import('./shell/net-online.js');
      mountOnline();
      mode = 'online';
    } else if (choice.mode === 'host' || choice.mode === 'guest') {
      // 双人：net-duo 在菜单里已经把引擎接好、通道连上了，这里什么都不用做。
      mode = 'duo';
    } else {
      const { installNetShim } = await import('./shell/net-shim.js');
      installNetShim();
      mode = 'solo';
    }

    // 这一端住哪一侧：菜单里定的，交给 app.js 决定整页文案与能指挥谁。
    // 单机/服务器模式没有这个概念（两边都能看能切），只有双人才锁。
    if (mode === 'duo' && (choice.side === 'her' || choice.side === 'claude')) {
      globalThis.__homeSide = choice.side;
    }

    mountGameShell({ mode, duo: choice.mode });
    return import('./boot-app.js');
  })
  .catch(fatal);

export { fatal };
