// esbuild 插件：为 file:// 运行环境做一处编译期适配。
//
// 为什么必须改 app.js 的这一行：
//   file:// 页面的 location.origin 是字符串 "null"，
//   new URL('/api/home/state', 'null') 会抛 TypeError，于是 app.js 里每个
//   api('/api/...') 都构造失败，表现层一次请求也发不出去。
//   把基准 origin 换成一个常驻的占位 origin，请求就能正常构造，
//   最终由 shell/net-shim.js 按 pathname 接走 —— 等价于同源请求。
//
// 除此之外 app.js 一个字节都不动。
import { readFile } from 'node:fs/promises';

const HEAD = `// [game] 注入：file:// 下 location.origin === 'null'，给 URL 一个可解析的基准。
const __GAME_ORIGIN__ = (() => { const o = location.origin; return !o || o === 'null' ? 'http://game.local' : o; })();`;

const TARGET = "new URL(BASE_PATH && path.startsWith('/') ? BASE_PATH + path : path, location.origin)";
const PATCHED = "new URL(BASE_PATH && path.startsWith('/') ? BASE_PATH + path : path, __GAME_ORIGIN__)";

export function gameAdaptPlugin() {
  return {
    name: 'game-adapt',
    setup(build) {
      build.onLoad({ filter: /public[\\/]room[\\/]app\.js$/ }, async (args) => {
        const raw = await readFile(args.path, 'utf8');
        if (!raw.includes(TARGET)) {
          throw new Error('app.js 里 api() 的 URL 构造方式变了，请同步更新 game-src/build-plugins.mjs');
        }
        const next = `${HEAD}\n${raw.replace(TARGET, PATCHED)}`;
        return { contents: next, loader: 'js' };
      });
    }
  };
}
