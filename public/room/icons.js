// 内联 SVG 图标集：替代原来散在各处的 emoji。
//
// 为什么不用 emoji：
//   1. 字形由系统字体决定，Windows / macOS / 安卓是三套完全不同的画风，
//      同一张界面在不同机器上长得不一样，"太 AI"的塑料感主要来自这里；
//   2. emoji 自带固定色，跟纸/陶/木这套皮肤的墨色对不上；
//   3. 尺寸不可控，混在 11px 的字里会撑行高。
//
// 这里全部是 24×24 线稿，stroke=currentColor，所以：
//   - 颜色跟着父元素走（放在 .chip 里就是墨色，放在赤陶按钮上就是白）；
//   - 大小跟着 font-size 走（skin-desk.css 里给 svg 设了 width:1em / height:1em）；
//   - 想要某个作物显示自己的颜色时，给容器设 style="color:#...".

const PATHS = {
  // ── 导航 / 动作 ───────────────────────────────────────────────
  sprout: '<path d="M12 21v-7"/><path d="M12 14c0-3.3-2.7-6-6-6 0 3.3 2.7 6 6 6Z"/><path d="M12 14c0-3.9 3.1-7 7-7 0 3.9-3.1 7-7 7Z"/>',
  gate: '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M15 12h.01"/><path d="M9 3.5v17"/>',
  game: '<rect x="3" y="14" width="18" height="4" rx="1"/><circle cx="12" cy="6.5" r="2.5"/><path d="M12 9v5"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  chat: '<path d="M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.42L4 20l1.2-3.3C4.4 15.6 4 14.1 4 12.5 4 8.9 7.6 6 12 6s8 2.9 8 6.5Z"/>',
  screen: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M9 21h6"/><path d="M12 17v4"/><path d="M7.5 11.5c1.2-1.4 2.4-1.4 3.6 0s2.4 1.4 3.6 0"/>',
  fish: '<path d="M3 12c2.6-3.6 5.8-5.4 9.6-5.4 3.4 0 6.2 2.1 8.4 5.4-2.2 3.3-5 5.4-8.4 5.4C8.8 17.4 5.6 15.6 3 12Z"/><path d="M6.6 12h.01"/><path d="M3 12 1.5 8.8"/><path d="M3 12 1.5 15.2"/>',
  crown: '<path d="M4 18h16"/><path d="M4 18 3 8l4.5 3.5L12 6l4.5 5.5L21 8l-1 10"/>',
  house: '<path d="M4 11 12 4l8 7"/><path d="M6.5 9.6V20h11V9.6"/><path d="M10 20v-5h4v5"/>',
  server: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M7.5 7h.01"/><path d="M7.5 17h.01"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  furrow: '<path d="M3 9c2 0 2-1.5 4-1.5S9 9 11 9s2-1.5 4-1.5S17 9 19 9s2-1.5 2-1.5"/><path d="M3 15c2 0 2-1.5 4-1.5S9 15 11 15s2-1.5 4-1.5S17 15 19 15s2-1.5 2-1.5"/>',
  seed: '<path d="M12 19c0-4.4 2.6-8 6-8 0 4.4-2.6 8-6 8Z"/><path d="M12 19c0-3-1.9-5.4-4.5-5.4 0 3 1.9 5.4 4.5 5.4Z"/><path d="M12 19v2"/>',

  // ── 绘本封面 / 菜园零碎 ──────────────────────────────────────
  shell: '<path d="M12 21c-4.4 0-8-3.6-8-8 0-1.4 2.2-4.5 3.3-6.5.4-.7 1.4-.7 1.8 0 .7 1.2 1.7 2.6 2.9 3.3.7.4 1.5-.2 1.3-1C12.8 5.6 11.5 3.6 12 3c.6-.6 2.6.7 3.5 2.2.9 1.5 1.2 3 1 4.6-.1 1 .9 1.6 1.7 1.1 1.1-.7 2-1.9 2.6-3 .4-.8 1.5-.7 1.8.1 1.1 2.2 2.4 4.6 2.4 6.2 0 4.4-3.6 7.8-8 7.8Z"/><path d="M12 21v-8"/><path d="M9 12.5 12 15l3-2.5"/>',
  cloud: '<path d="M7.5 18.5A4.5 4.5 0 0 1 7 9.6a5.5 5.5 0 0 1 10.4-1.2A4 4 0 0 1 17 18.5Z"/><path d="M9.5 21h5"/>',
  star: '<path d="m12 4 2.5 5.2 5.5.8-4 3.9.95 5.6L12 16.8 7.05 19.5 8 13.9 4 10l5.5-.8Z"/>',
  lamp: '<path d="M8 9h8l2 10H6Z"/><path d="M12 9V4"/><path d="M9.5 4h5"/><path d="M9 6.5h6"/>',
  island: '<path d="M3 17c2.5 1.4 5 1.4 7.5 0S16 15.6 21 17"/><path d="M7 17V9"/><path d="M7 9c-1.6-1-2.4-2-2.4-3 1.6 0 2.6.6 3.4 1.6"/><path d="M7 9c1.6-.8 3-1.2 4.4-1.4-.6 1.4-1.6 2.4-3 3"/><path d="M17 17v-3"/>',
  leaf: '<path d="M20 4c0 8-4.6 12.5-10.5 12.5H5C5 8.5 10.5 4 20 4Z"/><path d="M5 20c1.6-5.4 5-9.4 10-12"/>',

  // ── 12 种作物：只靠轮廓区分，不靠颜色 ─────────────────────────
  radish: '<path d="M12 21c-2.6-3-4-5.6-4-8a4 4 0 0 1 8 0c0 2.4-1.4 5-4 8Z"/><path d="M12 9V4"/><path d="M12 5.5 9 3.5"/><path d="M12 5.5 15 3.5"/>',
  carrot: '<path d="M12.5 20.5 6 14c2.6-2.6 5.2-4 7.5-4 1.6 0 3 .9 3 3 0 2.3-1.7 4.9-4 7.5Z"/><path d="M13.5 10 17 6.5"/><path d="M15.5 8.5 19.5 8"/><path d="M17 6.5 16.5 2.5"/>',
  lettuce: '<path d="M12 20c-4.4 0-8-2.9-8-6.5S7.6 7 12 7s8 2.9 8 6.5S16.4 20 12 20Z"/><path d="M8 13.5c1.2-1.5 2.4-1.5 4 0s2.8 1.5 4 0"/>',
  tomato: '<path d="M12 20c-3.9 0-7-2.7-7-6s3.1-6 7-6 7 2.7 7 6-3.1 6-7 6Z"/><path d="M9.5 8.4 12 5.5l2.5 2.9"/><path d="M12 5.5V3"/>',
  cucumber: '<path d="M5 19c-1.7-1.7-1.7-4.4 0-6.1L13 5c1.7-1.7 4.4-1.7 6.1 0s1.7 4.4 0 6.1L11 19c-1.7 1.7-4.4 1.7-6 0Z"/><path d="M9 15h.01"/><path d="M12 12h.01"/><path d="M15 9h.01"/>',
  eggplant: '<path d="M12 20.5c-3.6 0-6.5-2.4-6.5-5.6 0-3.4 3-6.4 6.5-6.4s6.5 3 6.5 6.4c0 3.2-2.9 5.6-6.5 5.6Z"/><path d="M9.5 8.5 12 5.5l2.5 3"/><path d="M12 5.5V3"/>',
  pepper: '<path d="M12 20.5c-3.3 0-6-2.9-6-6.5 0-3 2-5 6-5s6 2 6 5c0 3.6-2.7 6.5-6 6.5Z"/><path d="M12 9V6"/><path d="M12 6c1.8 0 3-1 3-2.5"/>',
  pumpkin: '<path d="M12 20.5c-3.6 0-6.5-3-6.5-6.7S8.4 7 12 7s6.5 3 6.5 6.8-2.9 6.7-6.5 6.7Z"/><path d="M12 7V4"/><path d="M12 7c-1.6 1.6-2.4 4-2.4 6.8s.8 5.2 2.4 6.7"/>',
  corn: '<path d="M12 21c-7.4 0-8.5-5-8.5-5L12 4l8.5 12S19.4 21 12 21Z"/><path d="M8 16.5h8"/><path d="M9.5 12h5"/>',
  strawberry: '<path d="M12 21c-3.3-2.6-5.5-5.4-5.5-8.2A3.3 3.3 0 0 1 12 10a3.3 3.3 0 0 1 5.5 2.8C17.5 15.6 15.3 18.4 12 21Z"/><path d="M9 10 12 6.5 15 10"/><path d="M12 10.5h.01"/>',
  potato: '<path d="M12.5 20c-4.4 0-8-2.7-8-6.4 0-3.3 2.4-5.9 5.6-6.7 3.6-.9 7.1 1.1 8.4 4.4 1.4 3.6-1.2 8.7-6 8.7Z"/><path d="M9.5 12h.01"/><path d="M13 15h.01"/>',
  cabbage: '<circle cx="12" cy="13" r="6.5"/><path d="M12 6.5c-2.4 2-3.6 4.4-3.6 6.9 0 2.2.9 4.2 2.6 5.9"/><path d="M12 6.5c2.4 2 3.6 4.4 3.6 6.9 0 2.2-.9 4.2-2.6 5.9"/>'
};

/** 返回一段 SVG 字符串。未知 id 退化成 sprout，不抛错。 */
export function iconSvg(id, extraClass = '') {
  const body = PATHS[id] || PATHS.sprout;
  const cls = extraClass ? ` class="${extraClass}"` : '';
  return `<svg${cls} viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** 造一个可插入 DOM 的图标节点。 */
export function iconNode(id, className = 'ico') {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = iconSvg(id);
  return span;
}

/**
 * 把「图标 + 文字」写进一个已经存在的元素（按钮、chip）。
 * 原来这些按钮是直接把"图标字符 + 文字"塞进 textContent 的，
 * 换成 SVG 之后再这么写会把图标节点一起抹掉，
 * 所以统一走这里：replaceChildren 保证图标不会被重复叠加。
 */
export function setIconLabel(node, id, text) {
  if (!node) return;
  node.replaceChildren(iconNode(id, 'btn-ico'), document.createTextNode(text ? ` ${text}` : ''));
}

export const ICON_IDS = Object.freeze(Object.keys(PATHS));
