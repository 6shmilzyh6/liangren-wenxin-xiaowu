// 作弊码：给评委、给演示、给「我就想看看结局」的玩家一条快路。
//
// 设计约束（很重要，不然会毁掉养成）：
//   · 只在控制台敲，不在 UI 上放按钮 —— 这是后门，不是功能；
//   · 每条码只写它该写的那一层：xp 走 profile、金币走 garden、她俩的状态走 home，
//     不跨层乱写，免得下一次正常结算把值又算回去；
//   · 写完之后统一走 resolveUnlocks / tick，让等级、成就、技能跟上；
//   · 每条都留一行日志，方便演示时讲「我用了哪个码」。
//
// 码的命名跟着角色走，不用 give_me_1000 这种通用词：
//   yu-full        亲密度拉满（小蓝鱼 + 小公主）
//   yu-level N     等级直接到 N（1..40）
//   yu-coins N     菜园金币
//   yu-live N      在线时长，N 是分钟
//   yu-all         全都要（演示用）
//   yu-reset       把作弊改过的值清回初始（成就保留）
//   yu-help        列出来

import { profile } from './profile.js';
import { cheatGarden, cheatGrowth, cheatTogether } from '../engine/home-engine.js';
// 等级曲线只认 progress.json 这一份：这里抄一遍常数，改配置时就会悄悄不同步。
import progressConfig from '../../assets/data/progress.json' with { type: 'json' };

const MAX_LEVEL = Number(progressConfig.levelCurve?.max) || 40;

/** 从 progress.json 的曲线算「到第 n 级需要的总经验」，与 profile.js 的 levelOf 同源。 */
function totalXpToLevel(n) {
  const base = Number(progressConfig.levelCurve?.base) || 120;
  const step = Number(progressConfig.levelCurve?.step) || 60;
  const cap = Math.max(1, Math.min(MAX_LEVEL, Math.floor(Number(n) || 1)));
  let sum = 0;
  for (let k = 1; k < cap; k += 1) sum += base + step * (k - 1);
  return sum;
}

