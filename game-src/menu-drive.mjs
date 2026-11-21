// 验收脚本共用的一小段：把「主菜单」点掉。
//
// 从「大肥鱼房子最新版 8」开始，玩什么模式不再是"你怎么打开这个文件"的副作用，
// 而是主菜单里玩家自己选的（game-src/shell/mode-menu.js）。所以任何验收脚本
// 导航到页面之后都必须先过这一关，否则后面全是 undefined —— 页面还停在菜单上，
// 引擎根本没启动。
//
// 这里只做一件事：等到菜单出现，按 which 点掉对应的那一个，然后等菜单消失。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 菜单里三个按钮的类名（与 mode-menu.js 保持一致）。
export const OPT = {
  solo: '.m-opt.solo',
  duo: '.m-opt.duo',
  server: '.m-opt.m-srv'
};

// 等某个选择器出现，返回 true/false。
export async function waitFor(evaluate, selector, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (r.value === true) return true;
    await sleep(200);
  }
  return false;
}

// 点掉菜单。which: 'solo' | 'server' | 'duo'（duo 只会停在双人子页，不点房间号）。
export async function pickMode(evaluate, which = 'solo', timeoutMs = 20_000) {
  const selector = OPT[which] || OPT.solo;
  if (!(await waitFor(evaluate, selector, timeoutMs))) {
    const seen = await evaluate(`JSON.stringify([...document.querySelectorAll('#gxMenu .m-opt')].map((e) => e.className + '|' + (e.textContent || '').trim().slice(0, 20)))`);
    throw new Error(`主菜单里没有 ${selector}，当前选项：${seen.value}`);
  }
  // 进门必须先有名字：空着点按钮只会被 requireName() 拦下来，菜单不动。
  // 这里替验收脚本把名字填上（输入事件也要发，否则菜单里的提示不会更新成「好」）。
  await evaluate(`(() => {
    const input = document.querySelector('#gxMenu .m-name input');
    if (!input || (input.value || '').trim()) return 'already';
    input.value = '验收';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  // 菜单淡出 280ms 后自己 remove；等它真的没了再往下走。
  const until = Date.now() + 6_000;
  while (Date.now() < until) {
    const r = await evaluate(`!document.getElementById('gxMenu') || getComputedStyle(document.getElementById('gxMenu')).display === 'none'`);
    if (r.value === true) return true;
    await sleep(120);
  }
  return false;
}
