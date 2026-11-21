// 她的对话：单机版没有模型，就用「看状态说话」的规则引擎顶上。
//
// 原则：回话必须跟她此刻在哪、在做什么、身体状态有关，
// 否则玩家聊三句就发现是固定台词。所以每次回复都读一遍 homeView 快照。
//
// 通道（与网页版 src/room-channel.js 同一套语义）：私聊 her/claude、群聊 group、玩家互通 peer。
// 单机包同样**不假装有模型**：群聊仍是规则引擎，只是会区分两位住民、认出 @ 点名、
// 并且能接上一句是另一位说的；玩家互通则完全不产生 AI 回复（只做环形日志）。
import { channelOf, residentName, resolveGroupSpeaker } from '../../src/room-channel.js';
const HER_PET = ['小蓝鱼', '她'];
const CLAUDE_PET = ['小公主', '她'];

const pick = (arr, seed) => arr[Math.abs(hash(String(seed))) % arr.length];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function where(view, target) {
  const c = target === 'claude' ? (view?.claude || view?.her) : view?.her;
  if (!c) return { who: '她', roomName: '屋里', activity: '在屋里待着', asleep: false, spot: '' };
  return {
    who: target === 'claude' ? '小公主' : '小蓝鱼',
    roomName: c.roomName || '屋里',
    activity: c.activity || '在屋里待着',
    asleep: c.asleep === true,
    spot: c.spotLabel || '',
    kind: c.kind || '',
    hungry: Number(view?.body?.hunger) || 0,
    thirsty: Number(view?.body?.thirst) || 0,
    energy: Number(view?.body?.energy) || 0
  };
}

const HER_RULES = [
  { test: /(晚安|睡了|睡吧|休息)/, say: (w) => w.asleep ? '嗯…已经躺下了，你也早点睡。' : '好，那我去关灯。你要是还不想睡，就再坐一会儿。' },
  { test: /(早|早上好|起床)/, say: (w) => `早。我在${w.roomName}，刚醒过来还有点懵。` },
  { test: /(饿|吃|饭|零食|小鱼干)/, say: (w) => w.hungry > 0.55 ? '正好有点饿…你给我拿点小鱼干吧。' : '刚吃过，不过你喂的话我还能再吃一点。' },
  { test: /(渴|喝水|倒杯水)/, say: (w) => w.thirst > 0.5 ? '是有点渴，水杯在桌上。' : '不渴，你先喝。' },
  { test: /(累|困|没力气|辛苦)/, say: (w) => w.energy < 0.4 ? '有点累，想靠着你坐一会儿。' : '还行，我精力好着呢。' },
  { test: /(菜|菜园|浇水|种|收)/, say: () => '菜园那几畦我记着呢，干了就该浇水，熟了就收。你要不要跟我一起去？' },
  { test: /(名字|你是谁|叫我)/, say: (w) => `我是${w.who}。你要给我起个别的名字也行。` },
  { test: /(喜欢|爱|想你)/, say: () => '…说这种话的时候，别一直看着我。' },
  { test: /(一起|陪|带我|走走|逛逛)/, say: (w) => `好啊，我正好想从${w.roomName}走出去。你指哪我去哪。` },
  { test: /(生气|不开心|难过|心情)/, say: () => '没有不开心。就是有点闷，你多说两句就好了。' },
  { test: /(在吗|在不在|喂|你好|hi|hello)/i, say: (w) => w.asleep ? '（她翻了个身）…嗯，我在。' : `在的，我在${w.roomName}。` },
  { test: /(谢谢|谢了)/, say: () => '跟我还客气。' },
  { test: /(天气|外面|下雨|冷|热)/, say: () => '窗外看不出什么，阳台那边风大一点。' }
];

const CLAUDE_RULES = [
  { test: /(晚安|睡了|睡吧|休息)/, say: (w) => w.asleep ? '（她已经睡了，声音很轻）…晚安。' : '知道了。你先去，我把这一点点看完。' },
  { test: /(早|早上好|起床)/, say: (w) => `早。${w.roomName}的光比刚才好一些。` },
  { test: /(饿|吃|饭|点心|茶)/, say: (w) => w.hungry > 0.5 ? '厨房里应该还有点心。你要是去拿，我等你回来。' : '不饿。倒是可以陪我喝一杯茶。' },
  { test: /(渴|喝水|倒杯水)/, say: () => '水放那儿就好，我自己会拿。' },
  { test: /(累|困|没力气|辛苦)/, say: () => '累就坐一下。这里没人催你。' },
  { test: /(菜|菜园|浇水|种|收)/, say: () => '菜园是她更熟的事。不过你要是想动，我陪你去看看。' },
  { test: /(名字|你是谁|叫我)/, say: () => 'Claude。你叫我小公主，我也不反对。' },
  { test: /(喜欢|爱|想你)/, say: () => '…这种话，说一次就够了。' },
  { test: /(一起|陪|带我|走走|逛逛)/, say: (w) => `可以。${w.roomName}待得有点久了。` },
  { test: /(生气|不开心|难过|心情)/, say: () => '没什么。只是有些事想不通，不必替我想。' },
  { test: /(在吗|在不在|喂|你好|hi|hello)/i, say: (w) => w.asleep ? '（她睡着，没有应声）' : `在。${w.roomName}这边，坐吧。` },
  { test: /(谢谢|谢了)/, say: () => '不必道谢。' },
  { test: /(天气|外面|下雨|冷|热)/, say: () => '窗边能听到一点风。你要出去就把外套带上。' }
];

