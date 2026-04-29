/*
  Rule-based translator for ze_best_guess/quiz.js question strings.

  Scope:
  - Only edits lines within a given 1-based inclusive range.
  - Only translates the inner content of q:"..." and text:"...".
  - Leaves answers/correct/wrong and other strings untouched.
  - Preserves abbreviations/symbols/proper nouns by default (keeps captured phrases).
  - Ensures punctuation uses ASCII/English forms.

  Usage:
    node tools/translate_quiz_questions.js e:\Github\cs_script\2001\ze_best_guess\quiz.js 501 6656
    node tools/translate_quiz_questions.js <file> <startLine> <endLine> --dry
*/

const fs = require("fs");

function normalizeEnglishPunct(text) {
  return text
    .replace(/…/g, "...")
    .replace(/’/g, "'")
    .replace(/“|”/g, '"')
    .replace(/，/g, ",")
    .replace(/。/g, ".")
    .replace(/？/g, "?")
    .replace(/！/g, "!")
    .replace(/：/g, ":")
    .replace(/；/g, ";")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/【/g, "[")
    .replace(/】/g, "]")
    .replace(/、/g, ",")
    .replace(/《/g, '"')
    .replace(/》/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function tightenCJKSpacing(text) {
  // Remove awkward spaces around common Chinese particles and between CJK/ASCII.
  return String(text)
    .replace(/\s*的\s*/g, "的")
    .replace(/\s*是\s*/g, "是")
    .replace(/\s*在\s*/g, "在")
    .replace(/\s*有\s*/g, "有")
    .replace(/\s*和\s*/g, "和")
    .replace(/\s*或\s*/g, "或")
    .replace(/\s*与\s*/g, "与")
    .replace(/([\u4e00-\u9fff])\s+([A-Za-z0-9])/g, "$1$2")
    .replace(/([A-Za-z0-9])\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/\s+([?!.:,;\)\]])/g, "$1")
    .replace(/([\(\[])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingThe(phrase) {
  return phrase.replace(/^the\s+/i, "");
}

function looksLikeAbbreviationOrSymbol(token) {
  // Keep things like CO2, H2O, WWII, HTTP, RGB, m/s, 90°, π, NaCl
  return (
    /[0-9]/.test(token) ||
    /[\/°π√≈]/.test(token) ||
    /^[A-Z]{2,}([-.][A-Z0-9]+)*$/.test(token) ||
    /^[A-Z][a-z]+\.[A-Z]/.test(token) ||
    token.includes(".")
  );
}

const PHRASE_MAP = [
  // Multi-word phrases first (case-insensitive)
  ["land animal", "陆地动物"],
  ["hot desert", "热沙漠"],
  ["solar system", "太阳系"],
  ["rising sun", "日出之国"],
  ["red planet", "红色星球"],
  ["double helix", "双螺旋"],
  ["white blood cells", "白细胞"],
  ["atomic number", "原子序数"],
  ["air pressure", "气压"],
  ["light speed", "光速"],
  ["right angle", "直角"],
  ["adult teeth", "恒牙"],
  ["great wall", "长城"],
  ["dead sea", "死海"],
  ["great barrier reef", "大堡礁"],
  ["largest ocean", "最大的海洋"],
  ["largest planet", "最大的行星"],
  ["fastest land animal", "最快的陆地动物"],
  ["tallest mountain", "最高的山"],
  ["tallest animal", "最高的动物"],
  ["largest mammal", "最大的哺乳动物"],
  ["smallest prime", "最小的质数"],
  ["noble gas", "惰性气体"],
  ["table salt", "食盐"],
  ["unit si", "SI单位"],
  ["main air gas", "空气中主要成分"],
  ["planet with rings", "有光环的行星"],
  ["plant food process", "植物制造养分的过程"],
  ["space viewer", "观测太空的工具"],
  ["weather study", "研究天气的学科"],
  ["cell division", "细胞分裂"],
  ["fossil study", "研究化石的学科"],
  ["quake measure", "测量地震的仪器"],
  ["quake study", "研究地震的学科"],
  ["fish breathe", "鱼用什么呼吸"],
  ["bones in adult", "成年人骨骼数量"],
  ["planets in", "行星数量在"],
  ["answer in", "在...内作答"],
];

const WORD_MAP = {
  // Common nouns
  planet: "行星",
  ocean: "海洋",
  mountain: "山",
  river: "河",
  continent: "大陆",
  island: "岛",
  desert: "沙漠",
  mammal: "哺乳动物",
  animal: "动物",
  bird: "鸟类",
  cat: "猫科动物",
  country: "国家",
  language: "语言",
  currency: "货币",
  symbol: "符号",
  organ: "器官",
  gas: "气体",
  bone: "骨头",
  bones: "骨头",
  legs: "条腿",
  leg: "条腿",
  arms: "条手臂",
  arm: "条手臂",
  author: "作者",
  writer: "作者",
  painter: "画家",
  discoverer: "发现者",
  inventor: "发明者",
  capital: "首都",
  water: "水",
  heart: "心脏",
  lungs: "肺",
  liver: "肝脏",
  skull: "头骨",
  moon: "月球",
  sun: "太阳",
  plants: "植物",
  plant: "植物",
  honey: "蜂蜜",
  gold: "黄金",
  iron: "铁",
  silver: "银",
  salt: "盐",
  bone: "骨头",
  adult: "成年人",
  african: "非洲",
  europe: "欧洲",
  asia: "亚洲",
  america: "美洲",
  prime: "质数",
  natural: "天然的",
  land: "陆地",
  hot: "热",
  red: "红色",
  rising: "日出",
  absorb: "吸收",
  from: "来自",
  in: "在",
  on: "在",
  at: "在",
  of: "的",
  to: "到",
  with: "与",
  for: "为",

  // Function words / auxiliaries
  what: "什么",
  who: "谁",
  where: "哪里",
  when: "何时",
  why: "为什么",
  how: "如何",
  many: "许多",
  which: "哪个",
  does: "",
  do: "",
  did: "",
  are: "是",
  is: "是",
  was: "是",
  were: "是",
  has: "有",
  have: "有",
  had: "有",
  a: "",
  an: "",
  the: "",
  as: "为",

  // Common verbs
  eat: "吃",
  feed: "进食",
  live: "生活",
  build: "建造",
  communicate: "交流",
  help: "帮助",
  navigate: "导航",
  detect: "探测",
  move: "移动",
  turn: "变",
  migrate: "迁徙",
  turns: "变",
  helps: "有助于",
  help: "帮助",
  undergoes: "经历",
  undergo: "经历",
  lays: "产",
  lay: "产",
  found: "发现于",
  native: "原产于",
  classified: "归类为",

  // Common adverbs/adjectives
  mainly: "主要",
  primarily: "主要",
  actually: "实际上",
  sometimes: "有时",
  often: "经常",
  practical: "实用",
  living: "现存",
  large: "大型",
  mainly: "主要",
  primarily: "主要",
  generally: "通常",
  typically: "通常",
  only: "仅",
  together: "一起",
  like: "例如",
  using: "使用",
  via: "通过",
  mostly: "主要是",
  by: "按",

  // More common nouns
  height: "高度",
  lizard: "蜥蜴",
  earth: "地球",
  shark: "鲨鱼",
  insect: "昆虫",
  spider: "蜘蛛",
  birds: "鸟类",
  bird: "鸟类",
  fish: "鱼类",
  dolphins: "海豚",
  dolphin: "海豚",
  lions: "狮子",
  lion: "狮子",
  wolves: "狼",
  wolf: "狼",
  crows: "乌鸦",
  crow: "乌鸦",
  bees: "蜜蜂",
  bee: "蜜蜂",
  rabbits: "兔子",
  rabbit: "兔子",
  beavers: "海狸",
  beaver: "海狸",
  pandas: "熊猫",
  panda: "熊猫",
  koalas: "考拉",
  koala: "考拉",
  vultures: "秃鹫",
  vulture: "秃鹫",
  hummingbirds: "蜂鸟",
  hummingbird: "蜂鸟",
  whales: "鲸",
  whale: "鲸",
  sharks: "鲨鱼",
  penguin: "企鹅",
  penguins: "企鹅",
  animals: "动物",
  active: "活动",
  giant: "大",
  baleen: "须鲸",
  orcas: "虎鲸",
  orca: "虎鲸",
  manatees: "海牛",
  manatee: "海牛",
  flightless: "不会飞的",
  pouch: "育儿袋",
  carry: "携带",
  scales: "鳞片",
  leathery: "革质的",
  larva: "幼虫",
  metamorphosis: "变态发育",
  crustaceans: "甲壳类",
  aquatic: "水生",
  environments: "环境",
  squid: "鱿鱼",
  octopus: "章鱼",
  starfish: "海星",
  jellyfish: "水母",
  bodies: "身体",
  camouflage: "伪装",
  mimicry: "拟态",
  hibernation: "冬眠",
  arctic: "北极",
  foxes: "狐狸",
  zebra: "斑马",
  zebras: "斑马",
  stripes: "条纹",
  elephants: "大象",
  elephant: "大象",
  trunks: "象鼻",
  trunk: "象鼻",
  neck: "脖子",
  tail: "尾巴",
  predator: "捕食者",
  predators: "捕食者",
  pollinators: "传粉者",

  // Common topic words
  group: "一群",
  baby: "幼年",
  babies: "幼年",
  direction: "方向",
  food: "食物",
  night: "夜间",
  dawn: "黎明",
  dusk: "黄昏",
  diet: "食物",
  use: "用途",
  eggs: "卵",
  egg: "卵",
  young: "幼崽",
  // Common verbs / helpers
  means: "是什么意思",
  called: "被称为",
  term: "术语",
  main: "主要",
  largest: "最大的",
  smallest: "最小的",
  fastest: "最快的",
  tallest: "最高的",
  hardest: "最硬的",
  longest: "最长的",
  closest: "最近的",
  deepest: "最深的",
  hottest: "最热的",
  freezes: "凝固",
  boils: "沸腾",
};

const EXACT_QUESTION_MAP = new Map(
  Object.entries({
    // Keep these as full, natural Chinese questions.
    "Plants absorb": "植物吸收什么",
    "Plants absorb?": "植物吸收什么?",
    "Most native speakers": "母语使用者最多的是哪种语言",
    "Most native speakers?": "母语使用者最多的是哪种语言?",
    "Hardest natural": "最硬的天然物质是什么",
    "Hardest natural?": "最硬的天然物质是什么?",
    "Red Planet": "红色星球是哪个行星",
    "Red Planet?": "红色星球是哪个行星?",
    "Planets in Solar System": "太阳系中有多少颗行星",
    "Planets in Solar System?": "太阳系中有多少颗行星?",
    "Land of Rising Sun": "日出之国指的是哪个国家",
    "Land of Rising Sun?": "日出之国指的是哪个国家?",
  })
);

function applyMaps(text) {
  // Phrase map must run before word map to avoid breaking multi-word patterns.
  return applyWordMap(applyPhraseMap(text));
}

function applyPhraseMap(text) {
  let out = String(text);
  for (const [from, to] of PHRASE_MAP) {
    const re = new RegExp(`\\b${from.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "gi");
    out = out.replace(re, to);
  }
  return out;
}

function applyWordMap(text) {
  // Replace common English words that should not remain in translated questions.
  // Avoid changing abbreviations/symbol-like tokens.
  return String(text).replace(/[A-Za-z][A-Za-z'\-]*/g, (w) => {
    if (looksLikeAbbreviationOrSymbol(w)) return w;
    const key = w.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(WORD_MAP, key)) return WORD_MAP[key];
    return w;
  });
}

function translateVerbPhrase(phrase) {
  // Keep core noun phrases as-is; translate the scaffolding.
  let p = phrase.trim();

  p = stripLeadingThe(p);

  // Common crediting phrasing
  p = p.replace(/^is widely credited with\s+/i, "普遍认为其");

  // Gerunds
  p = p.replace(/^discovering\s+/i, "发现了 ");
  p = p.replace(/^inventing\s+/i, "发明了 ");
  p = p.replace(/^developing\s+/i, "开发了 ");
  p = p.replace(/^creating\s+/i, "创造了 ");

  // Verb forms
  p = p.replace(/^invented\s+/i, "发明了 ");
  p = p.replace(/^co-invented\s+/i, "共同发明了 ");
  p = p.replace(/^developed\s+/i, "开发了 ");
  p = p.replace(/^discovered\s+/i, "发现了 ");
  p = p.replace(/^wrote\s+/i, "写了 ");
  p = p.replace(/^painted\s+/i, "创作了 ");
  p = p.replace(/^composed\s+/i, "创作了 ");
  p = p.replace(/^founded\s+/i, "创立了 ");

  // Light connective translations
  p = p
    .replace(/\bin the form\b/gi, "(以常见形式)")
    .replace(/\bcommonly credited\b/gi, "(通常被认为)")
    .replace(/\bmost commonly credited\b/gi, "(最常被认为)")
    .replace(/\bwidely associated with\b/gi, "(广泛与之相关)")
    .replace(/\bcommonly associated with\b/gi, "(通常与之相关)")
    .replace(/\bstrongly associated with\b/gi, "(强相关于)");

  // Simple prepositions
  p = p
    .replace(/\s+for\s+/gi, " 为 ")
    .replace(/\s+with\s+/gi, " 与 ")
    .replace(/\s+in\s+/gi, " 在 ")
    .replace(/\s+of\s+/gi, " 的 ")
    .replace(/\s+to\s+/gi, " 去 ");

  p = tightenCJKSpacing(applyMaps(p));

  return p.trim();
}

function translateQuestion(raw) {
  let s = normalizeEnglishPunct(String(raw));
  if (!s) return s;

  // Fix common artifact from earlier passes.
  s = s.replace(/为什么多少/g, "为什么许多");

  // Exact matches first (pre-normalization already done).
  if (EXACT_QUESTION_MAP.has(s)) {
    return tightenCJKSpacing(normalizeEnglishPunct(EXACT_QUESTION_MAP.get(s)));
  }

  // Preserve trailing punctuation
  const m = s.match(/([?!.])$/);
  const tail = m ? m[1] : "";
  const core = m ? s.slice(0, -1).trim() : s;

  // Template-based translations (most common patterns)
  let out = null;

  // Special-case: already-partially-translated remnants from earlier passes.
  if (/Rising.*太阳/i.test(core) || /Land\s*of\s*Rising/i.test(core)) {
    out = `日出之国指的是哪个国家${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  if (/^行星数量在太阳系$/i.test(core) || /太阳系.*行星.*数量/.test(core)) {
    out = `太阳系中有多少颗行星${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  if (/^最硬的天然的$/i.test(core) || /^最硬的天然的\?*$/i.test(core)) {
    out = `最硬的天然物质是什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  if (/^蜂蜜来自$/.test(core) || /^蜂蜜 来自$/.test(core) || /^蜂蜜来自/.test(core)) {
    out = `蜂蜜来自什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  if (/^植物吸收$/.test(core) || /^植物 吸收$/.test(core)) {
    out = `植物吸收什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  if (/^Red行星$/i.test(core) || /^Red\s+Planet$/i.test(core)) {
    out = `红色星球是哪个行星${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  if (/^骨头在成年人$/i.test(core) || /^骨头 in adult$/i.test(core)) {
    out = `成年人有多少块骨头${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // Who ...?
  let match;
  if ((match = core.match(/^Who\s+(.+)$/i))) {
    const rest = match[1].trim();
    out = `谁${translateVerbPhrase(rest)}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // How many X does Y have?
  if ((match = core.match(/^How\s+many\s+(.+?)\s+does\s+(?:an?|the)?\s*(.+?)\s+have$/i))) {
    const obj = tightenCJKSpacing(applyMaps(match[1]));
    const subj = tightenCJKSpacing(applyMaps(match[2]));
    out = `${subj}有多少${obj}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // What do X eat?
  if ((match = core.match(/^What\s+do\s+(.+?)\s+eat$/i))) {
    const subj = tightenCJKSpacing(applyMaps(match[1]));
    out = `${subj}吃什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  // Partially translated variant: "什么do X eat"
  if ((match = core.match(/^什么\s*do\s+(.+?)\s+eat$/i))) {
    const subj = tightenCJKSpacing(applyMaps(match[1]));
    out = `${subj}吃什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // X primarily/mainly eat?
  if ((match = core.match(/^(.+?)\s+(primarily|mainly)\s+eat$/i))) {
    const subj = tightenCJKSpacing(applyMaps(match[1]));
    out = `${subj}主要吃什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // X are classified as?
  if ((match = core.match(/^(.+?)\s+are\s+classified\s+as$/i))) {
    const subj = tightenCJKSpacing(applyMaps(match[1]));
    out = `${subj}被归类为什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // Planets in X?
  if ((match = core.match(/^Planets\s+in\s+(.+)$/i))) {
    const where = tightenCJKSpacing(applyMaps(stripLeadingThe(match[1])));
    out = `${where}中有多少颗行星${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // X in?
  if ((match = core.match(/^(.+?)\s+in$/i))) {
    const thing = tightenCJKSpacing(applyMaps(stripLeadingThe(match[1])));
    out = `${thing}在哪${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // Why do ...?
  if ((match = core.match(/^Why\s+do\s+(.+)$/i))) {
    out = `为什么${tightenCJKSpacing(applyMaps(match[1]))}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // Term for ...?
  if ((match = core.match(/^Term\s+for\s+(.+)$/i))) {
    out = `${tightenCJKSpacing(applyMaps(match[1]))}的术语是什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // ... means?
  if ((match = core.match(/^(.+?)\s+means$/i))) {
    out = `${tightenCJKSpacing(applyMaps(match[1]))}是什么意思${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // What is ...?
  if ((match = core.match(/^What\s+is\s+(.+)$/i))) {
    out = `什么是${tightenCJKSpacing(applyMaps(stripLeadingThe(match[1])))}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // X is... (e.g. RAM is...)
  if ((match = core.match(/^(.+?)\s+is\s*\.\.\.$/i))) {
    out = `${tightenCJKSpacing(applyMaps(match[1]))}是...${tail || ""}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  if ((match = core.match(/^(.+?)\s+is\s*(.+)$/i))) {
    out = `${tightenCJKSpacing(applyMaps(match[1]))}是${tightenCJKSpacing(applyMaps(match[2]))}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // What does X stand for?
  if ((match = core.match(/^What\s+does\s+(.+?)\s+stand\s+for$/i))) {
    out = `${match[1]} 代表什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // X stands for?
  if ((match = core.match(/^(.+?)\s+stands\s+for$/i))) {
    out = `${match[1]} 代表什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // Capital of X?
  if ((match = core.match(/^Capital\s+of\s+(.+)$/i))) {
    out = `${tightenCJKSpacing(applyMaps(match[1]))}的首都是哪里${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // X country?
  if ((match = core.match(/^(.+?)\s+country$/i))) {
    out = `${tightenCJKSpacing(applyMaps(match[1]))}在哪个国家${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // X language?
  if ((match = core.match(/^(.+?)\s+language$/i))) {
    out = `${tightenCJKSpacing(applyMaps(match[1]))}的语言是什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // X currency?
  if ((match = core.match(/^(.+?)\s+currency$/i))) {
    out = `${tightenCJKSpacing(applyMaps(match[1]))}的货币是什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // X symbol?
  if ((match = core.match(/^(.+?)\s+symbol$/i))) {
    out = `${tightenCJKSpacing(applyMaps(match[1]))}的符号是什么${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // Largest/Smallest ...?
  if ((match = core.match(/^Largest\s+(.+)$/i))) {
    out = `哪个是最大的${tightenCJKSpacing(applyMaps(match[1]))}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  if ((match = core.match(/^Smallest\s+(.+)$/i))) {
    out = `哪个是最小的${tightenCJKSpacing(applyMaps(match[1]))}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  if ((match = core.match(/^Fastest\s+(.+)$/i))) {
    out = `哪个是最快的${tightenCJKSpacing(applyMaps(match[1]))}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  if ((match = core.match(/^Tallest\s+(.+)$/i))) {
    out = `哪个是最高的${tightenCJKSpacing(applyMaps(match[1]))}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  if ((match = core.match(/^Longest\s+(.+)$/i))) {
    out = `哪个是最长的${tightenCJKSpacing(applyMaps(match[1]))}${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // First on X?
  if ((match = core.match(/^First\s+on\s+(.+)$/i))) {
    out = `谁是第一个登上 ${match[1]} 的人${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // Boils/Freezes at ...?
  if ((match = core.match(/^Boils\s+at\s+(.+)$/i))) {
    out = `沸点是多少(${match[1]})${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }
  if ((match = core.match(/^Freezes\s+at\s+(.+)$/i))) {
    out = `凝固点是多少(${match[1]})${tail || "?"}`;
    return tightenCJKSpacing(normalizeEnglishPunct(out));
  }

  // Fallback: light dictionary replacements for question scaffolding
  out = tightenCJKSpacing(applyMaps(core));

  const replacements = [
    [/\bHow\s+many\b/gi, "多少"],
    [/\bWhich\b/gi, "哪个"],
    [/\bWhere\b/gi, "哪里"],
    [/\bWhen\b/gi, "何时"],
    [/\bWhy\b/gi, "为什么"],
    [/\bWho\b/gi, "谁"],
    [/\bWhat\b/gi, "什么"],

    [/\bcapital\b/gi, "首都"],
    [/\blargest\b/gi, "最大的"],
    [/\bsmallest\b/gi, "最小的"],
    [/\bfirst\b/gi, "第一个"],

    [/\binvented\b/gi, "发明了"],
    [/\bco-invented\b/gi, "共同发明了"],
    [/\bdeveloped\b/gi, "开发了"],
    [/\bdiscovered\b/gi, "发现了"],

    [/\bauthor\b/gi, "作者"],
    [/\bwriter\b/gi, "作者"],
    [/\bpainter\b/gi, "画家"],
    [/\bdiscoverer\b/gi, "发现者"],

    [/\bcountry\b/gi, "国家"],
    [/\blanguage\b/gi, "语言"],
    [/\bcurrency\b/gi, "货币"],
    [/\bsymbol\b/gi, "符号"],

    [/\bended\b/gi, "结束"],
    [/\bstands\s+for\b/gi, "代表"],
  ];

  for (const [re, rep] of replacements) out = out.replace(re, rep);

  out = `${out}${tail || "?"}`;
  return tightenCJKSpacing(normalizeEnglishPunct(out));
}

function main() {
  const args = process.argv.slice(2);
  const filePath = args[0];
  const startLine = Number(args[1]);
  const endLine = Number(args[2]);
  const dry = args.includes("--dry");

  if (!filePath || !Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    console.error("Usage: node tools/translate_quiz_questions.js <file> <startLine> <endLine> [--dry]");
    process.exit(2);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  let translatedCount = 0;

  const startIdx = Math.max(0, startLine - 1);
  const endIdx = Math.min(lines.length - 1, endLine - 1);

  for (let i = startIdx; i <= endIdx; i++) {
    const line = lines[i];
    if (!line || (!line.includes('q:"') && !line.includes('text:"'))) continue;

    const updated = line.replace(/\b(q|text):"([^"]*)"/g, (full, key, inner) => {
      const translated = translateQuestion(inner);
      if (translated !== inner) translatedCount++;
      return `${key}:"${translated}"`;
    });

    lines[i] = updated;
  }

  if (dry) {
    console.log(`dry_run_translated=${translatedCount}`);
    return;
  }

  fs.writeFileSync(filePath, lines.join(newline), "utf8");
  console.log(`translated=${translatedCount}`);
}

main();