const REGISTRY = {
  'yu-help': {
    desc: '列出所有作弊码',
    run() {
      const lines = Object.entries(REGISTRY).map(([k, v]) => `  ${k.padEnd(14)} ${v.desc}`);
      return `可用的码：\n${lines.join('\n')}`;
    }
  },
  'yu-full': {
    desc: '亲密度拉满（小蓝鱼与小公主都到 100）',
    run() {
      // 两份都要写：页面上的「和她」读 home-state 的 growth，
      // 而面板/成就读 profile 的 aff。只改一份会出现「说拉满了，界面还是 0」。
      profile.cheat({ aff: { her: 100, claude: 100 } });
      cheatGrowth({ intimacy: 100 });
      return '亲密度已拉满：小蓝鱼 100 · 小公主 100';
    }
  },
  'yu-level': {
    desc: '等级直接到 N（用法：yu-level 30）',
    run(arg) {
      const n = Math.max(1, Math.min(MAX_LEVEL, Math.floor(Number(arg) || 0)));
      if (!n) return '用法：yu-level 30（1 到 40）';
      const total = totalXpToLevel(n);
      const out = profile.cheat({ xp: total });
      // 等级也要写进 home-state，否则「和她」那栏的段位不变（它读的是 growth）。
      cheatGrowth({ xp: total });
      return `等级已设为 ${out.level}（累计经验 ${out.xp}）`;
    }
  },
  'yu-coins': {
    desc: '菜园金币设为 N（用法：yu-coins 999）',
    run(arg) {
      const n = Math.max(0, Math.floor(Number(arg) || 0));
      if (!Number.isFinite(n)) return '用法：yu-coins 999';
      const g = cheatGarden({ coins: n, compost: 99 });
      return `菜园金币 ${g.coins}，堆肥 ${g.compost}`;
    }
  },
  'yu-live': {
    desc: '在线时长设为 N 分钟（用法：yu-live 600）',
    run(arg) {
      const min = Math.max(0, Math.floor(Number(arg) || 0));
      if (!min) return '用法：yu-live 600（分钟）';
      const out = profile.cheat({ livedMs: min * 60_000 });
      const h = (out.livedMs / 3600_000).toFixed(1);
      return `在线时长已设为 ${min} 分钟（${h} 小时）`;
    }
  },
  'yu-all': {
    desc: '全都要：满级、满亲密度、金币、时长（演示用）',
    run() {
      const xp = totalXpToLevel(MAX_LEVEL);
      const out = profile.cheat({ xp, aff: { her: 100, claude: 100 }, livedMs: 100 * 3600_000, streak: 30 });
      cheatGrowth({ xp, intimacy: 100, wallet: { whale: 200, token: 200 } });
      const g = cheatGarden({ coins: 999, compost: 99 });
      return [
        `等级 ${out.level}（累计经验 ${out.xp}）`,
        `亲密度 小蓝鱼 ${out.aff.her} · 小公主 ${out.aff.claude}`,
        `在线 ${(out.livedMs / 3600_000).toFixed(0)} 小时，签到 30 天`,
        `菜园金币 ${g.coins}，堆肥 ${g.compost}`,
        '鲸元券 200 · tokens 200（礼物栏里可以递了）'
      ].join('\n');
    }
  },
  'yu-together': {
    desc: '同行点数直接给 N 点（演示小柜子用，默认 20）',
    run(arg) {
      const n = Math.max(0, Math.floor(Number(arg) || 20));
      const state = cheatTogether({ points: n });
      const tg = state?.together || {};
      return `同行点数 ${tg.points ?? n} 点（一起待过 ${((tg.totalMs || 0) / 3600_000).toFixed(1)} 小时）`;
    }
  },
  'yu-wallet': {
    desc: '两种货币直接给 N 点（演示礼物栏用，默认 40）',
    run(arg) {
      const n = Math.max(0, Math.floor(Number(arg) || 40));
      const state = cheatGrowth({ wallet: { whale: n, token: n } });
      const wallets = state?.her?.growth?.wallet?.currencies || [];
      const txt = wallets.map((w) => `${w.label} ${w.amount}`).join(' · ');
      return txt || `鲸元券 ${n} · tokens ${n}`;
    }
  },
  'yu-gift': {
    desc: '把礼物清空再按亲密度重发一遍（演示货架用；只发当前门槛内的随手档）',
    run() {
      // 只发 casual 档：一次演示不需要 19 件全塞进背包，
      // 而且要留一半让人看到「攒够才给」这件事。
      cheatGrowth({ clearBought: true, inventory: 'clear' });
      const state = cheatGrowth({ wallet: { whale: 200, token: 200 } });
      const offers = state?.her?.growth?.offers || [];
      const casual = offers.filter((o) => o.tier === 'casual' && o.unlocked);
      return `货架上可以给的随手档 ${casual.length} 件：${casual.map((o) => o.name).join(' / ') || '（先涨亲密度）'}\n两种货币各 200 点，去「礼物」栏点一下就能递。`;
    }
  },
  'yu-reset': {
    desc: '把作弊改过的值清回初始（经验/亲密度/金币归零，成就保留）',
    run() {
      profile.cheat({ xp: 0, aff: { her: 0, claude: 0 }, livedMs: 0, streak: 0 });
      cheatGrowth({ xp: 0, intimacy: 0, wallet: { whale: 0, token: 0 } });
      cheatGarden({ coins: 36, compost: 3 });
      return '已清回初始值（成就与便签保留）';
    }
  }
};

/** 从 progress.json 的曲线算「到第 n 级需要的总经验」。 */

/**
 * 执行一条码。返回一段给人看的文字（成功或用法说明）。
 * 不认识就返回 null，让调用方决定怎么提示。
 */
export function runCheat(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const [cmd, ...rest] = raw.split(/\s+/);
  const entry = REGISTRY[cmd.toLowerCase()];
  if (!entry) return null;
  try {
    return entry.run(rest.join(' '));
  } catch (err) {
    return `这条码出错了：${err?.message || err}`;
  }
}

export function cheatHelp() {
  return REGISTRY['yu-help'].run();
}

export const CHEAT_NAMES = Object.keys(REGISTRY);