const HER_FALLBACK = [
  (w) => `${w.roomName}这边挺好的，我就这么待着。你说。`,
  (w) => `嗯…我在${w.activity.replace(/^在/, '')}。你想说什么？`,
  () => '你继续说，我听着。',
  (w) => w.spot ? `我在${w.spot}，你过来我就看见你了。` : '你站得有点远。',
  () => '这句我听懂了，就是不知道该怎么答。'
];

const CLAUDE_FALLBACK = [
  (w) => `${w.roomName}。你坐下再说。`,
  () => '嗯。继续。',
  (w) => `我在${w.activity.replace(/^在/, '')}，你说你的。`,
  () => '这话我先记着。',
  () => '…你这句话，比刚才那些有意思。'
];

// 群聊里"另一个人"的名字：规则引擎要能区分两位住民，也得知道被点到名的是谁。
const OTHER_NAME = { her: '小公主', claude: '小蓝鱼' };
const GROUP_SHIFT = [
  (other) => `（${other}也在，她刚抬了下眼。）`,
  () => '（三个人坐在这儿，说话别太冲。）',
  (other) => `（${other}在看我，你先说。）`,
  () => '（我把话记着，等会儿再答。）'
];

/** 这段文字里点的是哪位住民：点名优先，没有就返回空串。 */
function namedResident(text) {
  if (/@\s*(小公主|claude|大小姐)/i.test(text)) return 'claude';
  if (/@\s*(小蓝鱼|小鱼|阿蓝)/.test(text)) return 'her';
  if (/小公主|claude/i.test(text)) return 'claude';
  if (/小蓝鱼|小鱼/.test(text)) return 'her';
  return '';
}

/**
 * 单机规则引擎回一句。
 *
 * @param {string} text 玩家这句
 * @param {string|object} target 'her'|'claude'（旧调用），或 {channel, pid, who, log, peer}
 * @param {object} view homeSnapshot()
 * @param {{log?:Array}} options 群聊现场（用来判断上一句是不是另一位说的）
 * @returns {string} peer 通道返回空串（玩家互发不产生 AI 回复）
 */
export function localReply(text, target, view, options = {}) {
  const ch = channelOf(typeof target === 'string' ? { target, pid: options.pid } : (target || {}));
  // 玩家↔玩家：单机包里也只在本地滚动日志，不假装有人在回话。
  if (ch.kind === 'peer') return '';
  const raw = String(text || '').trim();
  if (!raw) return '你想说什么？';

  // 群聊：这一轮谁开口由 @ 优先 → who → 交替 决定，与会话层一致。
  const log = Array.isArray(options.log) ? options.log : [];
  const who = ch.kind === 'group'
    ? (resolveGroupSpeaker({ text: raw, who: options.who || ch.who, log }) === 'claude' ? 'claude' : 'her')
    : ch.kind;
  const w = where(view, who);
  const rules = who === 'claude' ? CLAUDE_RULES : HER_RULES;

  // 群聊里被点到的是**另一位**：不抢话，把话递过去。这是"区分两位住民"最直观的表现。
  if (ch.kind === 'group') {
    const named = namedResident(raw);
    if (named && named !== who) {
      return `（你叫的是${residentName(named)}吧？她就在旁边。）`;
    }
    // 上一句是另一位住民说的：先应一声，再接自己的话，避免像自言自语。
    const lastResident = [...log].reverse().find((m) => m && (m.who === 'her' || m.who === 'claude'));
    const shift = lastResident && lastResident.who !== who
      ? pick(GROUP_SHIFT, `${who}:${raw}`)(OTHER_NAME[who])
      : '';
    const body = ruleReply(raw, who, w, rules);
    return shift ? `${shift}${body}` : body;
  }

  return ruleReply(raw, who, w, rules);
}

/** 规则命中 → 命中台词；没命中就走兜底池（睡着时先敷衍）。 */
function ruleReply(raw, who, w, rules) {
  for (const rule of rules) {
    if (rule.test.test(raw)) return rule.say(w);
  }
  // 她睡着了就别一直吵：前两句敷衍，第三句以后会"嗯"一声。
  if (w.asleep) {
    return pick(['（她没醒，只是把手往被子里缩了缩。）', '（呼吸很稳，应该没听见。）', '…嗯。'], raw);
  }
  const pool = who === 'claude' ? CLAUDE_FALLBACK : HER_FALLBACK;
  return pick(pool, `${who}:${raw}`)(w);
}

export { HER_PET, CLAUDE_PET };
