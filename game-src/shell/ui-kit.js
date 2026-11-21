// 联机层要用的一点点 UI 基建：创建元素 + 这部分样式。
// 单独拆出来是为了让 net-online.js 专注在"联机"这件事上。

/**
 * 建一个元素。
 *
 * 第三个参数是文字内容 —— 别省掉它：早先这里只收 (tag, cls)，
 * 调用处照 game-shell.js 的习惯多传一个字符串，结果是「离开这间屋子」变成
 * 一个没有字的空按钮，点了能生效但玩家根本看不出那是什么。
 */
export function el(tag, cls = '', text = '') {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

// 右下角。养成状态条在左下角（#gxBar），HUD 的动作按钮在右边 20px/170px，
// 所以这里贴着右下角、宽度压窄，不跟任何一块打架。
//
// 配色：这层样式会被注入到游戏页里，那里不一定加载了 room/skin-desk.css，
// 所以每个变量都写 var(--令牌, 兜底值)：页面有令牌就跟令牌走，
// 没有就退到同一张纸/陶色板上。字体栈也只有一份，不再各写一处。
export const CSS_EXTRA = `
.nt-bar{position:fixed; right:20px; bottom:18px; z-index:19; display:flex; align-items:center; gap:8px;
  padding:7px 10px; border-radius:var(--r-2,10px);
  background:var(--paper,#f6f0e4); border:1px solid var(--line,#d9cbb5);
  box-shadow:var(--sh-2,0 6px 18px rgba(90,68,48,.14));
  font:var(--fs-2,12px)/1.2 var(--font-ui,"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif);
  color:var(--ink-2,#6b5847)}
.nt-dot{width:7px; height:7px; border-radius:50%; background:var(--sage,#6f8468);
  animation:nt-blink 2.4s ease-in-out infinite}
@keyframes nt-blink{0%,100%{opacity:1}50%{opacity:.45}}
.nt-bar.nt-solo .nt-dot{background:var(--ink-3,#97836d); animation:none}
.nt-bar.nt-wait .nt-dot{background:var(--sun,#e0a44a)}
.nt-bar.nt-bad .nt-dot{background:var(--danger,#a8432f); animation:none}
.nt-bar.nt-bad{border-color:var(--danger,#a8432f)}
.nt-bar.nt-bad .nt-count{color:var(--danger,#a8432f)}
.nt-room{padding:8px 12px; font-size:var(--fs-1,11px); color:var(--ink-2,#6b5847);
  border-bottom:1px solid var(--hairline,rgba(90,68,48,.14)); letter-spacing:.04em}
.nt-room b{color:var(--ink,#2f2119); letter-spacing:.18em; font-size:var(--fs-3,13px)}
.nt-foot{padding:8px 12px; border-top:1px solid var(--hairline,rgba(90,68,48,.14))}
.nt-leave{width:100%; border:1px solid var(--danger,#a8432f); background:transparent;
  color:var(--danger,#a8432f); border-radius:var(--r-1,4px); padding:7px 10px;
  font:inherit; font-size:var(--fs-2,12px); cursor:pointer;
  transition:background var(--dur-1,120ms) cubic-bezier(.2,.7,.2,1)}
.nt-leave:hover{background:rgba(168,67,47,.10)}
.nt-count{color:var(--ink-2,#6b5847)}
.nt-bar button{border:1px solid var(--line,#d9cbb5); cursor:pointer; padding:5px 9px;
  border-radius:var(--r-1,4px); font:inherit; background:var(--paper-2,#ece3d3); color:var(--ink,#2f2119);
  transition:background var(--dur-1,120ms) cubic-bezier(.2,.7,.2,1)}
.nt-bar button:hover{background:var(--paper-3,#e0d5c1)}

/* 「屋里的人」面板：做成居中对话框，而不是贴在右下角的小挂件。
   之前贴在 right:20 bottom:70，正好压在小蓝鱼动作按钮上 —— 玩家想点动作，
   点到的是面板；面板又关不掉（见下面那条 [hidden]），只能刷新页面。
   现在：居中 + 遮罩 + 点遮罩/按 ESC/点 × 都能关。 */
.nt-backdrop{position:fixed; inset:0; z-index:25; background:rgba(47,33,25,.42)}
.nt-backdrop[hidden]{display:none !important}
.nt-panel{position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
  z-index:26; width:min(92vw,420px); max-height:min(78vh,620px);
  display:flex; flex-direction:column; border-radius:var(--r-3,16px); overflow:hidden;
  background:var(--paper,#f6f0e4); border:1px solid var(--line,#d9cbb5);
  box-shadow:var(--sh-3,0 18px 44px rgba(90,68,48,.20));
  font:var(--fs-2,12px)/1.6 var(--font-ui,"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif);
  color:var(--ink,#2f2119)}
/* hidden 必须能真的藏起来。上面那条 display:flex 的优先级高于浏览器自带的
   [hidden]{display:none}，结果 panelEl.hidden = true 完全没效果 —— 面板关不掉，
   一直压在房间上。所有带 display 的块都要有这一条兜底。 */
.nt-panel[hidden]{display:none !important}
.nt-head{display:flex; align-items:center; justify-content:space-between; padding:10px 12px;
  border-bottom:1px solid var(--hairline,rgba(90,68,48,.14))}
.nt-head b{font-size:var(--fs-3,13px); letter-spacing:.02em; color:var(--ink,#2f2119)}
.nt-close{border:0; background:transparent; color:var(--ink-2,#6b5847); font-size:var(--fs-5,19px);
  cursor:pointer; line-height:1}
.nt-list{list-style:none; margin:0; padding:8px 12px; border-bottom:1px solid var(--hairline,rgba(90,68,48,.14));
  max-height:150px; overflow:auto}
.nt-list li{display:flex; align-items:baseline; gap:6px; padding:3px 0; color:var(--ink-2,#6b5847)}
.nt-list li b{color:var(--ink,#2f2119); font-weight:600}
.nt-list li i{font-style:normal; font-size:var(--fs-1,11px); padding:1px 5px; border-radius:var(--r-1,4px);
  background:var(--clay-soft,rgba(210,113,74,.14)); color:var(--clay-deep,#af5235)}
.nt-list li span{margin-left:auto; font-size:var(--fs-1,11px); color:var(--ink-3,#97836d)}
.nt-list .nt-empty{color:var(--ink-3,#97836d)}
.nt-feed{padding:8px 12px; border-bottom:1px solid var(--hairline,rgba(90,68,48,.14));
  max-height:120px; overflow:auto; display:flex; flex-direction:column; gap:5px;
  font-size:var(--fs-1,11px)}
.nt-feed-item{display:flex; align-items:baseline; gap:8px; color:var(--ink-2,#6b5847)}
.nt-feed-item span{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.nt-feed-item i{font-style:normal; color:var(--ink-3,#97836d); font-size:var(--fs-1,11px); flex-shrink:0}
.nt-feed-mine span{color:var(--ink,#2f2119)}
.nt-talk{display:flex; flex-direction:column; min-height:0; flex:1}
.nt-msgs{flex:1; overflow:auto; padding:10px 12px; display:flex; flex-direction:column; gap:6px;
  font-size:var(--fs-2,12px)}
.nt-msg{max-width:86%; padding:6px 9px; border-radius:var(--r-2,10px); white-space:pre-wrap;
  word-break:break-word; line-height:1.55}
.nt-msg.nt-me{align-self:flex-end; background:var(--clay-soft,rgba(210,113,74,.14)); color:var(--ink,#2f2119)}
.nt-msg.nt-peer{align-self:flex-start; background:var(--paper-2,#ece3d3); color:var(--ink,#2f2119)}
.nt-msg.nt-sys{align-self:center; background:transparent; color:var(--ink-3,#97836d);
  font-size:var(--fs-1,11px); padding:2px 4px}
.nt-form{display:flex; gap:6px; padding:9px 12px; border-top:1px solid var(--hairline,rgba(90,68,48,.14))}
.nt-form input{flex:1; min-width:0; border:1px solid var(--line,#d9cbb5); border-radius:var(--r-1,4px);
  background:#fffdf7; color:var(--ink,#2f2119); padding:7px 9px; font:inherit}
.nt-form input:focus-visible{outline:2px solid var(--clay,#d2714a); outline-offset:2px}
.nt-form button{border:0; border-radius:var(--r-1,4px); background:var(--clay,#d2714a); color:#fffaf3;
  font:inherit; font-weight:600; padding:0 12px; cursor:pointer;
  transition:background var(--dur-1,120ms) cubic-bezier(.2,.7,.2,1)}
.nt-form button:hover{background:var(--clay-deep,#af5235)}
.nt-form button:disabled{opacity:.45; cursor:default}
.nt-side{display:flex; align-items:center; gap:8px; padding:9px 12px; font-size:var(--fs-2,12px);
  color:var(--ink-2,#6b5847); border-bottom:1px solid var(--hairline,rgba(90,68,48,.14))}
.nt-side b{color:var(--ink,#2f2119); font-weight:600}
.nt-side .nt-side-peer{color:var(--clay-deep,#af5235)}
.nt-side button{margin-left:auto; border:1px solid var(--line,#d9cbb5); cursor:pointer; padding:4px 9px;
  border-radius:var(--r-1,4px); font:inherit; font-size:var(--fs-1,11px);
  background:var(--paper-2,#ece3d3); color:var(--ink,#2f2119)}
.nt-side button:hover:not(:disabled){background:var(--paper-3,#e0d5c1)}
.nt-side button:disabled{opacity:.45; cursor:default}
.nt-ask{padding:10px 12px; font-size:var(--fs-1,11px); line-height:1.7; color:var(--ink,#2f2119);
  background:rgba(224,164,74,.14); border-bottom:1px solid var(--sun,#e0a44a)}
.nt-ask-btns{display:flex; gap:6px; margin-top:7px}
.nt-ask button{border:0; cursor:pointer; padding:5px 11px; border-radius:var(--r-1,4px); font:inherit;
  font-size:var(--fs-1,11px); background:var(--clay,#d2714a); color:#fffaf3; font-weight:600}
.nt-ask button.nt-no{background:var(--paper-3,#e0d5c1); color:var(--ink-2,#6b5847); font-weight:400}
.nt-ask button:hover{background:var(--clay-deep,#af5235); color:#fffaf3}
.nt-badge{display:inline-flex; align-items:center; gap:4px; padding:2px 7px; border-radius:999px;
  font-size:var(--fs-1,11px); background:var(--clay-soft,rgba(210,113,74,.14)); color:var(--clay-deep,#af5235)}
`;
