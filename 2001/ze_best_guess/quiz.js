import { Instance } from "cs_script/point_script";


const PHASE_NONE = 0, PHASE_QUIZROOMS = 1, PHASE_SHOWDOWN = 2, PHASE_FINISHED = 3;
let phase = PHASE_NONE;


const STATS = new Map();

function S(slot) {
  let s = STATS.get(slot);
  if (!s) {
    s = {
      qr_answered:0, qr_correct:0, qr_wrong:0, qr_nopick:0,
      qr_firstLocks:0, qr_correctTimeSum:0, qr_correctTimeN:0,
      sd_answered:0, sd_correct:0, sd_wrong:0,
      sd_correctTimeSum:0, sd_correctTimeN:0,
      nameCache:""
    };
    STATS.set(slot, s);
  }
  if (!s.nameCache) {
    const pc = Instance.GetPlayerController(slot);
    s.nameCache = pc?.GetPlayerName?.() || "Unknown";
  }
  return s;
}

function resetSharedStats() {
  STATS.clear();
}

function now() { return Instance.GetGameTime(); }
function say(msg) {
  try { Instance.ServerCommand(`say ${msg}`); } catch {}
}
function setText(name, msg) {
  const e = Instance.FindEntityByName(name);
  if (!e || !e.IsValid()) return;
  Instance.EntFireAtTarget({ target: e, input: "TurnOn" });
  Instance.EntFireAtTarget({ target: e, input: "SetMessage", value: msg });
}
function kickThink() { Instance.SetNextThink(now() + 0.05); }

let tickQuizRooms = () => {};
let tickShowdown = () => {};
let getQuizAwards = () => null;
let lastShowdownMvps = { human: null, zombie: null };

function slotName(slot) {
  if (slot === undefined || slot === null || slot < 0) return "Unknown";
  const s = S(slot);
  return s.nameCache || "Unknown";
}
(function QuizRoomsModule(){


Instance.OnActivate(() => {
  Instance.ServerCommand("say [QUIZ LOADED]");
  const wt = Instance.FindEntityByName("wt_probe");
  if (wt) {
    Instance.EntFireAtTarget({ target: wt, input: "TurnOn" });
    Instance.EntFireAtTarget({ target: wt, input: "SetMessage", value: "[quiz] loaded" });
  }
  kickThink();
  prepareRun();
});

Instance.OnScriptInput("Ping", () => {
  Instance.ServerCommand("say [quiz] ping ok");
});

Instance.OnScriptInput("QuizAwards_Print", () => {
  const a = finalizeAwardsToWorldtexts();

  const line = (label, obj, fmtVal) =>
    (obj && obj.slot >= 0) ? `${label}: ${getName(obj.slot)} (${fmtVal(obj.val)})` : `${label}: none`;

  say("[QUIZ] === AWARDS ===");
  say(line("Smartest",   a.smartest,   v => `${v} correct`));
  say(line("Dumbest",    a.dumbest,    v => `${v} correct (min 3 answers)`));
  say(line("Most wrong", a.mostWrong,  v => `${v} wrong`));
  say(line("Most engaged", a.engaged,  v => `${v} answers`));
  say(line("Biggest guesser", a.guesser, v => `${Math.round(v*100)}% acc (min 3 answers)`));
  say(line("First-lock king", a.firstLock, v => `${v} first-locks`));
  say(line("Fastest brain", a.fastest, v => `${v.toFixed(2)}s avg correct`));
});


const HUMAN_TEAM    = 3;     
const COUNTDOWN     = 16.0;  
const WRONG_DAMAGE  = 40;    
const NOPICK_DAMAGE = 80;    
const THINK_HZ      = 20;    
const LOCK_AT_T0    = true;  


const pStats = new Map();

function resetQuizStats() {
  pStats.clear();
  STATS.forEach((s) => {
    s.qr_answered = 0;
    s.qr_correct = 0;
    s.qr_wrong = 0;
    s.qr_nopick = 0;
    s.qr_firstLocks = 0;
    s.qr_correctTimeSum = 0;
    s.qr_correctTimeN = 0;
  });
}


const stageFirstAnswerTime = {}; 
for (let n = 1; n <= 6; n++) stageFirstAnswerTime[n] = new Map();

function getOrMakeStats(slot) {
  const base = S(slot);
  let s = pStats.get(slot);
  if (!s) {
    s = {
      get answered() { return base.qr_answered; },
      set answered(v) { base.qr_answered = v; },
      get correct() { return base.qr_correct; },
      set correct(v) { base.qr_correct = v; },
      get wrong() { return base.qr_wrong; },
      set wrong(v) { base.qr_wrong = v; },
      get nopick() { return base.qr_nopick; },
      set nopick(v) { base.qr_nopick = v; },
      get firstLocks() { return base.qr_firstLocks; },
      set firstLocks(v) { base.qr_firstLocks = v; },
      get correctTimeSum() { return base.qr_correctTimeSum; },
      set correctTimeSum(v) { base.qr_correctTimeSum = v; },
      get correctTimeN() { return base.qr_correctTimeN; },
      set correctTimeN(v) { base.qr_correctTimeN = v; },
    };
    pStats.set(slot, s);
  }
  return s;
}

function getName(slot) {
  return slotName(slot);
}


const stages = {}; 
for (let n = 1; n <= 6; n++) {
  stages[n] = {
    active: false,
    locked: false,
    tStart: 0,
    picks: { A: new Set(), B: new Set(), C: new Set() },
    correctDoor: null,   
    qIndex: null,
  };
}
let runSet = []; 
let awardsDueAt = 0;
let awardsDue = false;


function now() { return Instance.GetGameTime(); }
function say(s) { Instance.ServerCommand(`say ${s}`); }
function setText(name, msg) {
  const e = Instance.FindEntityByName(name);
  if (!e || !e.IsValid()) return;
  Instance.EntFireAtTarget({ target: e, input: "TurnOn" });
  Instance.EntFireAtTarget({ target: e, input: "SetMessage", value: msg });
}
function openDoor(name)  { Instance.EntFireAtName({ name, input: "Open"  }); }
function closeDoor(name) { Instance.EntFireAtName({ name, input: "Close" }); }
function isHuman(slot) {
  const pc = Instance.GetPlayerController(slot);
  return !!pc && pc.GetTeamNumber() === HUMAN_TEAM;
}
function getPawn(slot) {
  const pc = Instance.GetPlayerController(slot);
  return pc ? pc.GetPlayerPawn() : undefined;
}
function humanSlotsAlive() {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const pc = Instance.GetPlayerController(i);
    if (!pc || !pc.IsConnected() || pc.IsObserving() || pc.GetTeamNumber() !== HUMAN_TEAM) continue;
    const p = pc.GetPlayerPawn();
    if (!p || !p.IsAlive()) continue;
    out.push(i);
  }
  return out;
}
function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function kickThink() {
  Instance.SetNextThink(Instance.GetGameTime() + 0.05);
}


function prepareRun() {
  resetSharedStats();
  lastShowdownMvps = { human: null, zombie: null };
  resetQuizStats();
  phase = PHASE_QUIZROOMS;
  for (let n = 1; n <= 6; n++) stageFirstAnswerTime[n].clear();
  awardsDue = false;
  awardsDueAt = 0;

  const count = QUESTION_BANK.length;
  const pool = Array.from({length: count}, (_, i) => i);
  shuffleInPlace(pool);
  runSet = pool.slice(0, 6);
  for (let n = 1; n <= 6; n++) resetStage(n);
  say("New quiz set prepared.");
  kickThink();
}
Instance.OnRoundStart(() => { prepareRun(); });
Instance.OnScriptInput("StartRun", () => { prepareRun(); });


for (let n = 1; n <= 6; n++) {
  Instance.OnScriptInput(`StartStage${n}`, () => startStage(n));
  Instance.OnScriptInput(`ResetStage${n}`, () => resetStage(n));
  Instance.OnScriptInput(`EnterA_${n}`, ({ activator }) => recordPick(n, "A", activator));
  Instance.OnScriptInput(`EnterB_${n}`, ({ activator }) => recordPick(n, "B", activator));
  Instance.OnScriptInput(`EnterC_${n}`, ({ activator }) => recordPick(n, "C", activator));
}

function pickBest(predicate, minGateFn = null) {
  let bestSlot = -1;
  let bestVal = -Infinity;
  pStats.forEach((s, slot) => {
    if (minGateFn && !minGateFn(s, slot)) return;
    const v = predicate(s, slot);
    if (v > bestVal) { bestVal = v; bestSlot = slot; }
  });
  return { slot: bestSlot, val: bestVal };
}

function pickWorst(predicate, minGateFn = null) {
  let worstSlot = -1;
  let worstVal = Infinity;
  pStats.forEach((s, slot) => {
    if (minGateFn && !minGateFn(s, slot)) return;
    const v = predicate(s, slot);
    if (v < worstVal) { worstVal = v; worstSlot = slot; }
  });
  return { slot: worstSlot, val: worstVal };
}

function accuracy(s) {
  const denom = s.correct + s.wrong;
  return denom > 0 ? (s.correct / denom) : 0;
}

function avgCorrectTime(s) {
  return s.correctTimeN > 0 ? (s.correctTimeSum / s.correctTimeN) : 9999;
}

function buildQuizAwards() {
  const smartest = pickBest(s => s.correct);

  
  const dumbest = pickWorst(s => s.correct, (s) => s.answered >= 3);

  const mostWrong = pickBest(s => s.wrong);

  const fastestWinner = pickWorst(s => avgCorrectTime(s), (s) => s.correctTimeN >= 1);
  const fastestVal = (fastestWinner.slot >= 0) ? avgCorrectTime(pStats.get(fastestWinner.slot)) : 0;

  const engaged = pickBest(s => s.answered);

  
  const guesser = pickWorst(s => accuracy(s), (s) => (s.correct + s.wrong) >= 3);

  
  const firstLock = pickBest(s => s.firstLocks);

  const normalize = (res) => (res && res.slot >= 0 ? res : null);

  return {
    smartest: normalize(smartest),
    dumbest: normalize(dumbest),
    mostWrong: normalize(mostWrong),
    fastest: fastestWinner.slot >= 0 ? { slot: fastestWinner.slot, val: fastestVal } : null,
    engaged: normalize(engaged),
    guesser: normalize(guesser),
    firstLock: normalize(firstLock),
  };
}

getQuizAwards = buildQuizAwards;

function finalizeAwardsToWorldtexts() {
  const a = buildQuizAwards();

  if (a.smartest)  setText("wt_quiz_smartest", `Smartest: ${getName(a.smartest.slot)} (${a.smartest.val})`);
  if (a.dumbest)   setText("wt_quiz_dumbest",  `Dumbest: ${getName(a.dumbest.slot)} (${a.dumbest.val})`);
  if (a.mostWrong) setText("wt_quiz_mostwrong", `Most Wrong: ${getName(a.mostWrong.slot)} (${a.mostWrong.val})`);
  if (a.fastest)   setText("wt_quiz_fastest",  `Fastest brain: ${getName(a.fastest.slot)} (${a.fastest.val.toFixed(2)}s)`);
  if (a.engaged)   setText("wt_quiz_engaged",  `Most engaged: ${getName(a.engaged.slot)} (${a.engaged.val})`);
  if (a.guesser)   setText("wt_quiz_guesser",  `Biggest guesser: ${getName(a.guesser.slot)} (${(a.guesser.val*100).toFixed(0)}%)`);
  if (a.firstLock) setText("wt_quiz_firstlock",`First-lock king: ${getName(a.firstLock.slot)} (${a.firstLock.val})`);

  return a;
}

function startStage(n) {
  if (runSet.length !== 6) prepareRun();
  phase = PHASE_QUIZROOMS;
  const idx = runSet[n - 1];
  const q = QUESTION_BANK[idx];
  const st = stages[n];

  st.active = true;
  st.locked = false;
  st.tStart = now();
  st.qIndex = idx;
  st.picks.A.clear(); st.picks.B.clear(); st.picks.C.clear();

  
  const cards = [
    { text: q.correct, isCorrect: true  },
    { text: q.wrong[0], isCorrect: false },
    { text: q.wrong[1], isCorrect: false },
  ];
  shuffleInPlace(cards);

  const doors = ["A","B","C"];
  let correctDoor = "A";
  for (let i = 0; i < 3; i++) {
    const d = doors[i];
    const c = cards[i];
    setText(`wt_a_s${n}_${d}`, `${d}) ${c.text}`);
    if (c.isCorrect) correctDoor = d;
  }
  st.correctDoor = correctDoor;

  setText(`wt_q_s${n}`, q.q);
  setText(`wt_t_s${n}`, `Answer in ${Math.ceil(COUNTDOWN)}s`);

  closeDoor(`lift_s${n}_A`);
  closeDoor(`lift_s${n}_B`);
  closeDoor(`lift_s${n}_C`);

  stageFirstAnswerTime[n].clear();

  say(`Stage ${n}: choose A/B/C.`);
  kickThink();
}

function resetStage(n) {
  const st = stages[n];
  st.active = false;
  st.locked = false;
  st.qIndex = null;
  st.correctDoor = null;
  st.picks.A.clear(); st.picks.B.clear(); st.picks.C.clear();

  setText(`wt_q_s${n}`, "");
  setText(`wt_a_s${n}_A`, "");
  setText(`wt_a_s${n}_B`, "");
  setText(`wt_a_s${n}_C`, "");
  setText(`wt_t_s${n}`, "");

  closeDoor(`lift_s${n}_A`);
  closeDoor(`lift_s${n}_B`);
  closeDoor(`lift_s${n}_C`);
}

function recordPick(n, which, activator) {
  if (phase !== PHASE_QUIZROOMS) return;
  const st = stages[n];
  if (!st.active || st.locked) return;

  const pawn = /** @type {any} */ (activator);
  const pc = pawn && pawn.GetPlayerController ? pawn.GetPlayerController() : undefined;
  const slot = pc ? pc.GetPlayerSlot() : -1;
  if (slot < 0 || !isHuman(slot)) return;

  const stTime = now() - st.tStart;

  
  const alreadyPicked =
    st.picks.A.has(slot) || st.picks.B.has(slot) || st.picks.C.has(slot);

  st.picks.A.delete(slot);
  st.picks.B.delete(slot);
  st.picks.C.delete(slot);
  st.picks[which].add(slot);

  if (!alreadyPicked) {
    getOrMakeStats(slot).answered++;

    
    stageFirstAnswerTime[n].set(slot, stTime);

    
  }
}

function resolveStage(n) {
  const st = stages[n];
  if (!st.active) return;
  st.locked = true;
  st.active = false;

  openDoor(`lift_s${n}_A`);
  openDoor(`lift_s${n}_B`);
  openDoor(`lift_s${n}_C`);

  
  let firstSlot = -1;
  let bestT = 1e9;
  stageFirstAnswerTime[n].forEach((tAns, slot) => {
    if (tAns < bestT) { bestT = tAns; firstSlot = slot; }
  });
  if (firstSlot >= 0) getOrMakeStats(firstSlot).firstLocks++;

  
  ["A","B","C"].forEach(letter => {
    if (letter === st.correctDoor) return;
    st.picks[letter].forEach(slot => {
      const p = getPawn(slot);
      if (p && p.IsAlive()) p.TakeDamage({ damage: WRONG_DAMAGE });
      const ps = getOrMakeStats(slot);
      ps.wrong++;
    });
  });

  
  st.picks[st.correctDoor].forEach(slot => {
    const ps = getOrMakeStats(slot);
    ps.correct++;

    
    const tAns = stageFirstAnswerTime[n].get(slot);
    if (typeof tAns === "number") {
      ps.correctTimeSum += tAns;
      ps.correctTimeN += 1;
    }
  });

  
  const picked = new Set();
  st.picks.A.forEach(s => picked.add(s));
  st.picks.B.forEach(s => picked.add(s));
  st.picks.C.forEach(s => picked.add(s));
  humanSlotsAlive().forEach(slot => {
    if (picked.has(slot)) return;
    const p = getPawn(slot);
    if (p && p.IsAlive()) p.TakeDamage({ damage: NOPICK_DAMAGE });
    const ps = getOrMakeStats(slot);
    ps.nopick++;
  });

  setText(`wt_t_s${n}`, "");
  say(`Stage ${n}: correct was ${st.correctDoor}. Wrong -20 HP. No-pick -40 HP.`);

  if (n === 6) {
    phase = PHASE_SHOWDOWN;
    
    if (typeof Instance.SetTimeout === "function") {
      Instance.SetTimeout(0.2, () => finalizeAwardsToWorldtexts());
    } else {
      awardsDueAt = now() + 0.2;
      awardsDue = true;
    }
  }
}


tickQuizRooms = function(tInput) {
  const t = typeof tInput === "number" ? tInput : now();

  if (awardsDue && now() >= awardsDueAt) {
    awardsDue = false;
    finalizeAwardsToWorldtexts();
  }

  for (let n = 1; n <= 6; n++) {
    const st = stages[n];
    if (!st.active) continue;

    const remain = COUNTDOWN - (t - st.tStart);
    if (remain > 0) {
      setText(`wt_t_s${n}`, `Answer in ${Math.ceil(remain)}s`);
      if (LOCK_AT_T0 && remain <= 0.05 && !st.locked) st.locked = true;
      continue;
    }
    if (!st.locked) st.locked = true;
    resolveStage(n);
  }
};


const QUESTION_BANK = [
  { q:"France的首都是哪里?", correct:"Paris", wrong:["Lyon","Marseille"] },
  { q:"哪个是最大的行星?", correct:"Jupiter", wrong:["Saturn","Neptune"] },
  { q:"黄金的符号是什么?", correct:"Au", wrong:["Ag","Gd"] },
  { q:"哪个是最快的陆地动物?", correct:"Cheetah", wrong:["Lion","Pronghorn"] },
  { q:"1984作者?", correct:"George Orwell", wrong:["Aldous Huxley","Ray Bradbury"] },
  { q:"H2O是...", correct:"Water", wrong:["Oxygen","Hydrogen"] },
  { q:"哪个是最高的山?", correct:"Everest", wrong:["K2","Kangchenjunga"] },
  { q:"太阳系中有多少颗行星?", correct:"8", wrong:["9","7"] },
  { q:"哪个是最大的海洋?", correct:"Pacific", wrong:["Atlantic","Indian"] },
  { q:"Japan的货币是什么?", correct:"Yen", wrong:["Yuan","Won"] },
  { q:"Mona Lisa画家?", correct:"Leonardo da Vinci", wrong:["Michelangelo","Raphael"] },
  { q:"原子序数1?", correct:"Hydrogen", wrong:["Helium","Lithium"] },
  { q:"日出之国指的是哪个国家?", correct:"Japan", wrong:["China","Thailand"] },
  { q:"最硬的天然物质是什么?", correct:"Diamond", wrong:["Quartz","Corundum"] },
  { q:"植物吸收什么?", correct:"CO2", wrong:["O2","N2"] },
  { q:"Penicillin发现者?", correct:"Alexander Fleming", wrong:["Marie Curie","Louis Pasteur"] },
  { q:"大堡礁在?", correct:"Australia", wrong:["Philippines","Indonesia"] },
  { q:"哪个是最大的热沙漠?", correct:"Sahara", wrong:["Arabian","Gobi"] },
  { q:"谁是第一个登上月球的人?", correct:"Neil Armstrong", wrong:["Buzz Aldrin","Yuri Gagarin"] },
  { q:"沸点是多少(°C)?", correct:"100", wrong:["90","110"] },
  { q:"哪个是最长的非洲河?", correct:"Nile", wrong:["Congo","Niger"] },
  { q:"Hamlet作者?", correct:"Shakespeare", wrong:["Marlowe","Ben Jonson"] },
  { q:"哪个是最大的哺乳动物?", correct:"Blue whale", wrong:["Elephant","Giraffe"] },
  { q:"红色星球是哪个行星?", correct:"Mars", wrong:["Mercury","Venus"] },
  { q:"Canada的首都是哪里?", correct:"Ottawa", wrong:["Toronto","Montreal"] },
  { q:"哪个是最小的质数?", correct:"2", wrong:["1","3"] },
  { q:"蜂蜜来自什么?", correct:"Nectar", wrong:["Pollen","Sap"] },
  { q:"凝固点是多少(°C)?", correct:"0", wrong:["-5","5"] },
  { q:"哪个是最大的大陆?", correct:"Asia", wrong:["Africa","N. America"] },
  { q:"Starry夜间画家?", correct:"Van Gogh", wrong:["Picasso","Monet"] },
  { q:"Liquid metal在RT?", correct:"Mercury", wrong:["Lead","Aluminium"] },
  { q:"成年人有多少块骨头?", correct:"206", wrong:["201","210"] },
  { q:"母语使用者最多的是哪种语言?", correct:"Mandarin", wrong:["Spanish","English"] },
  { q:"哪个是最高的动物?", correct:"Giraffe", wrong:["Elephant","Moose"] },
  { q:"Italy的首都是哪里?", correct:"Rome", wrong:["Milan","Florence"] },
  { q:"行星与rings?", correct:"Saturn", wrong:["Uranus","Neptune"] },
  { q:"Sodium的符号是什么?", correct:"Na", wrong:["So","S"] },
  { q:"植物制造养分的过程?", correct:"Photosynthesis", wrong:["Respiration","Transpiration"] },
  { q:"哪个是最大的internal器官?", correct:"Liver", wrong:["Lungs","Heart"] },
  { q:"WWII结束?", correct:"1945", wrong:["1944","1946"] },
  { q:"SI temp unit?", correct:"Kelvin", wrong:["Celsius","Fahrenheit"] },
  { q:"Relativity按?", correct:"Einstein", wrong:["Newton","Tesla"] },
  { q:"Istanbul在哪个国家?", correct:"Turkey", wrong:["Greece","Bulgaria"] },
  { q:"哪个是最大的是陆地?", correct:"Greenland", wrong:["New Guinea","Borneo"] },
  { q:"主要air气体?", correct:"Nitrogen", wrong:["Oxygen","CO2"] },
  { q:"Pumps blood?", correct:"Heart", wrong:["Lungs","Liver"] },
  { q:"Heptagon sides?", correct:"7", wrong:["6","8"] },
  { q:"Brazil的语言是什么?", correct:"Portuguese", wrong:["Spanish","French"] },
  { q:"Keys+pedals+strings?", correct:"Piano", wrong:["Guitar","Harp"] },
  { q:"哪个是最小的在哪个国家?", correct:"Vatican City", wrong:["Monaco","San Marino"] },
  { q:"Bulb filament?", correct:"Tungsten", wrong:["Copper","Aluminium"] },
  { q:"食盐?", correct:"NaCl", wrong:["KCl","Na2CO3"] },
  { q:"Pride & Prejudice?", correct:"Jane Austen", wrong:["C. Brontë","E. Brontë"] },
  { q:"最近的star?", correct:"Sun", wrong:["Proxima","Sirius"] },
  { q:"哪个是最大的鸟类?", correct:"Ostrich", wrong:["Emu","Albatross"] },
  { q:"√81?", correct:"9", wrong:["8","7"] },
  { q:"哪个是最长的骨头?", correct:"Femur", wrong:["Tibia","Humerus"] },
  { q:"研究天气的学科?", correct:"Meteorology", wrong:["Geology","Oceanography"] },
  { q:"UK的货币是什么?", correct:"Pound", wrong:["Euro","Dollar"] },
  { q:"最近的行星到太阳?", correct:"Mercury", wrong:["Venus","Earth"] },
  { q:"细胞分裂?", correct:"Mitosis", wrong:["Meiosis","Osmosis"] },
  { q:"Continents count?", correct:"7", wrong:["6","5"] },
  { q:"Liberty gifted按?", correct:"France", wrong:["UK","Spain"] },
  { q:"太阳主要气体?", correct:"Hydrogen", wrong:["Oxygen","Nitrogen"] },
  { q:"哪个是最大的猫科动物?", correct:"Tiger", wrong:["Lion","Leopard"] },
  { q:"US east coast海洋?", correct:"Atlantic", wrong:["Pacific","Indian"] },
  { q:"Potassium的符号是什么?", correct:"K", wrong:["P","Po"] },
  { q:"光速 ~km/s?", correct:"300,000", wrong:["150,000","30,000"] },
  { q:"第一个female UK PM?", correct:"Thatcher", wrong:["May","Gandhi"] },
  { q:"Igneous rock?", correct:"Granite", wrong:["Limestone","Marble"] },
  { q:"Vitamin C name?", correct:"Ascorbic acid", wrong:["Citric","Lactic"] },
  { q:"Photosynthesis器官?", correct:"Leaves", wrong:["Roots","Stems"] },
  { q:"Australia的首都是哪里?", correct:"Canberra", wrong:["Sydney","Melbourne"] },
  { q:"Football players?", correct:"11", wrong:["10","12"] },
  { q:"Scream画家?", correct:"Edvard Munch", wrong:["Dalí","Matisse"] },
  { q:"铁的符号是什么?", correct:"Fe", wrong:["Ir","In"] },
  { q:"哪个是最大的freshwater lake?", correct:"Lake Superior", wrong:["Victoria","Michigan"] },
  { q:"哪个是最大的国家area?", correct:"Russia", wrong:["Canada","China"] },
  { q:"气压tool?", correct:"Barometer", wrong:["Thermometer","Hygrometer"] },
  { q:"气体→liquid?", correct:"Condensation", wrong:["Evaporation","Sublimation"] },
  { q:"Roman L?", correct:"50", wrong:["100","500"] },
  { q:"Metal that rusts?", correct:"Iron", wrong:["Gold","Aluminium"] },
  { q:"Day>year行星?", correct:"Venus", wrong:["Mercury","Mars"] },
  { q:"Earth's satellite?", correct:"Moon", wrong:["Phobos","Titan"] },
  { q:"Egypt的首都是哪里?", correct:"Cairo", wrong:["Alexandria","Giza"] },
  { q:"哪个是最长的wall?", correct:"Great Wall", wrong:["Hadrian's","Berlin"] },
  { q:"Laws的motion?", correct:"Newton", wrong:["Galileo","Kepler"] },
  { q:"哪个是最小的life unit?", correct:"Cell", wrong:["Atom","Molecule"] },
  { q:"Mexico的语言是什么?", correct:"Spanish", wrong:["Portuguese","English"] },
  { q:"Carbon的符号是什么?", correct:"C", wrong:["Ca","Co"] },
  { q:"研究化石的学科?", correct:"Paleontology", wrong:["Anthropology","Archaeology"] },
  { q:"测量地震的仪器?", correct:"Seismograph", wrong:["Barograph","Altimeter"] },
  { q:"Detox器官?", correct:"Liver", wrong:["Kidney","Spleen"] },
  { q:"Bread rise气体?", correct:"CO2", wrong:["O2","N2"] },
  { q:"Protects brain?", correct:"Skull", wrong:["Ribcage","Pelvis"] },
  { q:"noble气体?", correct:"Neon", wrong:["Nitrogen","Chlorine"] },
  { q:"Spain的首都是哪里?", correct:"Madrid", wrong:["Barcelona","Seville"] },
  { q:"Glucose formula?", correct:"C6H12O6", wrong:["C12H22O11","CO2"] },
  { q:"Fear small spaces?", correct:"Claustrophobia", wrong:["Acrophobia","Arachnophobia"] },
  { q:"Telephone发明者?", correct:"Alexander G. Bell", wrong:["Edison","Marconi"] },
  { q:"哪个是最大的rainforest?", correct:"Amazon", wrong:["Congo","Daintree"] },
  { q:"Very salty sea?", correct:"Dead Sea", wrong:["Black","Red"] },
  { q:"Infection fighters?", correct:"White blood cells", wrong:["RBC","Platelets"] },
  { q:"哪个是最大的月球?", correct:"Ganymede", wrong:["Titan","Europa"] },
  { q:"Germany的首都是哪里?", correct:"Berlin", wrong:["Munich","Frankfurt"] },
  { q:"植物study?", correct:"Botany", wrong:["Zoology","Mycology"] },
  { q:"Odyssey作者?", correct:"Homer", wrong:["Virgil","Sophocles"] },
  { q:"Resistance unit?", correct:"Ohm", wrong:["Volt","Ampere"] },
  { q:"Liquid→气体?", correct:"Evaporation", wrong:["Condensation","Freezing"] },
  { q:"鱼用什么呼吸与?", correct:"Gills", wrong:["Lungs","Spiracles"] },
  { q:"1492 voyage leader?", correct:"Columbus", wrong:["Da Gama","Magellan"] },
  { q:"Russia的首都是哪里?", correct:"Moscow", wrong:["St Petersburg","Kazan"] },
  { q:"Mars volcano?", correct:"Olympus Mons", wrong:["Mauna Kea","Vesuvius"] },
  { q:"Fizz气体?", correct:"CO2", wrong:["Oxygen","Hydrogen"] },
  { q:"哪个是最长的EU河?", correct:"Volga", wrong:["Danube","Rhine"] },
  { q:"最深的trench?", correct:"Mariana", wrong:["Tonga","Puerto Rico"] },
  { q:"Green pigment?", correct:"Chlorophyll", wrong:["Hemoglobin","Melanin"] },
  { q:"π是...", correct:"Circumference/diameter", wrong:["Radius/area","Side/diagonal"] },
  { q:"Controls pupil size?", correct:"Iris", wrong:["Retina","Cornea"] },
  { q:"India的首都是哪里?", correct:"New Delhi", wrong:["Mumbai","Kolkata"] },
  { q:"Vapor到ice?", correct:"Frost", wrong:["Sleet","Hail"] },
  { q:"Sank在1912?", correct:"Titanic", wrong:["Lusitania","Britannic"] },
  { q:"直角?", correct:"90°", wrong:["45°","180°"] },
  { q:"Mockingbird作者?", correct:"Harper Lee", wrong:["Morrison","Salinger"] },
  { q:"marsupial?", correct:"Kangaroo", wrong:["Elephant","Panda"] },
  { q:"河在Egypt?", correct:"Nile", wrong:["Tigris","Euphrates"] },
  { q:"Eats植物 & 动物?", correct:"Omnivore", wrong:["Herbivore","Carnivore"] },
  { q:"银的符号是什么?", correct:"Ag", wrong:["Au","Si"] },
  { q:"Wet plaster art?", correct:"Fresco", wrong:["Mosaic","Etching"] },
  { q:"Most countries大陆?", correct:"Africa", wrong:["Europe","Asia"] },
  { q:"Argentina的首都是哪里?", correct:"Buenos Aires", wrong:["Santiago","Lima"] },
  { q:"Insulin made按?", correct:"Pancreas", wrong:["Liver","Spleen"] },
  { q:"观测太空的工具?", correct:"Telescope", wrong:["Microscope","Periscope"] },
  { q:"哪个是最大的蜥蜴?", correct:"Komodo dragon", wrong:["Iguana","Gila monster"] },
  { q:"天然的selection?", correct:"Charles Darwin", wrong:["Gregor Mendel","Alfred Wallace"] },
  { q:"Nordic not在EU?", correct:"Norway", wrong:["Sweden","Denmark"] },
  { q:"植物水loss?", correct:"Transpiration", wrong:["Perspiration","Respiration"] },
  { q:"Kenya的首都是哪里?", correct:"Nairobi", wrong:["Mombasa","Kisumu"] },
  { q:"Big lower-leg骨头?", correct:"Tibia", wrong:["Fibula","Femur"] },
  { q:"Taj Mahal在哪个国家?", correct:"India", wrong:["Pakistan","Iran"] },
  { q:"哪个是最小的海洋?", correct:"Arctic", wrong:["Southern","Indian"] },
  { q:"研究地震的学科?", correct:"Seismology", wrong:["Vulcanology","Glaciology"] },
  { q:"Pipe keyboard?", correct:"Organ", wrong:["Piano","Accordion"] },
  { q:"Angle 90–180°?", correct:"Obtuse", wrong:["Acute","Reflex"] },
  { q:"Poland的首都是哪里?", correct:"Warsaw", wrong:["Krakow","Gdansk"] },
  { q:"Hobbit作者?", correct:"J.R.R. Tolkien", wrong:["C.S. Lewis","G.R.R. Martin"] },
  { q:"主要metal在bronze?", correct:"Copper", wrong:["Iron","Zinc"] },
  { q:"AC→DC device?", correct:"Rectifier", wrong:["Transformer","Inverter"] },
  { q:"Party balloon气体?", correct:"Helium", wrong:["Hydrogen","Neon"] },
  { q:"Sea between欧洲/Africa?", correct:"Mediterranean", wrong:["Black Sea","Baltic"] },
  { q:"UK首都?", correct:"London", wrong:["Edinburgh","Cardiff"] },
  { q:"Spain的语言是什么?", correct:"Spanish", wrong:["Catalan","Basque"] },
  { q:"Nitrogen的符号是什么?", correct:"N", wrong:["Ni","No"] },
  { q:"哪个是最大的沙漠overall?", correct:"Antarctic", wrong:["Sahara","Gobi"] },
  { q:"地球age ~?", correct:"4.5 billion yrs", wrong:["450 million","45 billion"] },
  { q:"企鹅生活在...", correct:"Southern Hemisphere", wrong:["Arctic","Both"] },
  { q:"Human DNA shape?", correct:"Double helix", wrong:["Single helix","Sheet"] },
  { q:"Doppler effect affects...", correct:"Frequency", wrong:["Mass","Charge"] },
  { q:"Speed SI单位?", correct:"m/s", wrong:["km/h","mph"] },
  { q:"CPU brain的...", correct:"Computer", wrong:["Plant","Carburetor"] },
  { q:"HTTP代表什么?", correct:"HyperText Transfer Protocol", wrong:["Hyperlink Text Tool","High Transfer Tech"] },
  { q:"RAM是...", correct:"Volatile memory", wrong:["Storage drive","CPU core"] },
  { q:"Norway的首都是哪里?", correct:"Oslo", wrong:["Bergen","Copenhagen"] },
  { q:"哪个是最大的US state?", correct:"Alaska", wrong:["Texas","California"] },
  { q:"Mt. Fuji在哪个国家?", correct:"Japan", wrong:["China","Korea"] },
  { q:"Sushi staple?", correct:"Rice", wrong:["Noodles","Bread"] },
  { q:"Baker's dozen?", correct:"13", wrong:["12","14"] },
  { q:"质数after 97?", correct:"101", wrong:["99","103"] },
  { q:"Fe是...", correct:"Iron", wrong:["Lead","Tin"] },
  { q:"D-Day year?", correct:"1944", wrong:["1942","1946"] },
  { q:"π≈?", correct:"3.14", wrong:["2.72","1.62"] },
  { q:"哪个是最大的海洋trench?", correct:"Mariana", wrong:["Java","Puerto Rico"] },
  { q:"Sahara在...", correct:"Africa", wrong:["Asia","Australia"] },
  { q:"Turkey的首都是哪里?", correct:"Ankara", wrong:["Istanbul","Izmir"] },
  { q:"大陆的Brazil?", correct:"South America", wrong:["North America","Europe"] },
  { q:"Eiffel Tower city?", correct:"Paris", wrong:["Lyon","Nice"] },
  { q:"Primary colors (light)?", correct:"RGB", wrong:["CMY","RYB"] },
  { q:"Photosynthesis气体在?", correct:"CO2", wrong:["O2","H2"] },
  { q:"CO2是...", correct:"Carbon Dioxide", wrong:["Carbon Monoxide","Carbide"] },
  { q:"DNA代表什么?", correct:"Deoxyribonucleic Acid", wrong:["Dinucleic Acid","Dual Nucleic"] },
  { q:"最热的行星avg?", correct:"Venus", wrong:["Mercury","Mars"] },
  { q:"Human恒牙?", correct:"32", wrong:["28","30"] },
  { q:"Netherlands的首都是哪里?", correct:"Amsterdam", wrong:["Rotterdam","The Hague"] },
  { q:"Switzerland的首都是哪里?", correct:"Bern", wrong:["Zurich","Geneva"] },
  { q:"Sweden的首都是哪里?", correct:"Stockholm", wrong:["Gothenburg","Malmö"] },
  { q:"Denmark的首都是哪里?", correct:"Copenhagen", wrong:["Aarhus","Odense"] },
  { q:"Finland的首都是哪里?", correct:"Helsinki", wrong:["Turku","Tampere"] },
  { q:"Norway的首都是哪里?", correct:"Oslo", wrong:["Bergen","Trondheim"] },
  { q:"Ireland的首都是哪里?", correct:"Dublin", wrong:["Cork","Galway"] },
  { q:"Scotland的首都是哪里?", correct:"Edinburgh", wrong:["Glasgow","Aberdeen"] },
  { q:"Wales的首都是哪里?", correct:"Cardiff", wrong:["Swansea","Newport"] },
  { q:"Belgium的首都是哪里?", correct:"Brussels", wrong:["Antwerp","Bruges"] },
  { q:"Austria的首都是哪里?", correct:"Vienna", wrong:["Salzburg","Graz"] },
  { q:"Czechia的首都是哪里?", correct:"Prague", wrong:["Brno","Ostrava"] },
  { q:"Hungary的首都是哪里?", correct:"Budapest", wrong:["Debrecen","Szeged"] },
  { q:"Romania的首都是哪里?", correct:"Bucharest", wrong:["Cluj-Napoca","Iasi"] },
  { q:"Bulgaria的首都是哪里?", correct:"Sofia", wrong:["Plovdiv","Varna"] },
  { q:"Greece的首都是哪里?", correct:"Athens", wrong:["Thessaloniki","Patras"] },
  { q:"Croatia的首都是哪里?", correct:"Zagreb", wrong:["Split","Dubrovnik"] },
  { q:"Serbia的首都是哪里?", correct:"Belgrade", wrong:["Novi Sad","Niš"] },
  { q:"Slovakia的首都是哪里?", correct:"Bratislava", wrong:["Košice","Nitra"] },
  { q:"Slovenia的首都是哪里?", correct:"Ljubljana", wrong:["Maribor","Koper"] },
  { q:"Bosnia & Herzegovina的首都是哪里?", correct:"Sarajevo", wrong:["Banja Luka","Tuzla"] },
  { q:"Albania的首都是哪里?", correct:"Tirana", wrong:["Shkodër","Durrës"] },
  { q:"North Macedonia的首都是哪里?", correct:"Skopje", wrong:["Ohrid","Bitola"] },
  { q:"Lithuania的首都是哪里?", correct:"Vilnius", wrong:["Kaunas","Klaipėda"] },
  { q:"Latvia的首都是哪里?", correct:"Riga", wrong:["Daugavpils","Liepāja"] },
  { q:"Estonia的首都是哪里?", correct:"Tallinn", wrong:["Tartu","Narva"] },
  { q:"Ukraine的首都是哪里?", correct:"Kyiv", wrong:["Lviv","Kharkiv"] },
  { q:"Belarus的首都是哪里?", correct:"Minsk", wrong:["Gomel","Brest"] },
  { q:"Georgia (国家)的首都是哪里?", correct:"Tbilisi", wrong:["Batumi","Kutaisi"] },
  { q:"Armenia的首都是哪里?", correct:"Yerevan", wrong:["Gyumri","Vanadzor"] },
  { q:"Azerbaijan的首都是哪里?", correct:"Baku", wrong:["Ganja","Sumqayit"] },
  { q:"Kazakhstan的首都是哪里?", correct:"Astana", wrong:["Almaty","Shymkent"] },
  { q:"Uzbekistan的首都是哪里?", correct:"Tashkent", wrong:["Samarkand","Bukhara"] },
  { q:"Turkmenistan的首都是哪里?", correct:"Ashgabat", wrong:["Turkmenabat","Mary"] },
  { q:"Kyrgyzstan的首都是哪里?", correct:"Bishkek", wrong:["Osh","Karakol"] },
  { q:"Tajikistan的首都是哪里?", correct:"Dushanbe", wrong:["Khujand","Kulob"] },
  { q:"Pakistan的首都是哪里?", correct:"Islamabad", wrong:["Karachi","Lahore"] },
  { q:"Bangladesh的首都是哪里?", correct:"Dhaka", wrong:["Chittagong","Khulna"] },
  { q:"Sri Lanka的首都是哪里?", correct:"Sri Jayawardenepura Kotte", wrong:["Colombo","Galle"] },
  { q:"Nepal的首都是哪里?", correct:"Kathmandu", wrong:["Pokhara","Lalitpur"] },
  { q:"Bhutan的首都是哪里?", correct:"Thimphu", wrong:["Paro","Punakha"] },
  { q:"Myanmar的首都是哪里?", correct:"Naypyidaw", wrong:["Yangon","Mandalay"] },
  { q:"Cambodia的首都是哪里?", correct:"Phnom Penh", wrong:["Siem Reap","Battambang"] },
  { q:"Laos的首都是哪里?", correct:"Vientiane", wrong:["Luang Prabang","Pakse"] },
  { q:"Vietnam的首都是哪里?", correct:"Hanoi", wrong:["Ho Chi Minh City","Da Nang"] },
  { q:"Malaysia的首都是哪里?", correct:"Kuala Lumpur", wrong:["Putrajaya","Johor Bahru"] },
  { q:"Indonesia的首都是哪里?", correct:"Jakarta", wrong:["Surabaya","Bandung"] },
  { q:"Thailand的首都是哪里?", correct:"Bangkok", wrong:["Chiang Mai","Pattaya"] },
  { q:"Singapore的首都是哪里?", correct:"Singapore", wrong:["—","—"] },
  { q:"Iran的首都是哪里?", correct:"Tehran", wrong:["Isfahan","Shiraz"] },
  { q:"Iraq的首都是哪里?", correct:"Baghdad", wrong:["Basra","Mosul"] },
  { q:"Saudi Arabia的首都是哪里?", correct:"Riyadh", wrong:["Jeddah","Mecca"] },
  { q:"UAE的首都是哪里?", correct:"Abu Dhabi", wrong:["Dubai","Sharjah"] },
  { q:"Qatar的首都是哪里?", correct:"Doha", wrong:["Al Rayyan","Al Wakrah"] },
  { q:"Kuwait的首都是哪里?", correct:"Kuwait City", wrong:["Hawalli","Salmiya"] },
  { q:"Oman的首都是哪里?", correct:"Muscat", wrong:["Salalah","Sohar"] },
  { q:"Yemen的首都是哪里?", correct:"Sana'a", wrong:["Aden","Taiz"] },
  { q:"Jordan的首都是哪里?", correct:"Amman", wrong:["Aqaba","Irbid"] },
  { q:"Lebanon的首都是哪里?", correct:"Beirut", wrong:["Tripoli","Sidon"] },
  { q:"Israel的首都是哪里?", correct:"Jerusalem", wrong:["Tel Aviv","Haifa"] },
  { q:"Palestine (admin)的首都是哪里?", correct:"Ramallah", wrong:["Gaza City","Jericho"] },
  { q:"Morocco的首都是哪里?", correct:"Rabat", wrong:["Casablanca","Marrakesh"] },
  { q:"Algeria的首都是哪里?", correct:"Algiers", wrong:["Oran","Constantine"] },
  { q:"Tunisia的首都是哪里?", correct:"Tunis", wrong:["Sfax","Sousse"] },
  { q:"Libya的首都是哪里?", correct:"Tripoli", wrong:["Benghazi","Misrata"] },
  { q:"Sudan的首都是哪里?", correct:"Khartoum", wrong:["Omdurman","Port Sudan"] },
  { q:"South Sudan的首都是哪里?", correct:"Juba", wrong:["Wau","Malakal"] },
  { q:"Ethiopia的首都是哪里?", correct:"Addis Ababa", wrong:["Mekele","Gondar"] },
  { q:"Eritrea的首都是哪里?", correct:"Asmara", wrong:["Massawa","Keren"] },
  { q:"Somalia的首都是哪里?", correct:"Mogadishu", wrong:["Hargeisa","Kismayo"] },
  { q:"Kenya的首都是哪里?", correct:"Nairobi", wrong:["Mombasa","Kisumu"] },
  { q:"Tanzania的首都是哪里?", correct:"Dodoma", wrong:["Dar es Salaam","Arusha"] },
  { q:"Uganda的首都是哪里?", correct:"Kampala", wrong:["Entebbe","Gulu"] },
  { q:"Rwanda的首都是哪里?", correct:"Kigali", wrong:["Gisenyi","Huye"] },
  { q:"Burundi的首都是哪里?", correct:"Gitega", wrong:["Bujumbura","Ngozi"] },
  { q:"DR Congo的首都是哪里?", correct:"Kinshasa", wrong:["Lubumbashi","Goma"] },
  { q:"Republic的Congo的首都是哪里?", correct:"Brazzaville", wrong:["Pointe-Noire","Dolisie"] },
  { q:"Angola的首都是哪里?", correct:"Luanda", wrong:["Huambo","Benguela"] },
  { q:"Namibia的首都是哪里?", correct:"Windhoek", wrong:["Walvis Bay","Swakopmund"] },
  { q:"Botswana的首都是哪里?", correct:"Gaborone", wrong:["Francistown","Maun"] },
  { q:"Zimbabwe的首都是哪里?", correct:"Harare", wrong:["Bulawayo","Mutare"] },
  { q:"Zambia的首都是哪里?", correct:"Lusaka", wrong:["Ndola","Kitwe"] },
  { q:"Mozambique的首都是哪里?", correct:"Maputo", wrong:["Beira","Nampula"] },
  { q:"Malawi的首都是哪里?", correct:"Lilongwe", wrong:["Blantyre","Mzuzu"] },
  { q:"Madagascar的首都是哪里?", correct:"Antananarivo", wrong:["Toamasina","Fianarantsoa"] },
  { q:"Mauritius的首都是哪里?", correct:"Port Louis", wrong:["Vacoas","Curepipe"] },
  { q:"Seychelles的首都是哪里?", correct:"Victoria", wrong:["Anse Boileau","Beau Vallon"] },
  { q:"Ghana的首都是哪里?", correct:"Accra", wrong:["Kumasi","Tamale"] },
  { q:"Ivory Coast的首都是哪里?", correct:"Yamoussoukro", wrong:["Abidjan","Bouaké"] },
  { q:"Nigeria的首都是哪里?", correct:"Abuja", wrong:["Lagos","Ibadan"] },
  { q:"Cameroon的首都是哪里?", correct:"Yaoundé", wrong:["Douala","Bamenda"] },
  { q:"Senegal的首都是哪里?", correct:"Dakar", wrong:["Thiès","Saint-Louis"] },
  { q:"Mali的首都是哪里?", correct:"Bamako", wrong:["Timbuktu","Sikasso"] },
  { q:"Niger的首都是哪里?", correct:"Niamey", wrong:["Agadez","Zinder"] },
  { q:"Burkina Faso的首都是哪里?", correct:"Ouagadougou", wrong:["Bobo-Dioulasso","Koudougou"] },
  { q:"Togo的首都是哪里?", correct:"Lomé", wrong:["Sokodé","Kara"] },
  { q:"Benin的首都是哪里?", correct:"Porto-Novo", wrong:["Cotonou","Parakou"] },
  { q:"Sierra Leone的首都是哪里?", correct:"Freetown", wrong:["Bo","Kenema"] },
  { q:"Liberia的首都是哪里?", correct:"Monrovia", wrong:["Gbarnga","Buchanan"] },
  { q:"Guinea的首都是哪里?", correct:"Conakry", wrong:["Kankan","Labé"] },
  { q:"Guinea-Bissau的首都是哪里?", correct:"Bissau", wrong:["Bafatá","Gabú"] },
  { q:"Gambia的首都是哪里?", correct:"Banjul", wrong:["Serekunda","Brikama"] },
  { q:"Cape Verde的首都是哪里?", correct:"Praia", wrong:["Mindelo","Assomada"] },
  { q:"Chad的首都是哪里?", correct:"N'Djamena", wrong:["Moundou","Sarh"] },
  { q:"Central非洲Rep.的首都是哪里?", correct:"Bangui", wrong:["Berbérati","Bambari"] },
  { q:"Gabon的首都是哪里?", correct:"Libreville", wrong:["Port-Gentil","Franceville"] },
  { q:"Equatorial Guinea的首都是哪里?", correct:"Malabo", wrong:["Bata","Oyala"] },
  { q:"Eswatini的首都是哪里?", correct:"Mbabane", wrong:["Lobamba","Manzini"] },
  { q:"Lesotho的首都是哪里?", correct:"Maseru", wrong:["Teyateyaneng","Mafeteng"] },
  { q:"Ethiopia coffee origin的首都是哪里?", correct:"Kaffa", wrong:["Sidamo","Harar"] },
  { q:"Tunisia ruins site的首都是哪里?", correct:"Carthage", wrong:["Sbeitla","Dougga"] },
  { q:"Jamaica的首都是哪里?", correct:"Kingston", wrong:["Montego Bay","Portmore"] },
  { q:"Cuba的首都是哪里?", correct:"Havana", wrong:["Santiago","Camagüey"] },
  { q:"Haiti的首都是哪里?", correct:"Port-au-Prince", wrong:["Cap-Haïtien","Gonaïves"] },
  { q:"Dominican Rep.的首都是哪里?", correct:"Santo Domingo", wrong:["Santiago","La Romana"] },
  { q:"Bahamas的首都是哪里?", correct:"Nassau", wrong:["Freeport","Marsh Harbour"] },
  { q:"Trinidad & Tobago的首都是哪里?", correct:"Port of Spain", wrong:["San Fernando","Chaguanas"] },
  { q:"Barbados的首都是哪里?", correct:"Bridgetown", wrong:["Speightstown","Holetown"] },
  { q:"Saint Lucia的首都是哪里?", correct:"Castries", wrong:["Soufrière","Vieux Fort"] },
  { q:"Antigua & Barbuda的首都是哪里?", correct:"St. John's", wrong:["All Saints","Codrington"] },
  { q:"Grenada的首都是哪里?", correct:"St. George's", wrong:["Gouyave","Grenville"] },
  { q:"Dominica的首都是哪里?", correct:"Roseau", wrong:["Portsmouth","Marigot"] },
  { q:"Saint Kitts & Nevis的首都是哪里?", correct:"Basseterre", wrong:["Charlestown","Sandy Point"] },
  { q:"Belize的首都是哪里?", correct:"Belmopan", wrong:["Belize City","Orange Walk"] },
  { q:"Guatemala的首都是哪里?", correct:"Guatemala City", wrong:["Antigua","Quetzaltenango"] },
  { q:"Honduras的首都是哪里?", correct:"Tegucigalpa", wrong:["San Pedro Sula","La Ceiba"] },
  { q:"El Salvador的首都是哪里?", correct:"San Salvador", wrong:["Santa Ana","San Miguel"] },
  { q:"Nicaragua的首都是哪里?", correct:"Managua", wrong:["León","Granada"] },
  { q:"Costa Rica的首都是哪里?", correct:"San José", wrong:["Alajuela","Cartago"] },
  { q:"Panama的首都是哪里?", correct:"Panama City", wrong:["Colón","David"] },
  { q:"Colombia的首都是哪里?", correct:"Bogotá", wrong:["Medellín","Cali"] },
  { q:"Venezuela的首都是哪里?", correct:"Caracas", wrong:["Maracaibo","Valencia"] },
  { q:"Ecuador的首都是哪里?", correct:"Quito", wrong:["Guayaquil","Cuenca"] },
  { q:"Peru的首都是哪里?", correct:"Lima", wrong:["Cusco","Arequipa"] },
  { q:"Bolivia的首都是哪里?", correct:"Sucre", wrong:["La Paz","Santa Cruz"] },
  { q:"Paraguay的首都是哪里?", correct:"Asunción", wrong:["Ciudad del Este","Encarnación"] },
  { q:"Uruguay的首都是哪里?", correct:"Montevideo", wrong:["Salto","Punta del Este"] },
  { q:"Chile的首都是哪里?", correct:"Santiago", wrong:["Valparaíso","Concepción"] },
  { q:"Guyana的首都是哪里?", correct:"Georgetown", wrong:["Linden","New Amsterdam"] },
  { q:"Suriname的首都是哪里?", correct:"Paramaribo", wrong:["Nieuw Nickerie","Moengo"] },
  { q:"French Guiana的首都是哪里?", correct:"Cayenne", wrong:["Kourou","Saint-Laurent"] },
  { q:"Australia的首都是哪里?", correct:"Canberra", wrong:["Sydney","Melbourne"] },
  { q:"New Zealand的首都是哪里?", correct:"Wellington", wrong:["Auckland","Christchurch"] },
  { q:"Papua New Guinea的首都是哪里?", correct:"Port Moresby", wrong:["Lae","Madang"] },
  { q:"Fiji的首都是哪里?", correct:"Suva", wrong:["Nadi","Lautoka"] },
  { q:"Samoa的首都是哪里?", correct:"Apia", wrong:["Vaitele","Faleasiu"] },
  { q:"Tonga的首都是哪里?", correct:"Nukuʻalofa", wrong:["Neiafu","Haveluloto"] },
  { q:"Vanuatu的首都是哪里?", correct:"Port Vila", wrong:["Luganville","Isangel"] },
  { q:"Solomon是lands的首都是哪里?", correct:"Honiara", wrong:["Gizo","Auki"] },
  { q:"Micronesia的首都是哪里?", correct:"Palikir", wrong:["Weno","Kolonia"] },
  { q:"Palau的首都是哪里?", correct:"Ngerulmud", wrong:["Koror","Airai"] },
  { q:"Marshall是lands的首都是哪里?", correct:"Majuro", wrong:["Ebeye","Jaluit"] },
  { q:"Kiribati的首都是哪里?", correct:"Tarawa", wrong:["Betio","Bikenibeu"] },
  { q:"Nauru的首都是哪里?", correct:"Yaren (de facto)", wrong:["Aiwo","Denigomodu"] },
  { q:"Maldives的首都是哪里?", correct:"Malé", wrong:["Addu City","Fuvahmulah"] },
  { q:"Cyprus的首都是哪里?", correct:"Nicosia", wrong:["Limassol","Larnaca"] },
  { q:"Malta的首都是哪里?", correct:"Valletta", wrong:["Sliema","Birkirkara"] },
  { q:"Iceland的首都是哪里?", correct:"Reykjavík", wrong:["Kópavogur","Akureyri"] },
  { q:"Monaco的首都是哪里?", correct:"Monaco", wrong:["Monte Carlo","La Condamine"] },
  { q:"Liechtenstein的首都是哪里?", correct:"Vaduz", wrong:["Schaan","Balzers"] },
  { q:"Andorra的首都是哪里?", correct:"Andorra la Vella", wrong:["Escaldes","Encamp"] },
  { q:"San Marino的首都是哪里?", correct:"San Marino", wrong:["Serravalle","Borgo Maggiore"] },
  { q:"Vatican City的首都是哪里?", correct:"Vatican City", wrong:["—","—"] },
  { q:"哪个是最大的月球的Saturn?", correct:"Titan", wrong:["Rhea","Iapetus"] },
  { q:"Nearest galaxy到Milky Way?", correct:"Andromeda", wrong:["Triangulum","Large Magellanic"] },
  { q:"Star一群forming pattern?", correct:"Constellation", wrong:["Cluster","Nebula"] },
  { q:"气体大与Great红色Spot?", correct:"Jupiter", wrong:["Saturn","Neptune"] },
  { q:"最热的行星surface?", correct:"Venus", wrong:["Mercury","Mars"] },
  { q:"太阳layer visible在eclipse ring?", correct:"Chromosphere", wrong:["Core","Photosphere"] },
  { q:"Earth's core主要?", correct:"Iron–Nickel", wrong:["Silicon","Carbon"] },
  { q:"Igneous rock来自lava?", correct:"Basalt", wrong:["Marble","Sandstone"] },
  { q:"Sedimentary rock来自sand?", correct:"Sandstone", wrong:["Slate","Granite"] },
  { q:"Metamorphic来自limestone?", correct:"Marble", wrong:["Gneiss","Shale"] },
  { q:"pH < 7是什么意思?", correct:"Acidic", wrong:["Basic","Neutral"] },
  { q:"NaHCO₃是?", correct:"Baking soda", wrong:["Table salt","Bleach"] },
  { q:"CH₄ common name?", correct:"Methane", wrong:["Ethane","Propane"] },
  { q:"Vitamin D主要source?", correct:"Sunlight", wrong:["Meat","Salt"] },
  { q:"Insulin targets哪个器官?", correct:"Liver", wrong:["Heart","Spleen"] },
  { q:"Blood type universal donor?", correct:"O negative", wrong:["AB positive","A positive"] },
  { q:"哪个是最大的artery?", correct:"Aorta", wrong:["Carotid","Femoral"] },
  { q:"Cell powerhouses?", correct:"Mitochondria", wrong:["Ribosomes","Lysosomes"] },
  { q:"植物cell wall material?", correct:"Cellulose", wrong:["Chitin","Keratin"] },
  { q:"DNA base not在RNA?", correct:"Thymine", wrong:["Adenine","Guanine"] },
  { q:"Human成年人vertebrae count?", correct:"33", wrong:["26","42"] },
  { q:"Number的ribs (typical)?", correct:"24", wrong:["22","26"] },
  { q:"Fast reflex arc center?", correct:"Spinal cord", wrong:["Cerebrum","Medulla"] },
  { q:"Device measuring humidity?", correct:"Hygrometer", wrong:["Anemometer","Altimeter"] },
  { q:"Force SI单位?", correct:"Newton", wrong:["Joule","Watt"] },
  { q:"Energy SI单位?", correct:"Joule", wrong:["Newton","Pascal"] },
  { q:"Power SI单位?", correct:"Watt", wrong:["Volt","Ohm"] },
  { q:"Pressure SI单位?", correct:"Pascal", wrong:["Bar","Torr"] },
  { q:"Electric charge unit?", correct:"Coulomb", wrong:["Tesla","Farad"] },
  { q:"Resistance law name?", correct:"Ohm's law", wrong:["Hooke's law","Boyle's law"] },
  { q:"气体law PV=nRT是?", correct:"Ideal gas law", wrong:["Charles's law","Boyle's law"] },
  { q:"Sound speed是最快的在?", correct:"Solid", wrong:["Liquid","Gas"] },
  { q:"Light splits通过?", correct:"Prism", wrong:["Lens","Mirror"] },
  { q:"Rainbow是caused按?", correct:"Dispersion", wrong:["Reflection only","Refraction only"] },
  { q:"哪个是最大的现存structure?", correct:"Great Barrier Reef", wrong:["Amazon","Sahara"] },
  { q:"最深的lake按volume?", correct:"Baikal", wrong:["Tanganyika","Superior"] },
  { q:"哪个是最高的waterfall?", correct:"Angel Falls", wrong:["Iguazu","Victoria"] },
  { q:"哪个是最小的大陆?", correct:"Australia", wrong:["Europe","Antarctica"] },
  { q:"Most populous国家 (2020s)?", correct:"India", wrong:["China","USA"] },
  { q:"货币的Switzerland?", correct:"Swiss franc", wrong:["Euro","Krone"] },
  { q:"货币的Mexico?", correct:"Peso", wrong:["Real","Dollar"] },
  { q:"货币的Brazil?", correct:"Real", wrong:["Peso","Cruzeiro"] },
  { q:"货币的South Africa?", correct:"Rand", wrong:["Shilling","Metical"] },
  { q:"货币的Russia?", correct:"Ruble", wrong:["Hryvnia","Lari"] },
  { q:"货币的Turkey?", correct:"Lira", wrong:["Dinar","Dirham"] },
  { q:"哪个是最大的city在USA?", correct:"New York City", wrong:["Los Angeles","Chicago"] },
  { q:"US state与Grand Canyon?", correct:"Arizona", wrong:["Utah","New Mexico"] },
  { q:"US state被称为Sunshine State?", correct:"Florida", wrong:["Arizona","California"] },
  { q:"US首都?", correct:"Washington, D.C.", wrong:["New York","Philadelphia"] },
  { q:"Canada's最大的province?", correct:"Quebec", wrong:["Ontario","British Columbia"] },
  { q:"语言的Quebec?", correct:"French", wrong:["English","Spanish"] },
  { q:"Italy shape nicknamed?", correct:"Boot", wrong:["Shoe","Hook"] },
  { q:"Landlocked在S. 美洲?", correct:"Paraguay", wrong:["Uruguay","Ecuador"] },
  { q:"仅大陆在all hemispheres?", correct:"Africa", wrong:["Asia","South America"] },
  { q:"Antarctica有no...", correct:"Permanent residents", wrong:["Ice","Mountains"] },
  { q:"Oldest written语言widely used?", correct:"Chinese", wrong:["Latin","Greek"] },
  { q:"Alphabet与26 letters?", correct:"English", wrong:["Russian","Greek"] },
  { q:"语言与Cyrillic script?", correct:"Russian", wrong:["Polish","Czech"] },
  { q:"Spanish为 'thank you'?", correct:"Gracias", wrong:["Graciaso","Grazie"] },
  { q:"French为 'hello'?", correct:"Bonjour", wrong:["Hola","Ciao"] },
  { q:"Italian为 'goodbye'?", correct:"Arrivederci", wrong:["Adiós","Au revoir"] },
  { q:"German为 'please'?", correct:"Bitte", wrong:["Danke","S'il vous plaît"] },
  { q:"Japanese greeting morning?", correct:"Ohayō", wrong:["Konbanwa","Arigatō"] },
  { q:"World's最长的陆地border pair?", correct:"US–Canada", wrong:["Russia–Kazakhstan","Argentina–Chile"] },
  { q:"发明者的light bulb (mass market)?", correct:"Thomas Edison", wrong:["Nikola Tesla","Faraday"] },
  { q:"Periodic table creator?", correct:"Dmitri Mendeleev", wrong:["Lavoisier","Dalton"] },
  { q:"Father的genetics?", correct:"Gregor Mendel", wrong:["Watson","Crick"] },
  { q:"发现了gravity tale?", correct:"Isaac Newton", wrong:["Galileo","Kepler"] },
  { q:"Pen name 'Mark Twain'?", correct:"Samuel Clemens", wrong:["Jack London","S. King"] },
  { q:"Sherlock Holmes作者?", correct:"Arthur Conan Doyle", wrong:["Agatha Christie","Poe"] },
  { q:"Frankenstein作者?", correct:"Mary Shelley", wrong:["Bram Stoker","Jane Austen"] },
  { q:"Brave New World作者?", correct:"Aldous Huxley", wrong:["Orwell","Bradbury"] },
  { q:"War and Peace作者?", correct:"Leo Tolstoy", wrong:["Dostoevsky","Chekhov"] },
  { q:"Iliad作者?", correct:"Homer", wrong:["Virgil","Sophocles"] },
  { q:"Sistine Chapel ceiling按?", correct:"Michelangelo", wrong:["Raphael","Donatello"] },
  { q:"Guernica画家?", correct:"Picasso", wrong:["Matisse","Miró"] },
  { q:"Persistence的Memory画家?", correct:"Dalí", wrong:["Magritte","Kandinsky"] },
  { q:"Thinker sculptor?", correct:"Rodin", wrong:["Bernini","Canova"] },
  { q:"Beethoven's 9th key?", correct:"D minor", wrong:["C major","G major"] },
  { q:"Mozart nationality?", correct:"Austrian", wrong:["German","Italian"] },
  { q:"Chopin instrument?", correct:"Piano", wrong:["Violin","Cello"] },
  { q:"鲨鱼that's biggest?", correct:"Whale shark", wrong:["Great white","Basking shark"] },
  { q:"哺乳动物that产卵?", correct:"Platypus", wrong:["Dolphin","Bat"] },
  { q:"鸟类that can't fly?", correct:"Ostrich", wrong:["Eagle","Pelican"] },
  { q:"仅flying哺乳动物?", correct:"Bat", wrong:["Flying squirrel","Colugo"] },
  { q:"昆虫与100+ 条腿?", correct:"Centipede", wrong:["Millipede","Earwig"] },
  { q:"哪个是最大的reptile?", correct:"Saltwater crocodile", wrong:["Anaconda","Komodo dragon"] },
  { q:"哪个是最快的鸟类 (dive)?", correct:"Peregrine falcon", wrong:["Golden eagle","Albatross"] },
  { q:"Polar bear原产于region?", correct:"Arctic", wrong:["Antarctic","Alps"] },
  { q:"动物known为 'ship的desert'?", correct:"Camel", wrong:["Horse","Donkey"] },
  { q:"熊猫食物主要?", correct:"Bamboo", wrong:["Fish","Insects"] },
  { q:"考拉eats?", correct:"Eucalyptus", wrong:["Acacia","Grass"] },
  { q:"哪个是最大的rodent?", correct:"Capybara", wrong:["Beaver","Porcupine"] },
  { q:"章鱼hearts?", correct:"3", wrong:["1","2"] },
  { q:"蜘蛛条腿count?", correct:"8", wrong:["6","10"] },
  { q:"Honeybee colony leader?", correct:"Queen", wrong:["Worker","Drone"] },
  { q:"海洋tide causes?", correct:"Moon gravity", wrong:["Sun heat","Wind only"] },
  { q:"El Niño affects?", correct:"Pacific currents", wrong:["Atlantic ice","Indian monsoon only"] },
  { q:"Greenhouse气体?", correct:"Methane", wrong:["Argon","Helium"] },
  { q:"Ozone layer absorbs?", correct:"UV", wrong:["IR","Radio"] },
  { q:"Renewable energy source?", correct:"Solar", wrong:["Coal","Oil"] },
  { q:"Fossil fuel?", correct:"Coal", wrong:["Wind","Hydro"] },
  { q:"主要cause的seasons?", correct:"Axial tilt", wrong:["Orbit shape","Moon pull"] },
  { q:"地球revolution length?", correct:"~365 days", wrong:["~24 hours","~28 days"] },
  { q:"月球phase fully lit?", correct:"Full moon", wrong:["New moon","Quarter"] },
  { q:"Tectonic boundary causing quakes?", correct:"Transform", wrong:["Shield","Stable craton"] },
  { q:"Richter scale measures?", correct:"Magnitude", wrong:["Intensity (Mercalli)","Depth"] },
  { q:"Volcano与gentle slopes?", correct:"Shield", wrong:["Stratovolcano","Cinder cone"] },
  { q:"Driest non-polar沙漠?", correct:"Atacama", wrong:["Sahara","Gobi"] },
  { q:"河through Paris?", correct:"Seine", wrong:["Loire","Rhône"] },
  { q:"河through London?", correct:"Thames", wrong:["Avon","Tyne"] },
  { q:"河through Rome?", correct:"Tiber", wrong:["Arno","Po"] },
  { q:"河through Berlin?", correct:"Spree", wrong:["Elbe","Oder"] },
  { q:"Great Lakes mnemonics?", correct:"HOMES", wrong:["ROMES","DOMES"] },
  { q:"语言的Iran?", correct:"Persian", wrong:["Arabic","Kurdish"] },
  { q:"语言的是rael?", correct:"Hebrew", wrong:["Arabic","Aramaic"] },
  { q:"语言的Ethiopia?", correct:"Amharic", wrong:["Tigrinya","Oromo"] },
  { q:"语言的Kenya (official)?", correct:"English & Swahili", wrong:["Swahili only","English only"] },
  { q:"语言的Brazil?", correct:"Portuguese", wrong:["Spanish","French"] },
  { q:"Arabic script方向?", correct:"Right to left", wrong:["Left to right","Top to bottom"] },
  { q:"Binary digits是?", correct:"0 and 1", wrong:["0–9","A–F"] },
  { q:"Web 'HTTP' protocol type?", correct:"Application layer", wrong:["Link layer","Physical layer"] },
  { q:"CPU代表什么?", correct:"Central Processing Unit", wrong:["Core Primary Unit","Compute Power Unit"] },
  { q:"GPU主要为?", correct:"Graphics", wrong:["Storage","Networking"] },
  { q:"SSD代表什么?", correct:"Solid State Drive", wrong:["Soft Storage Disk","Serial Static Disk"] },
  { q:"Wi-Fi encryption strong?", correct:"WPA2/WPA3", wrong:["WEP","Open"] },
  { q:"Keyboard key 'Esc'是什么意思?", correct:"Escape", wrong:["Exit","Erase"] },
  { q:"Director的Inception?", correct:"Christopher Nolan", wrong:["David Fincher","Denis Villeneuve"] },
  { q:"Titanic leads?", correct:"DiCaprio & Winslet", wrong:["Pitt & Jolie","Hanks & Ryan"] },
  { q:"Hobbit played按?", correct:"Elijah Wood", wrong:["Daniel Radcliffe","Rupert Grint"] },
  { q:"Wakanda king?", correct:"T’Challa", wrong:["Killmonger","M’Baku"] },
  { q:"Matrix hero's alias?", correct:"Neo", wrong:["Morpheus","Cypher"] },
  { q:"Toy Story cowboy?", correct:"Woody", wrong:["Buzz","Rex"] },
  { q:"Frozen ice queen?", correct:"Elsa", wrong:["Anna","Olaf"] },
  { q:"Jurassic Park park founder?", correct:"John Hammond", wrong:["Ian Malcolm","Alan Grant"] },
  { q:"Avatar行星?", correct:"Pandora", wrong:["Arrakis","LV-426"] },
  { q:"Alien's ship?", correct:"Nostromo", wrong:["Serenity","Event Horizon"] },
  { q:"Shawshank prison name?", correct:"Shawshank State", wrong:["Green River","Cold Mountain"] },
  { q:"Rocky's city?", correct:"Philadelphia", wrong:["Boston","Chicago"] },
  { q:"Kill Bill director?", correct:"Quentin Tarantino", wrong:["Guy Ritchie","Robert Rodriguez"] },
  { q:"LotR ring destroy place?", correct:"Mount Doom", wrong:["Moria","Minas Tirith"] },
  { q:"Terminator's actor?", correct:"Arnold Schwarzenegger", wrong:["Sylvester Stallone","Bruce Willis"] },
  { q:"Die Hard building?", correct:"Nakatomi Plaza", wrong:["Stark Tower","Wayne Tower"] },
  { q:"Jaws director?", correct:"Steven Spielberg", wrong:["Ron Howard","James Cameron"] },
  { q:"Mad Max wasteland cop?", correct:"Max Rockatansky", wrong:["Snake Plissken","John Matrix"] },
  { q:"Back到Future car?", correct:"DeLorean", wrong:["Camaro","Mustang"] },
  { q:"Indiana Jones' job?", correct:"Archaeologist", wrong:["Geologist","Anthropologist"] },
  { q:"Pulp Fiction briefcase color?", correct:"Gold glow", wrong:["Blue glow","Green glow"] },
  { q:"Godfather family?", correct:"Corleone", wrong:["Soprano","Gambino"] },
  { q:"Spirited Away studio?", correct:"Ghibli", wrong:["Gainax","Toei"] },
  { q:"Shrek是...", correct:"Ogre", wrong:["Troll","Giant"] },
  { q:"Star Wars droid duo?", correct:"R2-D2 & C-3PO", wrong:["BB-8 & K-2SO","IG-11 & HK-47"] },
  { q:"Batman's city?", correct:"Gotham", wrong:["Metropolis","Star City"] },
  { q:"铁Man's name?", correct:"Tony Stark", wrong:["Steve Rogers","Bruce Wayne"] },
  { q:"Joker actor (2019)?", correct:"Joaquin Phoenix", wrong:["Heath Ledger","Jared Leto"] },
  { q:"Parasite film在哪个国家?", correct:"South Korea", wrong:["Japan","China"] },
  { q:"La La陆地setting?", correct:"Los Angeles", wrong:["New York","San Francisco"] },
  { q:"Room director-star?", correct:"Tommy Wiseau", wrong:["Greg Sestero","James Franco"] },
  { q:"Blade Runner replicant test?", correct:"Voight-Kampff", wrong:["Bechdel","Kobayashi"] },
  { q:"Furiosa's world?", correct:"Mad Max", wrong:["Dune","Blade Runner"] },
  { q:"Princess Bride swordsman?", correct:"Inigo Montoya", wrong:["Westley","Vizzini"] },
  { q:"Marty McFly actor?", correct:"Michael J. Fox", wrong:["Corey Feldman","Emilio Estevez"] },
  { q:"E.T. phone...", correct:"Home", wrong:["Mom","Earth"] },
  { q:"Up floating aid?", correct:"Balloons", wrong:["Kites","Parachutes"] },
  { q:"WALL·E's robot partner?", correct:"EVE", wrong:["AVA","ADA"] },
  { q:"Spidey's aunt?", correct:"May", wrong:["June","Jane"] },
  { q:"Panem heroine?", correct:"Katniss Everdeen", wrong:["Tris Prior","Bella Swan"] },
  { q:"Hogwarts house的Harry?", correct:"Gryffindor", wrong:["Ravenclaw","Slytherin"] },
  { q:"Horror与puzzle box?", correct:"Hellraiser", wrong:["Saw","The Cube"] },
  { q:"第一个Pixar feature?", correct:"Toy Story", wrong:["A Bug’s Life","Monsters, Inc."] },
  { q:"LotR director?", correct:"Peter Jackson", wrong:["Sam Raimi","Ridley Scott"] },
  { q:"Nolan's WWII film?", correct:"Dunkirk", wrong:["1917","Midway"] },
  { q:"Bond's codename?", correct:"007", wrong:["008","009"] },
  { q:"Bond creator?", correct:"Ian Fleming", wrong:["John le Carré","Anthony Horowitz"] },
  { q:"Borat's国家 (in-film)?", correct:"Kazakhstan", wrong:["Uzbekistan","Azerbaijan"] },
  { q:"Studio behind MCU?", correct:"Marvel Studios", wrong:["Lucasfilm","Legendary"] },
  { q:"Chihiro's workplace?", correct:"Bathhouse", wrong:["Bakery","Onsen Inn"] },
  { q:"Friends' coffee shop?", correct:"Central Perk", wrong:["Monk’s Café","MacLaren’s"] },
  { q:"Breaking Bad alter ego?", correct:"Heisenberg", wrong:["Red John","Professor"] },
  { q:"Game的Thrones, 哪个dragons breath made铁throne?", correct:"Balerion the Black Dread", wrong:["Vhagar","Vermithor"] },
  { q:"Office boss (US S1-7)?", correct:"Michael Scott", wrong:["Andy Bernard","Jim Halpert"] },
  { q:"Stranger Things town?", correct:"Hawkins", wrong:["Derry","Sunnydale"] },
  { q:"Crown follows...", correct:"Queen Elizabeth II", wrong:["Princess Diana","Queen Victoria"] },
  { q:"House M.D.'s specialty?", correct:"Diagnostics", wrong:["Surgery","Pediatrics"] },
  { q:"Sherlock's address?", correct:"221B Baker St", wrong:["10 Downing St","12 Grimmauld Pl"] },
  { q:"Rick's grandson?", correct:"Morty", wrong:["Jerry","Summer"] },
  { q:"Westworld park type?", correct:"Western", wrong:["Medieval","Sci-fi"] },
  { q:"Lost是land's flight?", correct:"Oceanic 815", wrong:["Oceanic 713","Oceanic 501"] },
  { q:"Sopranos' profession?", correct:"Mob", wrong:["Police","Politicians"] },
  { q:"Peaky Blinders city?", correct:"Birmingham", wrong:["Manchester","Liverpool"] },
  { q:"Doctor谁's ship?", correct:"TARDIS", wrong:["Serenity","Rocinante"] },
  { q:"Mandalorian species kid?", correct:"Yoda’s species", wrong:["Ewok","Wookiee"] },
  { q:"Seinfeld是about...", correct:"Nothing", wrong:["Dating","Law"] },
  { q:"Better Call Saul主要job?", correct:"Lawyer", wrong:["PI","Journalist"] },
  { q:"Wire city?", correct:"Baltimore", wrong:["Detroit","Chicago"] },
  { q:"Boys corporation?", correct:"Vought", wrong:["Oscorp","LexCorp"] },
  { q:"HBO dragon show?", correct:"House of the Dragon", wrong:["Wheel of Time","Witcher"] },
  { q:"Money Heist original title?", correct:"La Casa de Papel", wrong:["La Casa de Oro","El Robo"] },
  { q:"Dexter's code targets?", correct:"Killers", wrong:["Thieves","Cops"] },
  { q:"Twin Peaks agent?", correct:"Dale Cooper", wrong:["Fox Mulder","Rust Cohle"] },
  { q:"Chernobyl作者?", correct:"Craig Mazin", wrong:["Vince Gilligan","Jesse Armstrong"] },
  { q:"Succession family name?", correct:"Roy", wrong:["Logan","Reed"] },
  { q:"Last的Us girl?", correct:"Ellie", wrong:["Clementine","Alyx"] },
  { q:"Black Mirror creator?", correct:"Charlie Brooker", wrong:["Charlie Cox","Graham Linehan"] },
  { q:"Arcane game universe?", correct:"League of Legends", wrong:["Dota 2","Overwatch"] },
  { q:"Witcher's witcher?", correct:"Geralt", wrong:["Ciri","Dandelion"] },
  { q:"Starfleet ship在TNG?", correct:"Enterprise-D", wrong:["Voyager","Defiant"] },
  { q:"Firefly ship?", correct:"Serenity", wrong:["Rocinante","Bebop"] },
  { q:"X-Files agents?", correct:"Mulder & Scully", wrong:["Booth & Brennan","Rigsby & Van Pelt"] },
  { q:"如何I Met Your Mother bar?", correct:"MacLaren’s", wrong:["Paddy’s Pub","Central Perk"] },
  { q:"Parks & Rec town?", correct:"Pawnee", wrong:["Scranton","Springfield"] },
  { q:"Avatar: Last Airbender hero?", correct:"Aang", wrong:["Korra","Zuko"] },
  { q:"Simpsons幼年?", correct:"Maggie", wrong:["Lisa","Milhouse"] },
  { q:"Family Guy dad?", correct:"Peter Griffin", wrong:["Homer Simpson","Bob Belcher"] },
  { q:"BoJack's profession?", correct:"Actor", wrong:["Musician","Chef"] },
  { q:"Narcos kingpin focus?", correct:"Pablo Escobar", wrong:["El Chapo","Felix Gallardo"] },
  { q:"Expanse ship?", correct:"Rocinante", wrong:["Nostromo","Eventide"] },
  { q:"Thriller artist?", correct:"Michael Jackson", wrong:["Prince","Madonna"] },
  { q:"Beatles drummer?", correct:"Ringo Starr", wrong:["Keith Moon","Charlie Watts"] },
  { q:"Queen's lead singer?", correct:"Freddie Mercury", wrong:["Bowie","Jagger"] },
  { q:"Nirvana frontman?", correct:"Kurt Cobain", wrong:["Eddie Vedder","Billy Corgan"] },
  { q:"Beyoncé's former一群?", correct:"Destiny’s Child", wrong:["TLC","En Vogue"] },
  { q:"Adele's debut album?", correct:"19", wrong:["21","25"] },
  { q:"Taylor Swift 2014 album?", correct:"1989", wrong:["Reputation","Red"] },
  { q:"Kanye's debut?", correct:"The College Dropout", wrong:["Late Registration","Graduation"] },
  { q:"Eminem alter ego?", correct:"Slim Shady", wrong:["Marshall Mathers","Rap God"] },
  { q:"Dr. Dre headphone brand?", correct:"Beats", wrong:["Skullcandy","Bose"] },
  { q:"Daft Punk在哪个国家?", correct:"France", wrong:["UK","USA"] },
  { q:"ABBA在哪个国家?", correct:"Sweden", wrong:["Norway","Denmark"] },
  { q:"U2 singer?", correct:"Bono", wrong:["Edge","Sting"] },
  { q:"Metallica genre?", correct:"Thrash metal", wrong:["Grunge","Punk"] },
  { q:"Linkin Park rapper?", correct:"Mike Shinoda", wrong:["Chester Bennington","Joe Hahn"] },
  { q:"Coldplay vocalist?", correct:"Chris Martin", wrong:["Thom Yorke","Brandon Flowers"] },
  { q:"Billie Eilish brother?", correct:"Finneas", wrong:["Phineas","Felix"] },
  { q:"K-pop一群与ARMY?", correct:"BTS", wrong:["Blackpink","EXO"] },
  { q:"Blackpink member named Lisa?", correct:"Yes", wrong:["No","Only in stage show"] },
  { q:"Ariana Grande TV origin?", correct:"Victorious", wrong:["Glee","iCarly"] },
  { q:"Lady Gaga debut single?", correct:"Just Dance", wrong:["Poker Face","Bad Romance"] },
  { q:"Rihanna是陆地?", correct:"Barbados", wrong:["Bahamas","Jamaica"] },
  { q:"Shakira hometown在哪个国家?", correct:"Colombia", wrong:["Spain","Mexico"] },
  { q:"Reggae icon?", correct:"Bob Marley", wrong:["Peter Tosh","Jimmy Cliff"] },
  { q:"Weeknd real第一个name?", correct:"Abel", wrong:["Tesfaye","Starboy"] },
  { q:"Ed Sheeran instrument?", correct:"Guitar", wrong:["Drums","Violin"] },
  { q:"Adele nationality?", correct:"British", wrong:["American","Irish"] },
  { q:"Pink Floyd album prism?", correct:"The Dark Side of the Moon", wrong:["The Wall","Wish You Were Here"] },
  { q:"Radiohead 1997 album?", correct:"OK Computer", wrong:["Kid A","The Bends"] },
  { q:"Oasis siblings?", correct:"Gallagher", wrong:["Davies","Reid"] },
  { q:"Fleetwood Mac hit album?", correct:"Rumours", wrong:["Tusk","Mirage"] },
  { q:"Prince符号color?", correct:"Purple", wrong:["Red","Gold"] },
  { q:"Elvis nickname?", correct:"The King", wrong:["The Boss","The Duke"] },
  { q:"Madonna title?", correct:"Queen of Pop", wrong:["Princess of Pop","Empress of Pop"] },
  { q:"Bowie alter ego?", correct:"Ziggy Stardust", wrong:["Thin White Duke","Major Tom"] },
  { q:"AC/DC brothers?", correct:"Young", wrong:["Gallagher","Van Halen"] },
  { q:"Foo Fighters founder?", correct:"Dave Grohl", wrong:["Josh Homme","Tom Morello"] },
  { q:"Green Day rock opera?", correct:"American Idiot", wrong:["Dookie","Warning"] },
  { q:"Kendrick album与DAMN.?", correct:"DAMN.", wrong:["good kid, m.A.A.d city","To Pimp a Butterfly"] },
  { q:"Drake hometown?", correct:"Toronto", wrong:["Vancouver","Montreal"] },
  { q:"Post Malone face feature?", correct:"Tattoos", wrong:["Piercings","Scarification"] },
  { q:"Sia signature look?", correct:"Half-blonde wig", wrong:["Blue hair","Eye mask"] },
  { q:"Imagine Dragons genre?", correct:"Pop rock", wrong:["EDM","Metal"] },
  { q:"Killers city anthem?", correct:"Mr. Brightside", wrong:["Human","When You Were Young"] },
  { q:"北极Monkeys debut?", correct:"Whatever People Say I Am…", wrong:["AM","Favourite Worst Nightmare"] },
  { q:"Strokes debut?", correct:"Is This It", wrong:["Room on Fire","First Impressions"] },
  { q:"Cure frontman?", correct:"Robert Smith", wrong:["Morrissey","Ian Curtis"] },
  { q:"Joy Division successor band?", correct:"New Order", wrong:["The Smiths","Depeche Mode"] },
  { q:"Depeche Mode genre?", correct:"Synth-pop", wrong:["Grunge","Ska"] },
  { q:"Run-DMC footwear brand?", correct:"Adidas", wrong:["Nike","Puma"] },
  { q:"Beastie Boys trio size?", correct:"Three", wrong:["Two","Four"] },
  { q:"Notorious B.I.G. city?", correct:"Brooklyn", wrong:["Compton","Atlanta"] },
  { q:"Tupac alias?", correct:"2Pac", wrong:["Hov","Slim"] },
  { q:"Jay-Z label?", correct:"Roc-A-Fella", wrong:["Aftermath","Top Dawg"] },
  { q:"Nicki Minaj alter ego?", correct:"Roman", wrong:["Slim","Barbie Tingz"] },
  { q:"Cardi B reality show?", correct:"Love & Hip Hop", wrong:["Bad Girls Club","The Voice"] },
  { q:"Dua Lipa nationality?", correct:"British-Albanian", wrong:["American","Australian"] },
  { q:"Harry Styles band?", correct:"One Direction", wrong:["5SOS","The Wanted"] },
  { q:"Selena Gomez network start?", correct:"Disney", wrong:["Nickelodeon","CW"] },
  { q:"Director的Social Network?", correct:"David Fincher", wrong:["Christopher Nolan","Sam Mendes"] },
  { q:"Director的Arrival?", correct:"Denis Villeneuve", wrong:["James Cameron","Ridley Scott"] },
  { q:"Lead的John Wick?", correct:"Keanu Reeves", wrong:["Jason Statham","Tom Cruise"] },
  { q:"主要city在Dark Knight?", correct:"Gotham City", wrong:["Metropolis","Star City"] },
  { q:"Alien catchphrase 'Get away来自her, you—' heroine?", correct:"Ripley", wrong:["Sarah Connor","Trinity"] },
  { q:"Ship在Interstellar?", correct:"Endurance", wrong:["Avalon","Discovery One"] },
  { q:"Villain在No国家为Old Men?", correct:"Anton Chigurh", wrong:["Frank Booth","Keyser Söze"] },
  { q:"Director的Blade Runner 2049?", correct:"Denis Villeneuve", wrong:["Zack Snyder","Neill Blomkamp"] },
  { q:"City的Joker (2019)?", correct:"Gotham", wrong:["Chicago","Newark"] },
  { q:"Lead robot在铁大?", correct:"The Giant", wrong:["Number 5","Bishop"] },
  { q:"Pixar robot cleaning地球?", correct:"WALL·E", wrong:["Baymax","Bender"] },
  { q:"Antagonist AI在2001?", correct:"HAL 9000", wrong:["Skynet","GLaDOS"] },
  { q:"Director的Grand Budapest Hotel?", correct:"Wes Anderson", wrong:["Paul Thomas Anderson","Noah Baumbach"] },
  { q:"City在Blade Runner (1982)?", correct:"Los Angeles", wrong:["Tokyo","New York"] },
  { q:"Fellowship wizard?", correct:"Gandalf", wrong:["Dumbledore","Merlin"] },
  { q:"主要villain在Dark Knight?", correct:"Joker", wrong:["Bane","Two-Face"] },
  { q:"Director的Whiplash?", correct:"Damien Chazelle", wrong:["Damien Leone","Shane Black"] },
  { q:"Hero的Gladiator?", correct:"Maximus", wrong:["Spartacus","Achilles"] },
  { q:"Movie与'I am your father'?", correct:"The Empire Strikes Back", wrong:["A New Hope","Return of the Jedi"] },
  { q:"City在Ghostbusters (1984)?", correct:"New York", wrong:["Chicago","Boston"] },
  { q:"Lead的Silence的Lambs?", correct:"Clarice Starling", wrong:["Ellen Ripley","Laurie Strode"] },
  { q:"Killer clown在It?", correct:"Pennywise", wrong:["Art the Clown","Captain Spaulding"] },
  { q:"Director的Get Out?", correct:"Jordan Peele", wrong:["Ari Aster","Nia DaCosta"] },
  { q:"Director的Her?", correct:"Spike Jonze", wrong:["Sofia Coppola","Richard Linklater"] },
  { q:"Heist film与'是you watching closely?'?", correct:"The Prestige", wrong:["The Illusionist","Now You See Me"] },
  { q:"Dream-sharing device name在Inception?", correct:"PASIV", wrong:["REM-9","Somnus"] },
  { q:"Liam Neeson's character在Taken?", correct:"Bryan Mills", wrong:["John Wick","Jack Reacher"] },
  { q:"Villain在Skyfall?", correct:"Raoul Silva", wrong:["Le Chiffre","Blofeld"] },
  { q:"Heroine的Alien (1979)?", correct:"Ellen Ripley", wrong:["Sarah Connor","Dana Barrett"] },
  { q:"Director的Revenant?", correct:"Alejandro G. Iñárritu", wrong:["Alfonso Cuarón","Guillermo del Toro"] },
  { q:"Monster在Shape的水是...", correct:"Amphibian Man", wrong:["Gill-man","Sea Devil"] },
  { q:"Director的Mad Max: Fury Road?", correct:"George Miller", wrong:["George Lucas","George Romero"] },
  { q:"主要thief在Heat (1995)?", correct:"Neil McCauley", wrong:["Patrick Kenzie","Danny Ocean"] },
  { q:"Heist leader在Ocean's Eleven (2001)?", correct:"Danny Ocean", wrong:["Rusty Ryan","Linus Caldwell"] },
  { q:"Horror place: Overlook Hotel film?", correct:"The Shining", wrong:["Psycho","The Others"] },
  { q:"'There是no spoon' movie?", correct:"The Matrix", wrong:["Dark City","Equilibrium"] },
  { q:"Director的Sicario?", correct:"Denis Villeneuve", wrong:["Taylor Sheridan","Antoine Fuqua"] },
  { q:"Villain在Incredibles?", correct:"Syndrome", wrong:["Lotso","Hopper"] },
  { q:"Lead的Black Widow?", correct:"Natasha Romanoff", wrong:["Yelena Belova","Pepper Potts"] },
  { q:"Wes Anderson hotel concierge?", correct:"M. Gustave", wrong:["Zero","Dimitri"] },
  { q:"Ring inscription的语言是什么?", correct:"Black Speech", wrong:["Elvish","Dwarvish"] },
  { q:"Captain在Jaws?", correct:"Quint", wrong:["Brody","Hooper"] },
  { q:"Director的Oldboy (2003)?", correct:"Park Chan-wook", wrong:["Bong Joon-ho","Na Hong-jin"] },
  { q:"Hero在Die Hard是John...", correct:"McClane", wrong:["Wick","Connor"] },
  { q:"主要city在Se7en?", correct:"Unspecified", wrong:["Los Angeles","New York"] },
  { q:"Villain一群在Dark Knight Rises?", correct:"League of Shadows", wrong:["Hydra","Foot Clan"] },
  { q:"Lead的Mummy (1999)?", correct:"Rick O’Connell", wrong:["Nathan Drake","Ben Gates"] },
  { q:"Director的La Haine?", correct:"Mathieu Kassovitz", wrong:["Gaspar Noé","Luc Besson"] },
  { q:"Anime film与红色motorcycle?", correct:"Akira", wrong:["Paprika","Redline"] },
  { q:"Director的Roma (2018)?", correct:"Alfonso Cuarón", wrong:["Iñárritu","Del Toro"] },
  { q:"House的cards US lead?", correct:"Frank Underwood", wrong:["Saul Goodman","Don Draper"] },
  { q:"Mad Men ad man?", correct:"Don Draper", wrong:["Harvey Specter","Tony Soprano"] },
  { q:"主要setting的Office (US)?", correct:"Scranton", wrong:["Albany","Stamford"] },
  { q:"主要detective在True Detective S1?", correct:"Rust Cohle", wrong:["Jake Peralta","Elliot Stabler"] },
  { q:"BB spin-off lawyer?", correct:"Saul Goodman", wrong:["Chuck McGill","Howard Hamlin"] },
  { q:"Dragon queen在GoT?", correct:"Daenerys Targaryen", wrong:["Cersei Lannister","Sansa Stark"] },
  { q:"Winterfell family name?", correct:"Stark", wrong:["Targaryen","Baratheon"] },
  { q:"GOT sword 'Needle' owner?", correct:"Arya", wrong:["Jon","Brienne"] },
  { q:"Walking Dead sheriff?", correct:"Rick Grimes", wrong:["Daryl Dixon","Shane Walsh"] },
  { q:"Prison-break genius?", correct:"Michael Scofield", wrong:["Dominic Toretto","Jack Bauer"] },
  { q:"24's agent?", correct:"Jack Bauer", wrong:["Jason Bourne","Ethan Hunt"] },
  { q:"CSI代表什么?", correct:"Crime Scene Investigation", wrong:["Criminal Scene Inquiry","Case Study Investigation"] },
  { q:"Peaky Blinders leader?", correct:"Tommy Shelby", wrong:["Arthur Shelby","Alfie Solomons"] },
  { q:"Boys hero与laser eyes?", correct:"Homelander", wrong:["A-Train","The Deep"] },
  { q:"Boys vigilante leader?", correct:"Billy Butcher", wrong:["Hughie","Frenchie"] },
  { q:"Loki variants show是在?", correct:"Loki", wrong:["What If...?","WandaVision"] },
  { q:"WandaVision town?", correct:"Westview", wrong:["Hawkins","Smallville"] },
  { q:"月球Knight's deity ally?", correct:"Khonshu", wrong:["Anubis","Osiris"] },
  { q:"Hawkeye's partner?", correct:"Kate Bishop", wrong:["Yelena Belova","Sharon Carter"] },
  { q:"She-Hulk's real name?", correct:"Jennifer Walters", wrong:["Jessica Jones","Carol Danvers"] },
  { q:"Witcher bard name?", correct:"Jaskier", wrong:["Dandelion","Lambert"] },
  { q:"鱿鱼Game number的lead?", correct:"456", wrong:["101","218"] },
  { q:"鱿鱼Game organizer alias?", correct:"Front Man", wrong:["Game Master","Overseer"] },
  { q:"Crown质数minister ally early?", correct:"Winston Churchill", wrong:["Harold Wilson","Tony Blair"] },
  { q:"Ozark family surname?", correct:"Byrde", wrong:["White","Fisher"] },
  { q:"Expanse detective在Ceres?", correct:"Miller", wrong:["Holden","Amos"] },
  { q:"Leftovers % vanished?", correct:"2%", wrong:["5%","10%"] },
  { q:"Westworld park creator?", correct:"Robert Ford", wrong:["William","Bernard Lowe"] },
  { q:"Lost是陆地guardian?", correct:"Jacob", wrong:["Desmond","Ben Linus"] },
  { q:"Sons的Anarchy club?", correct:"SAMCRO", wrong:["SAMTAC","SAVAGE"] },
  { q:"Orange是New Black prison?", correct:"Litchfield", wrong:["Fox River","Wentworth"] },
  { q:"Stranger Things monster nickname S1?", correct:"Demogorgon", wrong:["Mind Flayer","Vecna"] },
  { q:"Better Call Saul brother?", correct:"Chuck McGill", wrong:["Howard Hamlin","Nacho Varga"] },
  { q:"Fargo是famous为...", correct:"True-crime style anthology", wrong:["Sitcom format","Single-camera soap"] },
  { q:"Barry's profession?", correct:"Hitman", wrong:["Cop","Lawyer"] },
  { q:"Ted Lasso club?", correct:"AFC Richmond", wrong:["West Ham","Manchester City"] },
  { q:"Wire drug crew kingpin?", correct:"Avon Barksdale", wrong:["Marlo Stanfield","Stringer Bell"] },
  { q:"Wire cop nickname 'Bunk'?", correct:"William Moreland", wrong:["Jimmy McNulty","Kima Greggs"] },
  { q:"Chernobyl植物name?", correct:"V.I. Lenin", wrong:["Kursk","Zaporizhzhia"] },
  { q:"Severance company?", correct:"Lumon", wrong:["InGen","Abstergo"] },
  { q:"Mr. Robot hacker一群?", correct:"fsociety", wrong:["Anonymous","DedSec"] },
  { q:"Black Mirror episode与bikes?", correct:"Fifteen Million Merits", wrong:["Nosedive","Playtest"] },
  { q:"True Detective S1 setting state?", correct:"Louisiana", wrong:["Texas","Florida"] },
  { q:"Narcos DEA agent?", correct:"Steve Murphy", wrong:["Hank Schrader","Kiki Camarena"] },
  { q:"Mandalorian lead actor?", correct:"Pedro Pascal", wrong:["Diego Luna","Oscar Isaac"] },
  { q:"Andor's rebellion cell?", correct:"Aldhani crew", wrong:["Phoenix Squadron","Rogue One"] },
  { q:"House的Dragon house war?", correct:"Greens vs Blacks", wrong:["Wolf vs Lion","Sun vs Moon"] },
  { q:"Last的Us fungus?", correct:"Cordyceps", wrong:["Candida","Aspergillus"] },
  { q:"Arcane sisters?", correct:"Vi & Jinx", wrong:["Lux & Garen","Ashe & Sejuani"] },
  { q:"Sherlock's partner?", correct:"John Watson", wrong:["Greg Lestrade","Mycroft Holmes"] },
  { q:"Luther actor?", correct:"Idris Elba", wrong:["Chiwetel Ejiofor","John Boyega"] },
  { q:"Killing Eve assassin?", correct:"Villanelle", wrong:["Nikita","Elektra"] },
  { q:"Handmaid's Tale name?", correct:"June Osborne", wrong:["Offglen","Serena Joy"] },
  { q:"Boys speedster?", correct:"A-Train", wrong:["Starlight","Black Noir"] },
  { q:"Umbrella Academy leader?", correct:"Luther", wrong:["Diego","Five"] },
  { q:"Daredevil's city?", correct:"Hell’s Kitchen", wrong:["Queens","Harlem"] },
  { q:"Jessica Jones villain S1?", correct:"Kilgrave", wrong:["Kingpin","Bullseye"] },
  { q:"Punisher real name?", correct:"Frank Castle", wrong:["Matt Murdock","Marc Spector"] },
  { q:"Mindhunter subject focus?", correct:"Serial killers", wrong:["Bank robbers","Kidnappers"] },
  { q:"Hannibal's profiler?", correct:"Will Graham", wrong:["Clarice Starling","Jack Crawford"] },
  { q:"Breaking Bad city?", correct:"Albuquerque", wrong:["El Paso","Phoenix"] },
  { q:"Suits closer?", correct:"Harvey Specter", wrong:["Mike Ross","Louis Litt"] },
  { q:"Good Place architect?", correct:"Michael", wrong:["Jason","Chidi"] },
  { q:"Brooklyn Nine-Nine precinct?", correct:"99th", wrong:["12th","21st"] },
  { q:"Community college name?", correct:"Greendale", wrong:["Riverdale","Springfield"] },
  { q:"Arrested Development narrator?", correct:"Ron Howard", wrong:["Morgan Freeman","Bob Saget"] },
  { q:"Office prank victim?", correct:"Dwight Schrute", wrong:["Stanley Hudson","Kevin Malone"] },
  { q:"Parks & Rec boss early seasons?", correct:"Ron Swanson", wrong:["Chris Traeger","Ben Wyatt"] },
  { q:"Modern Family patriarch?", correct:"Jay Pritchett", wrong:["Phil Dunphy","Mitch Pritchett"] },
  { q:"Soccer field players per side?", correct:"10 outfield", wrong:["9 outfield","11 outfield"] },
  { q:"Basketball players在court per team?", correct:"5", wrong:["6","4"] },
  { q:"Baseball outs per half-inning?", correct:"3", wrong:["2","4"] },
  { q:"Tennis points sequence starts?", correct:"0 (love)", wrong:["5","10"] },
  { q:"Golf lowest score wins?", correct:"Yes", wrong:["No","Match only"] },
  { q:"Olympic黄金为第一个place?", correct:"Yes", wrong:["No","Only world champs"] },
  { q:"Marathon distance (km)?", correct:"42.195", wrong:["40.000","45.000"] },
  { q:"Boxing number的corners?", correct:"4", wrong:["3","5"] },
  { q:"Soccer红色card effect?", correct:"Player sent off", wrong:["10-min sin bin","Penalty only"] },
  { q:"Cricket overs per bowler limit在ODIs?", correct:"10", wrong:["8","12"] },
  { q:"NBA shot clock (seconds)?", correct:"24", wrong:["30","35"] },
  { q:"NFL touchdown points?", correct:"6", wrong:["7","5"] },
  { q:"Rugby union players per side?", correct:"15", wrong:["13","14"] },
  { q:"Rugby league players per side?", correct:"13", wrong:["15","12"] },
  { q:"Ice hockey period count?", correct:"3", wrong:["2","4"] },
  { q:"NHL rink surface是...", correct:"Ice", wrong:["Synthetic","Wood"] },
  { q:"Table tennis winning game points?", correct:"11", wrong:["15","21"] },
  { q:"Badminton shuttle是被称为?", correct:"Shuttlecock", wrong:["Featherball","Birdball"] },
  { q:"Volleyball players per team在court?", correct:"6", wrong:["7","5"] },
  { q:"Handball players per side (incl. keeper)?", correct:"7", wrong:["6","8"] },
  { q:"水polo players per side在水?", correct:"7", wrong:["6","8"] },
  { q:"Snooker balls total在start?", correct:"22", wrong:["21","23"] },
  { q:"Darts standard board top number?", correct:"20", wrong:["1","12"] },
  { q:"Tennis tiebreak typical第一个到?", correct:"7", wrong:["10","5"] },
  { q:"Grand Slam surfaces count?", correct:"3", wrong:["2","4"] },
  { q:"Wimbledon surface?", correct:"Grass", wrong:["Clay","Hard"] },
  { q:"Roland-Garros surface?", correct:"Clay", wrong:["Grass","Carpet"] },
  { q:"US Open surface?", correct:"Hard", wrong:["Clay","Grass"] },
  { q:"Australian Open surface?", correct:"Hard", wrong:["Clay","Grass"] },
  { q:"Soccer penalty spot distance (m)?", correct:"11", wrong:["9","12"] },
  { q:"Basketball 3-point line farther在哪?", correct:"NBA", wrong:["NCAA","FIBA (men)"] },
  { q:"Cricket wicket consists的?", correct:"3 stumps, 2 bails", wrong:["2 stumps, 1 bail","4 stumps, 2 bails"] },
  { q:"Cricket LBW代表什么?", correct:"Leg Before Wicket", wrong:["Leg Behind Wicket","Left Batting Wide"] },
  { q:"Athletics 100 m start stance?", correct:"Blocks", wrong:["Standing","Jog-in"] },
  { q:"Heptathlon是为women traditionally?", correct:"Yes", wrong:["No","Mixed only"] },
  { q:"Decathlon events count?", correct:"10", wrong:["8","12"] },
  { q:"Swimming medley order (IM)?", correct:"Fly, Back, Breast, Free", wrong:["Back, Fly, Breast, Free","Fly, Breast, Back, Free"] },
  { q:"F1 pit lane speed limit (approx km/h)?", correct:"80", wrong:["120","60"] },
  { q:"F1 points为win (modern)?", correct:"25", wrong:["20","30"] },
  { q:"MotoGP two wheels?", correct:"Yes", wrong:["No","Sidecars only"] },
  { q:"Cycling Grand Tours count?", correct:"3", wrong:["2","4"] },
  { q:"Tour de France jersey为leader?", correct:"Yellow", wrong:["Green","Polka dot"] },
  { q:"Tour jersey为best climber?", correct:"Polka dot", wrong:["Green","White"] },
  { q:"Tour jersey为points leader?", correct:"Green", wrong:["White","Red"] },
  { q:"Soccer offside requires two opponents incl. keeper?", correct:"Yes", wrong:["No","Three"] },
  { q:"VAR代表什么?", correct:"Video Assistant Referee", wrong:["Virtual Assistant Replay","Video Adjudication Review"] },
  { q:"Baseball strikeouts为immaculate inning?", correct:"3 on 9 pitches", wrong:["3 on 10","2 on 6"] },
  { q:"Baseball bases count在field?", correct:"4", wrong:["3","5"] },
  { q:"Softball underhand pitching?", correct:"Yes", wrong:["No","Only slowpitch"] },
  { q:"NBA 3-point value?", correct:"3", wrong:["2","4"] },
  { q:"Free throw value?", correct:"1", wrong:["2","3"] },
  { q:"NFL field goal points?", correct:"3", wrong:["2","4"] },
  { q:"Two-point conversion after TD?", correct:"2", wrong:["1","3"] },
  { q:"Soccer match length regular?", correct:"90 minutes", wrong:["80","100"] },
  { q:"Rugby try points (union)?", correct:"5", wrong:["4","6"] },
  { q:"Rugby conversion points?", correct:"2", wrong:["1","3"] },
  { q:"Rugby drop goal points (union)?", correct:"3", wrong:["2","4"] },
  { q:"Cricket T20 overs per side?", correct:"20", wrong:["25","15"] },
  { q:"Cricket ODI overs per side?", correct:"50", wrong:["40","60"] },
  { q:"Cricket Test max days?", correct:"5", wrong:["4","6"] },
  { q:"Tennis deuce是什么意思?", correct:"40–40", wrong:["30–30","Advantage"] },
  { q:"Tennis Grand Slams per year?", correct:"4", wrong:["3","5"] },
  { q:"Boxing belt organizations exist?", correct:"Multiple", wrong:["Single","None"] },
  { q:"MMA octagon sides?", correct:"8", wrong:["6","10"] },
  { q:"Judo point为match-ending throw?", correct:"Ippon", wrong:["Waza-ari","Yuko"] },
  { q:"Karate colored belts indicate?", correct:"Rank", wrong:["Weight","Age"] },
  { q:"Olympic rings colors count?", correct:"5", wrong:["4","6"] },
  { q:"Curling stone material?", correct:"Granite", wrong:["Marble","Basalt"] },
  { q:"Curling sweeping effect?", correct:"Reduces friction", wrong:["Adds spin","Adds weight"] },
  { q:"Rowing eight uses多少oars total?", correct:"8 sweep oars", wrong:["16 sculls","10"] },
  { q:"Fencing weapons count?", correct:"3", wrong:["2","4"] },
  { q:"Gym vault apparatus?", correct:"Table", wrong:["Horse","Beam"] },
  { q:"Figure skating jump与toe pick?", correct:"Toe loop", wrong:["Axel","Salchow"] },
  { q:"Axel jump takes off...", correct:"Forward", wrong:["Backward","Flat"] },
  { q:"Biathlon sports combo?", correct:"Skiing & shooting", wrong:["Skiing & skating","Running & shooting"] },
  { q:"Triathlon order?", correct:"Swim, Bike, Run", wrong:["Run, Bike, Swim","Bike, Swim, Run"] },
  { q:"Ironman marathon distance?", correct:"42.195 km", wrong:["21.0975 km","50 km"] },
  { q:"Cricket run out requires?", correct:"Ball hits stumps before bat/runner in", wrong:["Bowler calls","Keeper appeal only"] },
  { q:"Soccer hat-trick goals?", correct:"3", wrong:["4","2"] },
  { q:"Basketball triple-double needs 10+在...", correct:"Three stats", wrong:["Two stats","Any one stat"] },
  { q:"Baseball cycle includes?", correct:"1B, 2B, 3B, HR", wrong:["Two HR, 2B, 1B","1B, 2B, HR, BB"] },
  { q:"Golf par在hole是什么意思?", correct:"Expected strokes", wrong:["Average of field","Max strokes"] },
  { q:"Eagle relative到par?", correct:"-2", wrong:["-1","-3"] },
  { q:"Albatross relative到par?", correct:"-3", wrong:["-2","-4"] },
  { q:"Basketball violation为steps?", correct:"Traveling", wrong:["Carrying","Goaltend"] },
  { q:"Goaltending legal?", correct:"No", wrong:["Yes","Only on dunks"] },
  { q:"Soccer yellow cards equal红色在?", correct:"Two", wrong:["Three","Four"] },
  { q:"Tennis doubles alleys used?", correct:"Yes", wrong:["No","Only on serve"] },
  { q:"Volleyball rally scoring是什么意思?", correct:"Point every rally", wrong:["Point on serve only","Side-out only"] },
  { q:"Beach volleyball team size?", correct:"2", wrong:["3","4"] },
  { q:"NFL field length (yards)?", correct:"100 (plus end zones)", wrong:["110","90"] },
  { q:"NFL OT regular season format includes?", correct:"Possession rules", wrong:["Golden goal","Penalty kicks"] },
  { q:"NHL power play skaters (usual)?", correct:"5 vs 4", wrong:["6 vs 5","4 vs 3"] },
  { q:"Offside在ice hockey line?", correct:"Blue line", wrong:["Red line","Goal line"] },
  { q:"Cricket powerplay restricts?", correct:"Fielders outside circle", wrong:["Bowler speed","Bouncer count"] },
  { q:"Tennis serve second chance?", correct:"Second serve", wrong:["Let only","No"] },
  { q:"Athletics relay baton exchange zone (m)?", correct:"30", wrong:["10","20"] },
  { q:"Shot put weight (men, kg)?", correct:"7.26", wrong:["6.00","8.50"] },
  { q:"High jump technique common?", correct:"Fosbury Flop", wrong:["Scissor","Straddle"] },
  { q:"Pole vault landing在?", correct:"Foam mats", wrong:["Sand","Water"] },
  { q:"Sailing windward是什么意思?", correct:"Toward wind", wrong:["Away from wind","Across wind"] },
  { q:"Rowing coxswain steers?", correct:"Yes", wrong:["No","Only at start"] },
  { q:"Skateboarding trick 'ollie'是...", correct:"No-hand jump", wrong:["Spin only","Foot plant"] },
  { q:"Surfing stance names?", correct:"Regular/Goofy", wrong:["Front/Back","Left/Right"] },
  { q:"Climbing lead fall caught按?", correct:"Belayer", wrong:["Spotter","Setter"] },
  { q:"Boxing weight classes exist?", correct:"Yes", wrong:["No","Height only"] },
  { q:"Wrestling styles Olympic?", correct:"Freestyle & Greco-Roman", wrong:["Sambo & Sumo","Collegiate & Catch"] },
  { q:"MMA rounds championship length?", correct:"5 x 5 min", wrong:["3 x 3","5 x 3"] },
  { q:"Tennis let在serve是...", correct:"Replay the point", wrong:["Fault","Opp. point"] },
  { q:"Cricket free hit after?", correct:"No-ball", wrong:["Wide","Bouncer"] },
  { q:"Basketball backcourt violation time (NBA)?", correct:"8 seconds", wrong:["10 seconds","5 seconds"] },
  { q:"Basketball key 3-second rule applies到?", correct:"Offense in paint", wrong:["Defense only","Any player backcourt"] },
  { q:"第一个emperor的Rome?", correct:"Augustus", wrong:["Julius Caesar","Nero"] },
  { q:"City哪里democracy began?", correct:"Athens", wrong:["Rome","Sparta"] },
  { q:"Hammurabi ruled哪个empire?", correct:"Babylonian", wrong:["Assyrian","Hittite"] },
  { q:"Egyptian boy-king?", correct:"Tutankhamun", wrong:["Ramses II","Akhenaten"] },
  { q:"Built Great Pyramid?", correct:"Khufu", wrong:["Khafre","Menkaure"] },
  { q:"河的ancient Egypt?", correct:"Nile", wrong:["Tigris","Indus"] },
  { q:"Founder的Achaemenid Empire?", correct:"Cyrus the Great", wrong:["Darius I","Xerxes I"] },
  { q:"Persian invasion repelled在Marathon year?", correct:"490 BC", wrong:["480 BC","500 BC"] },
  { q:"Philosopher wrote Republic?", correct:"Plato", wrong:["Aristotle","Socrates"] },
  { q:"Alexander Great's teacher?", correct:"Aristotle", wrong:["Plato","Socrates"] },
  { q:"Carthaginian general与大象?", correct:"Hannibal", wrong:["Hamilcar","Hasdrubal"] },
  { q:"Roman arena为gladiators?", correct:"Colosseum", wrong:["Circus Maximus","Pantheon"] },
  { q:"Pax Romana began under?", correct:"Augustus", wrong:["Trajan","Hadrian"] },
  { q:"Constantine's首都?", correct:"Constantinople", wrong:["Antioch","Ravenna"] },
  { q:"Year Western Rome fell?", correct:"476", wrong:["410","527"] },
  { q:"Byzantine law code?", correct:"Justinian Code", wrong:["Twelve Tables","Napoleonic Code"] },
  { q:"Religion founded按Siddhartha?", correct:"Buddhism", wrong:["Jainism","Hinduism"] },
  { q:"Chinese philosophy的Laozi?", correct:"Daoism", wrong:["Legalism","Mohism"] },
  { q:"Built Grand Canal?", correct:"Sui dynasty", wrong:["Tang","Song"] },
  { q:"发明了paper (dynasty)?", correct:"Han", wrong:["Qin","Zhou"] },
  { q:"Genghis Khan united哪个people?", correct:"Mongols", wrong:["Huns","Tatars"] },
  { q:"Conqueror的1066?", correct:"William I", wrong:["Harold Godwinson","Harald Hardrada"] },
  { q:"Magna Carta year?", correct:"1215", wrong:["1066","1295"] },
  { q:"Black Death century (欧洲)?", correct:"14th", wrong:["12th","16th"] },
  { q:"Mali emperor famed为wealth?", correct:"Mansa Musa", wrong:["Sundiata","Askia"] },
  { q:"Incan首都?", correct:"Cusco", wrong:["Quito","Lima"] },
  { q:"Aztec首都?", correct:"Tenochtitlan", wrong:["Teotihuacan","Tlaxcala"] },
  { q:"Chinese treasure fleet admiral?", correct:"Zheng He", wrong:["Sun Zi","Yue Fei"] },
  { q:"Gutenberg's invention?", correct:"Movable type press", wrong:["Paper mill","Steam press"] },
  { q:"Fought在Agincourt?", correct:"Hundred Years’ War", wrong:["Wars of the Roses","Napoleonic Wars"] },
  { q:"Spanish expulsion的Moors结束在?", correct:"1492", wrong:["1517","1453"] },
  { q:"Sailed为Spain在1492?", correct:"Columbus", wrong:["Magellan","Cabot"] },
  { q:"Portuguese route到India navigator?", correct:"Vasco da Gama", wrong:["Dias","Cabral"] },
  { q:"Aztecs conquered按?", correct:"Cortés", wrong:["Pizarro","Balboa"] },
  { q:"Inca conquered按?", correct:"Pizarro", wrong:["Cortés","Orellana"] },
  { q:"Reformation began与?", correct:"Luther’s 95 Theses", wrong:["Calvin’s Institutes","Henry VIII’s Act"] },
  { q:"English Church split ruler?", correct:"Henry VIII", wrong:["Edward VI","Mary I"] },
  { q:"Spanish Armada defeated在哪?", correct:"1588", wrong:["1605","1571"] },
  { q:"Mughal emperor的Taj Mahal?", correct:"Shah Jahan", wrong:["Akbar","Aurangzeb"] },
  { q:"Ottoman capture的Constantinople?", correct:"1453", wrong:["1204","1529"] },
  { q:"Thirty Years' War结束按?", correct:"Peace of Westphalia", wrong:["Treaty of Utrecht","Treaty of Paris"] },
  { q:"太阳King的France?", correct:"Louis XIV", wrong:["Louis XVI","Louis XIII"] },
  { q:"Russian westernizer czar?", correct:"Peter the Great", wrong:["Ivan IV","Nicholas I"] },
  { q:"Enlightenment作者的Social Contract?", correct:"Rousseau", wrong:["Locke","Montesquieu"] },
  { q:"American Revolution第一个shots在?", correct:"Lexington & Concord", wrong:["Bunker Hill","Yorktown"] },
  { q:"US Declaration adopted?", correct:"1776", wrong:["1783","1789"] },
  { q:"French Revolution began在哪?", correct:"1789", wrong:["1793","1776"] },
  { q:"Storming的Bastille date?", correct:"14 July 1789", wrong:["5 May 1789","9 Thermidor"] },
  { q:"Reign的Terror leader?", correct:"Robespierre", wrong:["Danton","Marat"] },
  { q:"Defeated在Waterloo?", correct:"Napoleon", wrong:["Wellington","Blücher"] },
  { q:"Haitian Revolution leader?", correct:"Toussaint Louverture", wrong:["Bolívar","San Martín"] },
  { q:"Liberator的much的South美洲?", correct:"Simón Bolívar", wrong:["José de San Martín","Miguel Hidalgo"] },
  { q:"Industrial Revolution started在哪?", correct:"Britain", wrong:["France","Prussia"] },
  { q:"Spinning Jenny发明者?", correct:"James Hargreaves", wrong:["Arkwright","Cartwright"] },
  { q:"Steam engine improved按?", correct:"James Watt", wrong:["Stephenson","Fulton"] },
  { q:"第一个modern railway line在哪个国家?", correct:"England", wrong:["USA","Germany"] },
  { q:"Congress的Vienna date range?", correct:"1814–1815", wrong:["1804–1805","1820–1821"] },
  { q:"Irish Great Famine crop?", correct:"Potato", wrong:["Wheat","Oats"] },
  { q:"1848 waves是?", correct:"Revolutions", wrong:["Epidemics","Colonizations"] },
  { q:"Unifier的Italy?", correct:"Garibaldi", wrong:["Mazzini","Cavour"] },
  { q:"German Empire proclaimed在?", correct:"Versailles", wrong:["Frankfurt","Berlin"] },
  { q:"US Civil War began在哪?", correct:"1861", wrong:["1859","1865"] },
  { q:"US Emancipation Proclamation year?", correct:"1863", wrong:["1861","1865"] },
  { q:"Assassinated US president在1865?", correct:"Abraham Lincoln", wrong:["James Garfield","Andrew Johnson"] },
  { q:"Meiji Restoration在哪个国家?", correct:"Japan", wrong:["China","Korea"] },
  { q:"Boer War fought在哪?", correct:"South Africa", wrong:["Sudan","Nigeria"] },
  { q:"Scramble为Africa century?", correct:"19th", wrong:["18th","20th"] },
  { q:"Russo-Japanese War winner?", correct:"Japan", wrong:["Russia","Draw"] },
  { q:"Assassination sparked WWI city?", correct:"Sarajevo", wrong:["Vienna","Belgrade"] },
  { q:"Treaty ending WWI与Germany?", correct:"Versailles", wrong:["Brest-Litovsk","Trianon"] },
  { q:"Russian 1917 revolution第一个leader?", correct:"Lenin", wrong:["Kerensky","Trotsky"] },
  { q:"League的Nations formed after?", correct:"WWI", wrong:["Russo-Japanese War","Boer War"] },
  { q:"Spanish Civil War years?", correct:"1936–1939", wrong:["1931–1934","1940–1943"] },
  { q:"Leader的Spanish Nationalists?", correct:"Francisco Franco", wrong:["Juan Negrín","Primo de Rivera"] },
  { q:"Weimar Republic在哪个国家?", correct:"Germany", wrong:["Austria","Hungary"] },
  { q:"New Deal president?", correct:"FDR", wrong:["Hoover","Truman"] },
  { q:"第一个用途的atomic bombs在cities?", correct:"1945", wrong:["1944","1946"] },
  { q:"Cold War primary rivals?", correct:"USA & USSR", wrong:["USA & China","USSR & UK"] },
  { q:"Berlin Airlift year start?", correct:"1948", wrong:["1950","1946"] },
  { q:"NATO founded在哪?", correct:"1949", wrong:["1945","1955"] },
  { q:"Chinese PRC proclaimed按?", correct:"Mao Zedong", wrong:["Sun Yat-sen","Deng Xiaoping"] },
  { q:"Korean War decade?", correct:"1950s", wrong:["1940s","1960s"] },
  { q:"Cuban Missile Crisis year?", correct:"1962", wrong:["1961","1963"] },
  { q:"French withdrawal来自Algeria?", correct:"1962", wrong:["1958","1965"] },
  { q:"India partition year?", correct:"1947", wrong:["1950","1945"] },
  { q:"Israel declared independence在哪?", correct:"1948", wrong:["1947","1956"] },
  { q:"South非洲apartheid began officially在哪?", correct:"1948", wrong:["1954","1960"] },
  { q:"Iranian Revolution year?", correct:"1979", wrong:["1978","1981"] },
  { q:"Soviet invasion的Afghanistan year?", correct:"1979", wrong:["1981","1977"] },
  { q:"Chernobyl disaster year?", correct:"1986", wrong:["1984","1989"] },
  { q:"Berlin Wall built在哪?", correct:"1961", wrong:["1953","1968"] },
  { q:"Berlin Wall fell在哪?", correct:"1989", wrong:["1991","1987"] },
  { q:"USSR dissolved在哪?", correct:"1991", wrong:["1989","1993"] },
  { q:"Rwandan genocide year?", correct:"1994", wrong:["1992","1996"] },
  { q:"Yugoslav wars 1990s region?", correct:"Balkans", wrong:["Caucasus","Baltics"] },
  { q:"Maastricht Treaty created?", correct:"European Union", wrong:["NATO","Schengen Zone"] },
  { q:"Mandela elected president year?", correct:"1994", wrong:["1990","1996"] },
  { q:"9/11 attacks year?", correct:"2001", wrong:["2000","2003"] },
  { q:"Arab Spring began在哪?", correct:"2010", wrong:["2008","2012"] },
  { q:"Brexit referendum year?", correct:"2016", wrong:["2014","2018"] },
  { q:"COVID-19 declared pandemic year?", correct:"2020", wrong:["2019","2021"] },
  { q:"第一个woman到fly solo across Atlantic?", correct:"Amelia Earhart", wrong:["Bessie Coleman","Harriet Quimby"] },
  { q:"Nobel Prize founder?", correct:"Alfred Nobel", wrong:["Albert Nobel","Anders Celsius"] },
  { q:"第一个printed Bible在欧洲?", correct:"Gutenberg Bible", wrong:["King James Bible","Vulgate"] },
  { q:"Polish astronomer heliocentric?", correct:"Copernicus", wrong:["Kepler","Tycho Brahe"] },
  { q:"Law的gravitation作者?", correct:"Isaac Newton", wrong:["Galileo","Descartes"] },
  { q:"第一个circumnavigation led到completion按?", correct:"Elcano", wrong:["Magellan","Cabral"] },
  { q:"Suffragette leader UK?", correct:"Emmeline Pankhurst", wrong:["Millicent Fawcett","Emily Davison"] },
  { q:"第一个US national park?", correct:"Yellowstone", wrong:["Yosemite","Grand Canyon"] },
  { q:"Zulu War famous last stand?", correct:"Rorke’s Drift", wrong:["Isandlwana","Ulundi"] },
  { q:"Boxer Rebellion在哪个国家?", correct:"China", wrong:["Korea","Japan"] },
  { q:"Opium Wars fought按Qing vs?", correct:"Britain", wrong:["France","Russia"] },
  { q:"Suez Crisis year?", correct:"1956", wrong:["1967","1953"] },
  { q:"UN founded在哪?", correct:"1945", wrong:["1944","1946"] },
  { q:"第一个man在space?", correct:"Yuri Gagarin", wrong:["Alan Shepard","Valentina Tereshkova"] },
  { q:"第一个woman在space?", correct:"Valentina Tereshkova", wrong:["Sally Ride","Laika"] },
   { q:"SI base units count?", correct:"7", wrong:["6","8"] },
  { q:"Avogadro's number approx?", correct:"6.02×10^23", wrong:["3.00×10^8","1.60×10^-19"] },
  { q:"Planck constant的符号是什么?", correct:"h", wrong:["k","λ"] },
  { q:"Charge的electron?", correct:"Negative", wrong:["Positive","Neutral"] },
  { q:"Light-year measures?", correct:"Distance", wrong:["Time","Speed"] },
  { q:"pH的neutral水 (25°C)?", correct:"7", wrong:["6","8"] },
  { q:"气体law PV=nRT name?", correct:"Ideal gas law", wrong:["Boyle’s law","Charles’s law"] },
  { q:"Boyle's law keeps...", correct:"Temperature constant", wrong:["Pressure constant","Volume constant"] },
  { q:"Charles's law keeps...", correct:"Pressure constant", wrong:["Temperature constant","Amount constant"] },
  { q:"Catalyst effect?", correct:"Lowers activation energy", wrong:["Raises equilibrium constant","Stops reaction"] },
  { q:"Oxidation是...", correct:"Loss of electrons", wrong:["Gain of electrons","Neutron loss"] },
  { q:"Reduction是...", correct:"Gain of electrons", wrong:["Loss of electrons","Gain of protons"] },
  { q:"Ionic bond between?", correct:"Metal & nonmetal", wrong:["Two metals","Two nonmetals only"] },
  { q:"Covalent bond shares...", correct:"Electrons", wrong:["Protons","Neutrons"] },
  { q:"Most electronegative element?", correct:"Fluorine", wrong:["Oxygen","Chlorine"] },
  { q:"Halogens一群number?", correct:"17", wrong:["16","18"] },
  { q:"Noble gases一群?", correct:"18", wrong:["1","17"] },
  { q:"Rows的periodic table是...", correct:"Periods", wrong:["Groups","Families"] },
  { q:"Solid到气体directly?", correct:"Sublimation", wrong:["Deposition","Condensation"] },
  { q:"气体到solid directly?", correct:"Deposition", wrong:["Sublimation","Evaporation"] },
  { q:"Endothermic reaction...", correct:"Absorbs heat", wrong:["Releases heat","No heat change"] },
  { q:"Exothermic reaction...", correct:"Releases heat", wrong:["Absorbs heat","Stores heat only"] },
  { q:"DNA sugar?", correct:"Deoxyribose", wrong:["Ribose","Glucose"] },
  { q:"RNA base absent在DNA?", correct:"Uracil", wrong:["Thymine","Adenine"] },
  { q:"DNA到mRNA process?", correct:"Transcription", wrong:["Translation","Replication"] },
  { q:"mRNA到protein process?", correct:"Translation", wrong:["Transcription","Duplication"] },
  { q:"Protein factories在cells?", correct:"Ribosomes", wrong:["Lysosomes","Centrioles"] },
  { q:"ATP made主要在哪?", correct:"Mitochondria", wrong:["Golgi","Nucleus"] },
  { q:"Cell's post office?", correct:"Golgi apparatus", wrong:["Rough ER","Lysosome"] },
  { q:"Photosynthesis occurs在哪?", correct:"Chloroplasts", wrong:["Mitochondria","Nucleus"] },
  { q:"气体entering leaves通过?", correct:"Stomata", wrong:["Xylem","Phloem"] },
  { q:"Nitrogen fixation按?", correct:"Bacteria", wrong:["Fungi only","Algae only"] },
  { q:"Fungal cell walls made的?", correct:"Chitin", wrong:["Cellulose","Peptidoglycan"] },
  { q:"Prokaryotes lack?", correct:"Nucleus", wrong:["Ribosomes","Cell membrane"] },
  { q:"Human blood type system?", correct:"ABO", wrong:["MN","Rh only"] },
  { q:"Blood oxygen carriers?", correct:"Hemoglobin", wrong:["Myosin","Insulin"] },
  { q:"Nephron是在...", correct:"Kidney", wrong:["Liver","Spleen"] },
  { q:"Alveoli function?", correct:"Gas exchange", wrong:["Enzyme secretion","Electrical signaling"] },
  { q:"Insulin lowers...", correct:"Blood glucose", wrong:["Blood oxygen","Body temp"] },
  { q:"CRISPR nuclease经常used?", correct:"Cas9", wrong:["Taq","EcoRI"] },
  { q:"Mendel studied...", correct:"Pea plants", wrong:["Fruit flies","Corn"] },
  { q:"Dominant allele masks...", correct:"Recessive", wrong:["Codominant","Sex-linked"] },
  { q:"Earth's atmosphere主要气体?", correct:"Nitrogen", wrong:["Oxygen","CO2"] },
  { q:"Layer与weather?", correct:"Troposphere", wrong:["Stratosphere","Mesosphere"] },
  { q:"Ozone layer lies在...", correct:"Stratosphere", wrong:["Troposphere","Thermosphere"] },
  { q:"Greenhouse effect traps...", correct:"Infrared", wrong:["Ultraviolet","Gamma"] },
  { q:"Coriolis deflection在N. Hemisphere?", correct:"To the right", wrong:["To the left","None"] },
  { q:"La Niñ是什么意思...", correct:"Cooler eastern Pacific", wrong:["Warmer eastern Pacific","Weaker trade winds only"] },
  { q:"Plate boundary forming new crust?", correct:"Divergent", wrong:["Convergent","Transform"] },
  { q:"Subduction occurs在...", correct:"Convergent boundary", wrong:["Divergent","Hot spot only"] },
  { q:"Earth's outer core是...", correct:"Liquid", wrong:["Solid","Plasma"] },
  { q:"Mohs hardness 10?", correct:"Diamond", wrong:["Corundum","Topaz"] },
  { q:"Igneous rock formed inside地球?", correct:"Intrusive", wrong:["Extrusive","Sedimentary"] },
  { q:"Mercalli scale measures...", correct:"Quake intensity", wrong:["Magnitude","Depth"] },
  { q:"Milky Way type?", correct:"Barred spiral", wrong:["Elliptical","Irregular"] },
  { q:"Nearest star到太阳?", correct:"Proxima Centauri", wrong:["Sirius","Betelgeuse"] },
  { q:"主要fuel的太阳now?", correct:"Hydrogen", wrong:["Helium","Carbon"] },
  { q:"Star remnant的Sun's fate?", correct:"White dwarf", wrong:["Neutron star","Black hole"] },
  { q:"Black hole boundary?", correct:"Event horizon", wrong:["Photon ring","Accretion disk"] },
  { q:"Exoplanet transit causes...", correct:"Star dims", wrong:["Star brightens","Star reddens only"] },
  { q:"JWST observes主要...", correct:"Infrared", wrong:["Ultraviolet","Gamma"] },
  { q:"Hubble constant measures...", correct:"Universe expansion rate", wrong:["Dark matter density","Stellar ages"] },
  { q:"Dark matter interacts主要通过...", correct:"Gravity", wrong:["Electromagnetism","Strong force"] },
  { q:"E=mc^2 links...", correct:"Mass & energy", wrong:["Charge & mass","Force & time"] },
  { q:"Momentum formula?", correct:"p = m·v", wrong:["p = m/a","p = F·t^2"] },
  { q:"Kinetic energy formula?", correct:"½mv^2", wrong:["mgh","mv"] },
  { q:"Potential energy near地球?", correct:"mgh", wrong:["½mv^2","qV"] },
  { q:"Third law states...", correct:"Action = reaction", wrong:["F=ma","Energy conserved"] },
  { q:"Work unit?", correct:"Joule", wrong:["Watt","Newton"] },
  { q:"Power unit?", correct:"Watt", wrong:["Joule","Volt"] },
  { q:"Voltage unit?", correct:"Volt", wrong:["Ohm","Tesla"] },
  { q:"Frequency unit?", correct:"Hertz", wrong:["Joule","Henry"] },
  { q:"Magnetic flux density unit?", correct:"Tesla", wrong:["Weber","Gauss (SI)"] },
  { q:"Current的符号是什么?", correct:"I", wrong:["C","R"] },
  { q:"Ohm's law equation?", correct:"V = I·R", wrong:["P = I·R","Q = I·t"] },
  { q:"Capacitance unit?", correct:"Farad", wrong:["Henry","Siemens"] },
  { q:"Inductance unit?", correct:"Henry", wrong:["Farad","Weber"] },
  { q:"Speed的sound在air ~?", correct:"343 m/s", wrong:["1500 m/s","3×10^8 m/s"] },
  { q:"Centripetal force points...", correct:"Toward center", wrong:["Away from center","Tangentially"] },
  { q:"Torque causes...", correct:"Rotation", wrong:["Translation only","Vibration"] },
  { q:"Refraction changes...", correct:"Direction of light", wrong:["Frequency of light","Charge of photon"] },
  { q:"Diffraction是most何时aperture是...", correct:"Comparable to wavelength", wrong:["Much larger","Much smaller only"] },
  { q:"Polarization affects...", correct:"Transverse waves", wrong:["Longitudinal waves","Scalar fields"] },
  { q:"Sound wave type?", correct:"Longitudinal", wrong:["Transverse","Shear only"] },
  { q:"Image在plane mirror是...", correct:"Virtual", wrong:["Real","Inverted real"] },
  { q:"Enzyme function?", correct:"Speeds reactions", wrong:["Stores energy","Forms membranes"] },
  { q:"活动site binds...", correct:"Substrate", wrong:["Product","Inhibitor only"] },
  { q:"Competitive inhibitor competes为...", correct:"Active site", wrong:["Allosteric site","Cofactor"] },
  { q:"Human chromosome pairs?", correct:"23", wrong:["22","24"] },
  { q:"Mitosis produces...", correct:"Two identical cells", wrong:["Four gametes","One larger cell"] },
  { q:"Meiosis produces...", correct:"Gametes", wrong:["Somatic cells","Clone cells"] },
  { q:"Antibody producers?", correct:"B cells", wrong:["T cells","Macrophages"] },
  { q:"Innate immune第一个barrier?", correct:"Skin", wrong:["Antibodies","Memory cells"] },
  { q:"Vector-borne disease example?", correct:"Malaria", wrong:["Tetanus","Measles"] },
  { q:"Antibiotics target...", correct:"Bacteria", wrong:["Viruses","Prions"] },
  { q:"Virus genetic material can be...", correct:"DNA or RNA", wrong:["Protein only","Lipids"] },
  { q:"Green Revolution crop scientist?", correct:"Norman Borlaug", wrong:["Watson","McClintock"] },
  { q:"p-type semiconductor dopant?", correct:"Acceptors", wrong:["Donors","Photons"] },
  { q:"Transistor acts为...", correct:"Switch/amplifier", wrong:["Memory stick","Battery"] },
  { q:"Algorithm complexity noted按...", correct:"Big O", wrong:["Sigma notation","Fourier series"] },
  { q:"Machine learning与labels?", correct:"Supervised", wrong:["Unsupervised","Reinforcement only"] },
  { q:"Data center cooling fights...", correct:"Heat", wrong:["Latency","Bandwidth"] },
  { q:"PCR amplifies...", correct:"DNA", wrong:["Proteins","Lipids"] },
  { q:"Taq polymerase source?", correct:"Thermus aquaticus", wrong:["E. coli","S. cerevisiae"] },
  { q:"Spectroscopy splits按...", correct:"Wavelength", wrong:["Mass only","Charge only"] },
  { q:"Mass spec separates按...", correct:"Mass-to-charge", wrong:["Charge only","Density"] },
  { q:"Chromatography separates按...", correct:"Affinity differences", wrong:["Magnetism","Radioactivity"] },
  { q:"Double-blind trials reduce...", correct:"Bias", wrong:["Sample size","Variability only"] },
  { q:"Null hypothesis是...", correct:"Default no-effect", wrong:["Proven effect","Alternative proven"] },
  { q:"Stat p-value measures...", correct:"Evidence against null", wrong:["Effect size","Power"] },
  { q:"Type I error是...", correct:"False positive", wrong:["False negative","Sampling error only"] },
  { q:"Creator的Minecraft?", correct:"Markus Persson", wrong:["Gabe Newell","John Romero"] },
  { q:"Fortnite developer?", correct:"Epic Games", wrong:["Respawn","Gearbox"] },
  { q:"League的Legends developer?", correct:"Riot Games", wrong:["Valve","Blizzard"] },
  { q:"Overwatch developer?", correct:"Blizzard", wrong:["Bungie","Ubisoft"] },
  { q:"Zelda hero's name?", correct:"Link", wrong:["Zelda","Ganon"] },
  { q:"Mario's brother?", correct:"Luigi", wrong:["Wario","Toad"] },
  { q:"Sonic's company?", correct:"SEGA", wrong:["Nintendo","Capcom"] },
  { q:"Pokémon mascot?", correct:"Pikachu", wrong:["Eevee","Charmander"] },
  { q:"Pokémon balls是被称为?", correct:"Poké Balls", wrong:["Power Orbs","Capture Cubes"] },
  { q:"GTA city parody的LA?", correct:"Los Santos", wrong:["San Fierro","Vice City"] },
  { q:"Witcher's monster hunter?", correct:"Geralt", wrong:["Vesemir","Dandelion"] },
  { q:"Dark Souls developer?", correct:"FromSoftware", wrong:["CD Projekt","Arkane"] },
  { q:"Elden Ring co-作者?", correct:"George R. R. Martin", wrong:["Neil Gaiman","Patrick Rothfuss"] },
  { q:"Halo protagonist?", correct:"Master Chief", wrong:["Commander Shepard","Duke Nukem"] },
  { q:"Metroid bounty hunter?", correct:"Samus Aran", wrong:["Fox McCloud","Jill Valentine"] },
  { q:"动物Crossing shopkeeper duo?", correct:"Timmy & Tommy", wrong:["Tom & Jerry","Pip & Pop"] },
  { q:"Among Us impostor goal?", correct:"Eliminate crew", wrong:["Fix ship","Collect coins"] },
  { q:"Fall Guys genre?", correct:"Battle royale party", wrong:["MOBA","Roguelike"] },
  { q:"Tetris goal?", correct:"Clear lines", wrong:["Match colors","Collect stars"] },
  { q:"Pac-Man ghosts color set includes?", correct:"Blinky Pinky Inky Clyde", wrong:["Ringo Paul John George","Huey Dewey Louie Max"] },
  { q:"Marvel's web-slinger?", correct:"Spider-Man", wrong:["Blue Beetle","Spawn"] },
  { q:"DC's Amazon warrior?", correct:"Wonder Woman", wrong:["She-Hulk","Captain Marvel"] },
  { q:"Batman's butler?", correct:"Alfred", wrong:["Jarvis","Jeeves"] },
  { q:"Black Panther nation?", correct:"Wakanda", wrong:["Latveria","Genosha"] },
  { q:"Thanos seeks...", correct:"Infinity Stones", wrong:["Chaos Emeralds","Dragon Balls"] },
  { q:"Deadpool's nickname?", correct:"Merc with a Mouth", wrong:["Scarlet Speedster","Caped Crusader"] },
  { q:"Harley Quinn's puddin'?", correct:"Joker", wrong:["Two-Face","Riddler"] },
  { q:"X-Men telepath leader?", correct:"Professor X", wrong:["Magneto","Beast"] },
  { q:"Guardians' tree?", correct:"Groot", wrong:["Ent","Trent"] },
  { q:"Loki's brother?", correct:"Thor", wrong:["Hela","Odin"] },
  { q:"Streaming service为Mandalorian?", correct:"Disney+", wrong:["Netflix","Prime Video"] },
  { q:"Platform为Stranger Things?", correct:"Netflix", wrong:["Hulu","Paramount+"] },
  { q:"Platform为Boys?", correct:"Prime Video", wrong:["HBO Max","Apple TV+"] },
  { q:"Platform为Ted Lasso?", correct:"Apple TV+", wrong:["Hulu","Peacock"] },
  { q:"Platform为Last的Us (TV)?", correct:"HBO", wrong:["FX","Showtime"] },
  { q:"Grammy是为?", correct:"Music", wrong:["Film","TV"] },
  { q:"Emmy是为?", correct:"Television", wrong:["Music","Theatre"] },
  { q:"Tony Award field?", correct:"Theatre", wrong:["Film","Gaming"] },
  { q:"Oscars trophy nickname?", correct:"Oscar", wrong:["Goldie","Academy Man"] },
  { q:"Cannes top prize?", correct:"Palme d’Or", wrong:["Golden Lion","Golden Bear"] },
  { q:"Singer的'Bad Guy'?", correct:"Billie Eilish", wrong:["Dua Lipa","Halsey"] },
  { q:"'Blinding Lights' artist?", correct:"The Weeknd", wrong:["Drake","Bruno Mars"] },
  { q:"'Uptown Funk' singer?", correct:"Bruno Mars", wrong:["Pharrell","Adam Levine"] },
  { q:"'Shape的You' singer?", correct:"Ed Sheeran", wrong:["Shawn Mendes","Sam Smith"] },
  { q:"'Rolling在Deep' singer?", correct:"Adele", wrong:["Sia","Lorde"] },
  { q:"K-pop一群与'Dynamite'?", correct:"BTS", wrong:["EXO","Seventeen"] },
  { q:"BLACKPINK member named Jennie?", correct:"Yes", wrong:["No","Former member"] },
  { q:"PSY viral hit?", correct:"Gangnam Style", wrong:["Gentleman","Daddy"] },
  { q:"'Butter'是song按?", correct:"BTS", wrong:["TXT","NCT 127"] },
  { q:"'Lovesick Girls' 一群?", correct:"BLACKPINK", wrong:["Twice","Itzy"] },
  { q:"Viral dance 'Renegade' app?", correct:"TikTok", wrong:["Snapchat","Instagram"] },
  { q:"Instagram parent company current name?", correct:"Meta", wrong:["Alphabet","ByteDance"] },
  { q:"Twitter's鸟类logo name?", correct:"Larry", wrong:["Bluey","Skye"] },
  { q:"Reddit alien name?", correct:"Snoo", wrong:["Bleep","Zorg"] },
  { q:"YouTube play button为1M subs?", correct:"Gold", wrong:["Silver","Diamond"] },
  { q:"Harry Potter's school?", correct:"Hogwarts", wrong:["Brakebills","Unseen University"] },
  { q:"Katniss's weapon?", correct:"Bow", wrong:["Sword","Whip"] },
  { q:"Percy Jackson's father?", correct:"Poseidon", wrong:["Zeus","Hades"] },
  { q:"Twilight vampire family?", correct:"Cullen", wrong:["Salvatore","Mikaelson"] },
  { q:"Daenerys's dragons include?", correct:"Drogon", wrong:["Smaug","Norbert"] },
  { q:"Sherlock actor在BBC series?", correct:"Benedict Cumberbatch", wrong:["Matt Smith","Hugh Laurie"] },
  { q:"Doctor谁's time machine?", correct:"TARDIS", wrong:["DeLorean","Phone Booth"] },
  { q:"Star Trek Vulcan greeting word?", correct:"Live long and prosper", wrong:["Make it so","Klaatu barada nikto"] },
  { q:"Firefly captain?", correct:"Malcolm Reynolds", wrong:["Jim Holden","Han Solo"] },
  { q:"Buffy's title?", correct:"Vampire Slayer", wrong:["Witcher","Demon Hunter"] },
  { q:"Anime pirate captain Straw Hat?", correct:"Luffy", wrong:["Zoro","Sanji"] },
  { q:"Naruto's village?", correct:"Hidden Leaf", wrong:["Hidden Sand","Hidden Rain"] },
  { q:"Dragon Ball wish-granting dragon?", correct:"Shenron", wrong:["Bahamut","Rayquaza"] },
  { q:"Death Note owner shinigami?", correct:"Ryuk", wrong:["Rem","Sousuke"] },
  { q:"Attack在Titan walls city?", correct:"Shiganshina", wrong:["Zaun","Novigrad"] },
  { q:"Fashion house与double-G logo?", correct:"Gucci", wrong:["Givenchy","Goyard"] },
  { q:"Red-soled shoes designer?", correct:"Louboutin", wrong:["Manolo Blahnik","Jimmy Choo"] },
  { q:"Streetwear brand与box logo?", correct:"Supreme", wrong:["BAPE","Stüssy"] },
  { q:"'Just It' brand?", correct:"Nike", wrong:["Adidas","Puma"] },
  { q:"'Impossible是nothing' brand?", correct:"Adidas", wrong:["Puma","Reebok"] },
  { q:"'This是Fine' meme动物?", correct:"Dog", wrong:["Cat","Frog"] },
  { q:"'Distracted Boyfriend'是...", correct:"Stock photo", wrong:["Movie still","TV screencap"] },
  { q:"'Rickroll' song?", correct:"Never Gonna Give You Up", wrong:["Take On Me","Can’t Touch This"] },
  { q:"'Charlie bit my finger' platform?", correct:"YouTube", wrong:["Vine","Facebook"] },
  { q:"'Doge' meme breed?", correct:"Shiba Inu", wrong:["Corgi","Akita"] },
  { q:"Star Wars saber color的Mace Windu?", correct:"Purple", wrong:["Green","Blue"] },
  { q:"Han Solo's ship?", correct:"Millennium Falcon", wrong:["Slave I","Ghost"] },
  { q:"行星与Anakin's podrace?", correct:"Tatooine", wrong:["Naboo","Kamino"] },
  { q:"Grogu's nickname?", correct:"Baby Yoda", wrong:["Tiny Jedi","Little Green"] },
  { q:"Kylo Ren's birth name?", correct:"Ben Solo", wrong:["Finn", "Poe Dameron"] },
  { q:"Pixar lamp's name?", correct:"Luxo Jr.", wrong:["Lumo","Pix"] },
  { q:"Studio behind Minions?", correct:"Illumination", wrong:["DreamWorks","Blue Sky"] },
  { q:"'Let It Go' movie?", correct:"Frozen", wrong:["Moana","Tangled"] },
  { q:"'You're gonna need bigger boat' movie?", correct:"Jaws", wrong:["Titanic","Deep Blue Sea"] },
  { q:"'Wakanda Forever' movie?", correct:"Black Panther", wrong:["Avengers","Eternals"] },
  { q:"K-drama hospital show与band?", correct:"Hospital Playlist", wrong:["Descendants of the Sun","Itaewon Class"] },
  { q:"Spanish heist show masks?", correct:"Salvador Dalí", wrong:["Picasso","Goya"] },
  { q:"Money Heist mastermind alias?", correct:"The Professor", wrong:["The Dean","The Director"] },
  { q:"鱿鱼Game playground game?", correct:"Red Light, Green Light", wrong:["Simon Says","Duck Duck Goose"] },
  { q:"Dark国家的origin?", correct:"Germany", wrong:["Norway","Denmark"] },
  { q:"Comedian与'Seven Dirty Words' bit?", correct:"George Carlin", wrong:["Richard Pryor","Eddie Murphy"] },
  { q:"Host的Daily Show long run?", correct:"Jon Stewart", wrong:["John Oliver","Stephen Colbert"] },
  { q:"Podcast 'Serial' genre?", correct:"True crime", wrong:["Tech","Comedy"] },
  { q:"Joe Rogan's podcast name?", correct:"The Joe Rogan Experience", wrong:["JRE Talk","Rogan Radio"] },
  { q:"'Radiolab' focus?", correct:"Science & ideas", wrong:["Sports","Finance"] },
  { q:"Esports MOBA与International?", correct:"Dota 2", wrong:["LoL","Smite"] },
  { q:"CS:GO bomb sites per map usually?", correct:"Two", wrong:["One","Three"] },
  { q:"Valorant agent healer?", correct:"Sage", wrong:["Jett","Raze"] },
  { q:"Rocket League sport hybrid?", correct:"Car soccer", wrong:["Car hockey","Car rugby"] },
  { q:"Street Fighter hadouken user?", correct:"Ryu", wrong:["Guile","Zangief"] },
  { q:"Band与'Bohemian Rhapsody'?", correct:"Queen", wrong:["The Beatles","The Who"] },
  { q:"Band与'Smells例如Teen Spirit'?", correct:"Nirvana", wrong:["Pearl Jam","Soundgarden"] },
  { q:"Singer known为 'Queen的Pop'?", correct:"Madonna", wrong:["Kylie Minogue","Cher"] },
  { q:"Rapper nicknamed 'Hov'?", correct:"Jay-Z", wrong:["Nas","Kanye West"] },
  { q:"DJ与helmet duo?", correct:"Daft Punk", wrong:["The Chainsmokers","Disclosure"] },
  { q:"Director nicknamed 'Master的Suspense'?", correct:"Alfred Hitchcock", wrong:["Stanley Kubrick","David Lynch"] },
  { q:"Studio behind Lord的Rings VFX?", correct:"Wētā", wrong:["ILM","Digital Domain"] },
  { q:"Company与plumber mascot?", correct:"Nintendo", wrong:["Sega","Atari"] },
  { q:"Console与Master Chief为mascot?", correct:"Xbox", wrong:["PlayStation","Switch"] },
  { q:"Handheld与dual screens?", correct:"Nintendo DS", wrong:["PSP","Game Boy Color"] },
    { q:"哪个是最长的河在South美洲?", correct:"Amazon", wrong:["Paraná","Orinoco"] },
  { q:"河that runs through Baghdad?", correct:"Tigris", wrong:["Euphrates","Jordan"] },
  { q:"河dividing USA and Mexico?", correct:"Rio Grande", wrong:["Colorado","Columbia"] },
  { q:"河that flows through Budapest?", correct:"Danube", wrong:["Rhine","Elbe"] },
  { q:"河through Shanghai?", correct:"Yangtze", wrong:["Yellow","Pearl"] },
  { q:"河known为Huang He?", correct:"Yellow River", wrong:["Yangtze","Mekong"] },
  { q:"河that forms Niagara Falls?", correct:"Niagara River", wrong:["St. Lawrence","Hudson"] },
  { q:"河running through Paris?", correct:"Seine", wrong:["Loire","Rhône"] },
  { q:"Source region的Nile?", correct:"East Africa", wrong:["Arabian Peninsula","Caspian Basin"] },
  { q:"US河famously被称为 'Old Man River'?", correct:"Mississippi", wrong:["Missouri","Ohio"] },
  { q:"Highest waterfall drop over陆地?", correct:"Angel Falls", wrong:["Victoria Falls","Iguazu Falls"] },
  { q:"大型waterfall system在Argentina–Brazil border?", correct:"Iguazu Falls", wrong:["Victoria Falls","Niagara Falls"] },
  { q:"Famous waterfall between Zambia and Zimbabwe?", correct:"Victoria Falls", wrong:["Angel Falls","Kaieteur Falls"] },
  { q:"沙漠spanning Botswana, Namibia, South Africa?", correct:"Kalahari", wrong:["Namib","Sahara"] },
  { q:"沙漠along Chile's Pacific coast?", correct:"Atacama", wrong:["Patagonian","Mojave"] },
  { q:"US沙漠home到Death Valley?", correct:"Mojave", wrong:["Sonoran","Chihuahuan"] },
  { q:"沙漠covering much的Mongolia?", correct:"Gobi", wrong:["Taklamakan","Thar"] },
  { q:"Frozen沙漠covering Antarctica是主要是?", correct:"Ice sheet", wrong:["Sand dunes","Bare rock"] },
  { q:"Region known为Outback是在?", correct:"Australia", wrong:["South Africa","Brazil"] },
  { q:"Patagonia是split between?", correct:"Argentina & Chile", wrong:["Peru & Bolivia","Chile & Uruguay"] },
  { q:"山range separating欧洲and亚洲 (traditionally)?", correct:"Ural Mountains", wrong:["Caucasus","Carpathians"] },
  { q:"山range along Italy's spine?", correct:"Apennines", wrong:["Alps","Carpathians"] },
  { q:"European range home到Mont Blanc?", correct:"Alps", wrong:["Pyrenees","Carpathians"] },
  { q:"Range between Spain and France?", correct:"Pyrenees", wrong:["Alps","Cantabrians"] },
  { q:"Himalayas stretch主要across Nepal, India, and?", correct:"China/Tibet", wrong:["Mongolia","Thailand"] },
  { q:"World's最高的volcano (above sea level)?", correct:"Ojos del Salado", wrong:["Mauna Loa","Cotopaxi"] },
  { q:"活动volcano near Naples, Italy?", correct:"Vesuvius", wrong:["Etna","Stromboli"] },
  { q:"Iceland sits在哪个type的boundary?", correct:"Mid-ocean ridge", wrong:["Subduction zone","Transform only"] },
  { q:"Ring的Fire refers到?", correct:"Pacific volcanic belt", wrong:["Atlantic rift","Indian Ocean trench line"] },
  { q:"Mount Kilimanjaro是在?", correct:"Tanzania", wrong:["Kenya","Ethiopia"] },
  { q:"Lowest陆地point在Earth's surface?", correct:"Shore of Dead Sea", wrong:["Grand Canyon floor","Death Valley basin"] },
  { q:"Saltiest大型天然的body的水?", correct:"Dead Sea", wrong:["Black Sea","Caspian Sea"] },
  { q:"World's最深的海洋trench?", correct:"Mariana Trench", wrong:["Tonga Trench","Kuril–Kamchatka Trench"] },
  { q:"大型inland sea between欧洲and亚洲?", correct:"Caspian Sea", wrong:["Black Sea","Aral Sea"] },
  { q:"Shrinking lake between Kazakhstan and Uzbekistan?", correct:"Aral Sea", wrong:["Lake Baikal","Lake Balkhash"] },
  { q:"哪个是最大的lake在Africa按area?", correct:"Lake Victoria", wrong:["Lake Tanganyika","Lake Malawi"] },
  { q:"最深的freshwater lake在地球?", correct:"Lake Baikal", wrong:["Lake Superior","Lake Tanganyika"] },
  { q:"大堡礁是off coast的哪个state?", correct:"Queensland", wrong:["New South Wales","Western Australia"] },
  { q:"mouth的Amazon河empties into?", correct:"Atlantic Ocean", wrong:["Caribbean Sea","Pacific Ocean"] },
  { q:"哪个是最大的inland body的水按volume?", correct:"Caspian Sea", wrong:["Lake Superior","Lake Michigan-Huron"] },
  { q:"什么是是thmus?", correct:"Narrow land connecting two larger land areas", wrong:["Shallow coral lagoon","Flat inland delta"] },
  { q:"什么是archipelago?", correct:"Group of islands", wrong:["Coastal desert","High plateau"] },
  { q:"什么是fjord?", correct:"Glacially carved sea inlet", wrong:["Coral atoll","River floodplain"] },
  { q:"什么是delta?", correct:"Sediment fan at a river mouth", wrong:["Ocean trench","Glacier toe"] },
  { q:"什么是strait?", correct:"Narrow waterway between two landmasses", wrong:["Undersea ridge","Shallow gulf"] },
  { q:"fertile陆地along沙漠河的术语是什么?", correct:"Oasis", wrong:["Steppe","Tundra"] },
  { q:"Permafrost是ground that是?", correct:"Frozen for 2+ years", wrong:["Under sea level","Covered by ice sheet"] },
  { q:"Steppe biome是主要是?", correct:"Grassland", wrong:["Rainforest","Marshland"] },
  { q:"Taiga biome是dominated按?", correct:"Coniferous forest", wrong:["Tropical palms","Cacti"] },
  { q:"Tundra climate是主要是?", correct:"Cold, treeless, permafrost", wrong:["Humid tropical","Monsoon seasonal"] },
  { q:"哪个海洋是最小的按area?", correct:"Arctic", wrong:["Indian","Southern"] },
  { q:"哪个海洋separates Africa and Australia到south的亚洲?", correct:"Indian Ocean", wrong:["Atlantic Ocean","Southern Ocean"] },
  { q:"哪个海洋lies off California's coast?", correct:"Pacific Ocean", wrong:["Atlantic Ocean","Arctic Ocean"] },
  { q:"哪个海洋borders east coast的South美洲?", correct:"Atlantic Ocean", wrong:["Indian Ocean","Pacific Ocean"] },
  { q:"哪个海洋surrounds Antarctica?", correct:"Southern Ocean", wrong:["Arctic Ocean","Indian Ocean"] },
  { q:"Mediterranean Sea connects到Atlantic通过?", correct:"Strait of Gibraltar", wrong:["Bosphorus","Suez Canal"] },
  { q:"红色Sea connects到Mediterranean通过?", correct:"Suez Canal", wrong:["Bosphorus","Panama Canal"] },
  { q:"Black Sea connects到Mediterranean through?", correct:"Bosphorus", wrong:["Gibraltar","Hormuz"] },
  { q:"Strait between Spain and Morocco?", correct:"Gibraltar", wrong:["Hormuz","Malacca"] },
  { q:"Strait linking Persian Gulf到Arabian Sea?", correct:"Strait of Hormuz", wrong:["Strait of Malacca","Bab el-Mandeb"] },
  { q:"Great Rift Valley runs主要through?", correct:"East Africa", wrong:["Southeast Asia","Central Europe"] },
  { q:"Andes run along哪个edge的South美洲?", correct:"West", wrong:["East","North"] },
  { q:"Rockies是主要在哪?", correct:"North America", wrong:["Asia","Europe"] },
  { q:"Caucasus lie between哪个seas?", correct:"Black & Caspian", wrong:["Red & Arabian","Baltic & North"] },
  { q:"Sahara沙漠sits主要在哪个part的Africa?", correct:"North Africa", wrong:["East Africa","Southern Africa"] },
  { q:"Outback是主要是什么biome?", correct:"Semi-arid scrub/desert", wrong:["Tropical rainforest","Arctic tundra"] },
  { q:"Amazon rainforest是主要是在哪?", correct:"Brazil", wrong:["Peru","Colombia"] },
  { q:"'Sahel'是strip的?", correct:"Semi-arid land south of Sahara", wrong:["Glacial moraine","Coastal mangrove"] },
  { q:"Monsoon climates是strongly driven按?", correct:"Seasonal wind reversals", wrong:["Earthquakes","Ocean salinity"] },
  { q:"北极Circle是defined按?", correct:"Latitude where sun can stay up 24h in summer", wrong:["World’s coldest sea temps","Magnetic north location"] },
  { q:"哪个US state是最大的按陆地area?", correct:"Alaska", wrong:["Texas","California"] },
  { q:"哪个US state有Grand Canyon?", correct:"Arizona", wrong:["Utah","Nevada"] },
  { q:"哪个US state是被称为Sunshine State?", correct:"Florida", wrong:["California","Hawaii"] },
  { q:"哪个US state有most volcanoes?", correct:"Alaska", wrong:["Hawaii","Washington"] },
  { q:"哪个Canadian province是主要French-speaking?", correct:"Quebec", wrong:["Ontario","Manitoba"] },
  { q:"Greenland是autonomous territory的?", correct:"Denmark", wrong:["Canada","Norway"] },
  { q:"哪个是最大的国家fully在South美洲?", correct:"Brazil", wrong:["Argentina","Colombia"] },
  { q:"Most populous国家在Africa?", correct:"Nigeria", wrong:["Ethiopia","Egypt"] },
  { q:"Most populous city在Japan?", correct:"Tokyo", wrong:["Osaka","Nagoya"] },
  { q:"Most populous city在Australia?", correct:"Sydney", wrong:["Melbourne","Brisbane"] },
  { q:"首都city built在沙漠: Abu Dhabi, Riyadh, or Lima?", correct:"Riyadh", wrong:["Abu Dhabi","Lima"] },
  { q:"首都city located在Andes在very high altitude?", correct:"La Paz (admin Bolivia)", wrong:["Asunción","Quito is lower"] },
  { q:"哪个国家是landlocked?", correct:"Paraguay", wrong:["Uruguay","Ecuador"] },
  { q:"哪个国家是landlocked?", correct:"Mongolia", wrong:["Vietnam","North Korea"] },
  { q:"哪个国家是岛nation?", correct:"Madagascar", wrong:["Mozambique","Tanzania"] },
  { q:"哪个国家是岛nation?", correct:"Iceland", wrong:["Ireland","Denmark"] },
  { q:"哪个非洲国家是fully inside another在哪个国家?", correct:"Lesotho", wrong:["Eswatini","Gabon"] },
  { q:"哪个pair shares world's最长的border?", correct:"USA & Canada", wrong:["China & Russia","India & China"] },
  { q:"哪个国家spans both欧洲and亚洲?", correct:"Turkey", wrong:["Iraq","Greece"] },
  { q:"哪个国家spans both欧洲and亚洲?", correct:"Russia", wrong:["Finland","Ukraine"] },

  /* ---------------- COMPUTERS / TECH (81–140) ---------------- */

  { q:"CPU代表什么?", correct:"Central Processing Unit", wrong:["Core Performance Unit","Computer Power Unit"] },
  { q:"GPU是主要used为?", correct:"Graphics processing", wrong:["Wi-Fi routing","Disk storage"] },
  { q:"RAM是什么kind的memory?", correct:"Volatile", wrong:["Permanent","Optical-only"] },
  { q:"主要storage drive在most modern laptops?", correct:"SSD", wrong:["Floppy","Zip drive"] },
  { q:"哪个stores more long-term: RAM or SSD?", correct:"SSD", wrong:["RAM","Cache"] },
  { q:"什么 'booting' computer mean?", correct:"Starting the OS", wrong:["Clearing RAM","Printing BIOS logs only"] },
  { q:"BIOS/UEFI runs何时?", correct:"Before OS loads", wrong:["After OS loads","Only during shutdown"] },
  { q:"OS代表什么?", correct:"Operating System", wrong:["Open Source","Optical System"] },
  { q:"哪个是operating system?", correct:"Linux", wrong:["HTML","USB"] },
  { q:"sending data到internet的术语是什么?", correct:"Upload", wrong:["Download","Buffering"] },
  { q:"LAN代表什么?", correct:"Local Area Network", wrong:["Linked Access Node","Logical Aggregate Net"] },
  { q:"WAN代表什么?", correct:"Wide Area Network", wrong:["Web Access Node","Wireless Area Net"] },
  { q:"Wi-Fi主要uses什么medium?", correct:"Radio waves", wrong:["Laser beams","Sound"] },
  { q:"Ethernet是通常什么type的cable?", correct:"Twisted pair", wrong:["Coaxial-only","Fiber ribbon only"] },
  { q:"Router's job?", correct:"Direct network traffic between networks", wrong:["Store files","Render graphics"] },
  { q:"Firewall's主要job?", correct:"Filter network traffic", wrong:["Cool the CPU","Defrag storage"] },
  { q:"IP address identifies?", correct:"A device on a network", wrong:["A CPU core","A USB protocol"] },
  { q:"DNS是basically internet's?", correct:"Phonebook of names to IPs", wrong:["Antivirus","Cache cleaner"] },
  { q:"HTTP是used为?", correct:"Web page transfer", wrong:["Local printing","BIOS flashing"] },
  { q:"HTTPS adds什么到HTTP?", correct:"Encryption", wrong:["Compression only","Video support"] },
  { q:"HTML是主要used到?", correct:"Structure web pages", wrong:["Compile code","Encrypt drives"] },
  { q:"CSS主要controls?", correct:"Styling and layout", wrong:["Database queries","CPU drivers"] },
  { q:"JavaScript主要runs哪里?", correct:"In web browsers", wrong:["In the PSU","In the keyboard firmware"] },
  { q:"Python是经常used为?", correct:"Scripting and automation", wrong:["Solely GPU firmware","Spreadsheet macros only"] },
  { q:"SQL是主要used为?", correct:"Databases", wrong:["3D graphics","Audio synthesis"] },
  { q:"Git是tool为?", correct:"Version control", wrong:["3D rendering","Audio mixing"] },
  { q:"Open source是什么意思?", correct:"Source code is publicly available", wrong:["Software is always free","Only runs on Linux"] },
  { q:"Cloud computing basically是什么意思?", correct:"Remote servers do the work", wrong:["No servers exist","Data only on USB"] },
  { q:"Virtual machine是?", correct:"Emulated OS on top of another OS", wrong:["Physical second CPU","Overclocked BIOS only"] },
  { q:"Two-factor authentication requires?", correct:"Two independent verification steps", wrong:["A single password","A username only"] },
  { q:"Malware是short为?", correct:"Malicious software", wrong:["Manual warehousing","Memory alert"] },
  { q:"Ransomware什么?", correct:"Locks/encrypts data for payment", wrong:["Overclocks CPU","Cleans registry"] },
  { q:"Phishing attack tries到?", correct:"Trick user into giving credentials", wrong:["Physically steal a PC","Exploit Wi-Fi hardware"] },
  { q:"Antivirus software scans为?", correct:"Malicious code", wrong:["Dust buildup","Dead pixels"] },
  { q:"Encryption什么到data?", correct:"Scrambles it unreadable without a key", wrong:["Deletes it","Duplicates it"] },
  { q:"strong password should?", correct:"Use length and complexity", wrong:["Reuse old logins","Be 'password123'"] },
  { q:"VPN主要什么?", correct:"Encrypts traffic and masks IP", wrong:["Speeds up CPU","Blocks all ads by default"] },
  { q:"Packet sniffing是analyzing?", correct:"Network traffic data packets", wrong:["CPU temps","Fan curves"] },
  { q:"Brute-force attack是什么意思?", correct:"Trying many password combos", wrong:["Guessing pet names only","Spoofing GPS"] },
  { q:"Social engineering targets?", correct:"People", wrong:["RAM chips","Fiber optics"] },
  { q:"什么part most arithmetic/logic在CPU?", correct:"ALU", wrong:["PSU","PCIe"] },
  { q:"GPU cores是optimized为?", correct:"Parallel math", wrong:["Serial disk reads","BIOS menus"] },
  { q:"Thermal paste goes between?", correct:"CPU and cooler", wrong:["RAM and PSU","SSD and GPU fan"] },
  { q:"Overclocking CPU是什么意思?", correct:"Running it above rated speed", wrong:["Installing a new BIOS chip","Disabling cores"] },
  { q:"Undervolting GPU是什么意思?", correct:"Reducing voltage for same clocks", wrong:["Forcing max fans","Switching outputs"] },
  { q:"FPS在gaming代表什么?", correct:"Frames per second", wrong:["Flares per shot","Files per second"] },
  { q:"Refresh rate是measured在哪?", correct:"Hertz (Hz)", wrong:["Lumens","Decibels"] },
  { q:"V-Sync tries到?", correct:"Match FPS to monitor refresh", wrong:["Mute speakers","Encrypt RAM"] },
  { q:"Screen tearing是caused按?", correct:"Frame output not synced to refresh", wrong:["Speaker clipping","Hard drive noise"] },
  { q:"Ping measures?", correct:"Network latency", wrong:["CPU heat","Battery health"] },
  { q:"SSD vs HDD: SSDs有?", correct:"No spinning platters", wrong:["Laser discs","Magnetic tape reels"] },
  { q:"USB代表什么?", correct:"Universal Serial Bus", wrong:["Unified System Bridge","Universal Storage Bar"] },
  { q:"HDMI是used到transmit?", correct:"Digital audio and video", wrong:["Only power","Only internet"] },
  { q:"Bluetooth是主要为?", correct:"Short-range wireless connections", wrong:["Satellite uplink","Optical cabling"] },
  { q:"NFC代表什么?", correct:"Near Field Communication", wrong:["Network File Control","Node Frequency Channel"] },
  { q:"QR code是basically?", correct:"2D scannable barcode", wrong:["Encrypted password","Wi-Fi antenna"] },
  { q:"SSD 'NVMe' connects通过?", correct:"PCIe", wrong:["IDE ribbon","AGP slot"] },
  { q:"PSU在PC provides?", correct:"Power conversion", wrong:["Network routing","BIOS updates"] },
  { q:"Motherboard什么?", correct:"Connects and lets components talk", wrong:["Cools GPU only","Stores cloud backups"] },
  { q:"Kernel在OS是?", correct:"Core that manages hardware/resources", wrong:["The recycle bin","The browser plugin"] },
  { q:"Command line interface是?", correct:"Text-based control", wrong:["Touchscreen-only","Mouse-only GUI"] },
  { q:"'sudo'在Unix-like systems?", correct:"Executes with elevated privileges", wrong:["Deletes user","Forces reboot"] },
  { q:"Ping command checks?", correct:"Reachability of a host", wrong:["Disk speed","GPU temps"] },
  { q:"'cd' command什么?", correct:"Changes directory", wrong:["Copies files","Compiles drivers"] },
  { q:"'ls' or 'dir' shows?", correct:"Directory contents", wrong:["CPU usage","Open ports"] },
  { q:"Firewall rules经常allow or block按?", correct:"Ports and IPs", wrong:["RGB color","Monitor size"] },
  { q:"MAC address identifies?", correct:"Network interface hardware", wrong:["CPU brand","OS license key"] },
  { q:"SSD endurance是经常measured在哪?", correct:"TBW (terabytes written)", wrong:["FPS","RPM"] },
  { q:"Overheating laptops经常need?", correct:"Dust cleaning & fresh thermal paste", wrong:["More RGB","More stickers"] },
  { q:"BIOS password有助于prevent?", correct:"Unauthorized boot changes", wrong:["Dead pixels","Fan rattle"] },
  { q:"什么是firmware?", correct:"Low-level code on hardware devices", wrong:["Cloud backup","Ad blocker list"] },
  { q:"什么是driver?", correct:"Software that lets OS talk to hardware", wrong:["Power cable","Heatsink clip"] },
  { q:"什么是latency?", correct:"Delay before data transfer starts", wrong:["Total bandwidth","Screen brightness"] },
  { q:"什么是bandwidth?", correct:"Max data rate over a link", wrong:["Signal delay","CPU clock jitter"] },
  { q:"Backup best practice?", correct:"Keep copies in separate location", wrong:["Only 1 copy on same disk","Trust autosave"] },
  { q:"Password manager stores?", correct:"Encrypted credentials", wrong:["CPU voltages","DNS zones"] },
  { q:"Incognito/private mode主要stops?", correct:"Local history storage", wrong:["ISP tracking","Website tracking entirely"] },
  { q:"Cookie在web是?", correct:"Small stored data from a site", wrong:["Encrypted virus","Ad-block list"] },
  { q:"CAPTCHA's purpose?", correct:"Distinguish bots from humans", wrong:["Encrypt passwords","Resize images"] },
  { q:"Two-step login通过SMS code是example的?", correct:"2FA", wrong:["VPN","Overclocking"] },

  /* ---------------- ANIMALS / BIOLOGY (141–200) ---------------- */

  { q:"Mammals是warm-blooded or cold-blooded?", correct:"Warm-blooded", wrong:["Cold-blooded","Neither"] },
  { q:"Reptiles是usually?", correct:"Cold-blooded", wrong:["Warm-blooded","Both"] },
  { q:"Amphibians通常start life为?", correct:"Aquatic larvae with gills", wrong:["Winged adults","Shell-bearing hatchlings"] },
  { q:"鸟类骨头是经常?", correct:"Hollow/lightweight", wrong:["Solid and dense","Cartilage only"] },
  { q:"鲸breathe使用?", correct:"Lungs", wrong:["Gills","Skin pores"] },
  { q:"鱼用什么呼吸使用?", correct:"Gills", wrong:["Lungs","Blowholes"] },
  { q:"哪个一群产amniotic卵在陆地?", correct:"Reptiles & birds", wrong:["Adult amphibians","All mammals"] },
  { q:"仅mammals that truly fly?", correct:"Bats", wrong:["Flying squirrels","Gliding possums"] },
  { q:"Humans belong到什么order?", correct:"Primates", wrong:["Carnivora","Cetacea"] },
  { q:"Great apes include?", correct:"Gorillas, chimps, orangutans, humans", wrong:["Lemurs, tarsiers, humans","Only gorillas"] },
  { q:"哪个是最大的陆地carnivore?", correct:"Polar bear", wrong:["Lion","Grizzly bear"] },
  { q:"哪个是最大的陆地动物?", correct:"African elephant", wrong:["White rhino","Hippo"] },
  { q:"Heaviest snake species?", correct:"Green anaconda", wrong:["King cobra","Boa constrictor"] },
  { q:"哪个是最快的marine哺乳动物?", correct:"Common dolphin", wrong:["Blue whale","Sea lion"] },
  { q:"哪个是最快的陆地哺乳动物over short burst?", correct:"Cheetah", wrong:["Pronghorn","Springbok"] },
  { q:"哪个是最快的鸟类在dive?", correct:"Peregrine falcon", wrong:["Golden eagle","Albatross"] },
  { q:"哪个是最高的现存陆地动物?", correct:"Giraffe", wrong:["Elephant","Ostrich"] },
  { q:"哪个是最大的现存鸟类按高度?", correct:"Ostrich", wrong:["Emu","Cassowary"] },
  { q:"哪个是最大的蜥蜴在地球?", correct:"Komodo dragon", wrong:["Nile monitor","Iguana"] },
  { q:"哪个是最大的鲨鱼?", correct:"Whale shark", wrong:["Great white","Basking shark"] },
  { q:"herbivores吃什么?", correct:"Plants", wrong:["Meat","Bones"] },
  { q:"carnivores吃什么?", correct:"Meat", wrong:["Seeds","Plankton only"] },
  { q:"omnivores吃什么?", correct:"Plants and animals", wrong:["Only algae","Only insects"] },
  { q:"海豚被归类为什么?", correct:"Mammals", wrong:["Fish","Amphibians"] },
  { q:"鲨鱼被归类为什么?", correct:"Fish", wrong:["Mammals","Reptiles"] },
  { q:"企鹅是?", correct:"Birds", wrong:["Mammals","Fish"] },
  { q:"Platypus产?", correct:"Eggs", wrong:["Live young only","Larvae"] },
  { q:"Kangaroo幼崽是被称为?", correct:"Joeys", wrong:["Cubs","Pups"] },
  { q:"幼年frogs是被称为?", correct:"Tadpoles", wrong:["Fry","Larvae"] },
  { q:"幼年cows是被称为?", correct:"Calves", wrong:["Foals","Kids"] },
  { q:"一群的狮子是被称为?", correct:"Pride", wrong:["Pack","Murder"] },
  { q:"一群的狼是?", correct:"Pack", wrong:["School","Swarm"] },
  { q:"一群的乌鸦经常被称为?", correct:"Murder", wrong:["Parliament","Mob"] },
  { q:"一群的鱼类swimming一起是?", correct:"School", wrong:["Cluster","Herd"] },
  { q:"一群的海豚是经常被称为?", correct:"Pod", wrong:["Swarm","Band"] },
  { q:"蜜蜂生活在?", correct:"Hive", wrong:["Den","Warren"] },
  { q:"兔子生活在?", correct:"Warren", wrong:["Lodge","Hive"] },
  { q:"海狸建造?", correct:"Lodge", wrong:["Hive","Burrow"] },
  { q:"动物活动在夜间的术语是什么?", correct:"Nocturnal", wrong:["Diurnal","Crepuscular only"] },
  { q:"动物主要活动在黎明/黄昏是?", correct:"Crepuscular", wrong:["Nocturnal","Diurnal"] },
  { q:"主要食物的大熊猫?", correct:"Bamboo", wrong:["Fish","Insects"] },
  { q:"考拉主要吃什么?", correct:"Eucalyptus leaves", wrong:["Grass","Fruit"] },
  { q:"秃鹫主要吃什么?", correct:"Carrion", wrong:["Seeds","Fresh leaves"] },
  { q:"蜂鸟主要进食在?", correct:"Nectar", wrong:["Seeds","Carrion"] },
  { q:"须鲸鲸主要吃什么?", correct:"Tiny prey like krill", wrong:["Seaweed","Seals"] },
  { q:"虎鲸 (killer鲸)是实际上?", correct:"Dolphins", wrong:["Sharks","Whales (not technically)"] },
  { q:"海牛是有时nicknamed?", correct:"Sea cows", wrong:["Sea horses","Sea dogs"] },
  { q:"不会飞的鸟类发现于在Antarctica?", correct:"Penguin", wrong:["Kiwi","Ostrich"] },
  { q:"不会飞的鸟类原产于到New Zealand?", correct:"Kiwi", wrong:["Penguin","Cassowary"] },
  { q:"大型不会飞的鸟类原产于到Australia?", correct:"Emu", wrong:["Ostrich","Rhea"] },
  { q:"哪个动物有育儿袋到携带幼崽?", correct:"Marsupials", wrong:["Placental mammals","Cephalopods"] },
  { q:"哪个动物通常有鳞片and产革质的卵在陆地?", correct:"Reptiles", wrong:["Amphibians","Mammals"] },
  { q:"哪个动物一群经历变态发育来自幼虫到成年人?", correct:"Amphibians", wrong:["Birds","Reptiles"] },
  { q:"多少条腿昆虫有?", correct:"6", wrong:["8","10"] },
  { q:"多少条腿蜘蛛有?", correct:"8", wrong:["6","10"] },
  { q:"甲壳类例如crabs通常生活哪里?", correct:"Aquatic environments", wrong:["Desert dunes","Treetops only"] },
  { q:"章鱼有多少条手臂?", correct:"8", wrong:["6","10"] },
  { q:"鱿鱼通常有?", correct:"8 arms + 2 tentacles", wrong:["10 equal arms","6 arms total"] },
  { q:"海星移动使用?", correct:"Tube feet", wrong:["Jet propulsion","Wing beats"] },
  { q:"水母身体是主要是?", correct:"Water", wrong:["Calcium","Keratin"] },
  { q:"什么是伪装为?", correct:"Blending into surroundings", wrong:["Making noise","Attracting mates only"] },
  { q:"什么是拟态在动物?", correct:"Imitating another organism", wrong:["Hibernating","Echoing sounds only"] },
  { q:"什么是冬眠?", correct:"Long inactive low-energy state", wrong:["Short sprint burst","Daily grooming"] },
  { q:"什么是migration?", correct:"Seasonal movement to new areas", wrong:["Random nest building","Daily hunting loop"] },
  { q:"为什么许多鸟类迁徙?", correct:"Follow food and breeding conditions", wrong:["Avoid oxygen","Avoid saltwater"] },
  { q:"为什么北极狐狸变white?", correct:"Seasonal camouflage", wrong:["Calcium buildup","Parasite infection"] },
  { q:"为什么斑马有条纹?", correct:"Likely confuse predators/insects", wrong:["Heat storage panels","Glow in moonlight"] },
  { q:"主要用途的elephants' 象鼻?", correct:"Breathing, grasping, drinking", wrong:["Storing fat","Cooling blood only"] },
  { q:"Giraffe long脖子有助于主要与?", correct:"Feeding on tall vegetation", wrong:["Swimming","Digging"] },
  { q:"Cheetah's尾巴有助于与?", correct:"Balance during high-speed turns", wrong:["Cooling body","Making sound"] },
  { q:"Apex捕食者是什么意思?", correct:"Top of food chain", wrong:["Fastest swimmer","No fur"] },
  { q:"Keystone species是?", correct:"Species with big impact on ecosystem", wrong:["Fastest breeder","Tree-climbing mammal only"] },
  { q:"传粉者帮助植物按?", correct:"Transferring pollen", wrong:["Absorbing toxins","Producing chlorophyll"] },
  { q:"蜜蜂交流方向的食物通过?", correct:"Waggle dance", wrong:["Tail clicks","Color change"] },
  { q:"Bats导航使用?", correct:"Echolocation", wrong:["Infrared vision","Magnetic field mapping only"] },
  { q:"Owls hunt well在夜间because?", correct:"Excellent night vision & hearing", wrong:["Infrared laser eyes","Electric field sense"] },
  { q:"鲨鱼探测prey partly使用?", correct:"Electroreception", wrong:["UV fluorescence only","Heat vision only"] },
  { q:"Rattlesnakes探测warm-blooded prey使用?", correct:"Heat-sensing pits", wrong:["Echolocation","Magnetism"] },
  { q:"Chameleons can?", correct:"Change skin coloration", wrong:["Change skeleton","Split into clones"] },
  { q:"Electric eels can?", correct:"Generate electric shocks", wrong:["See radio waves","Breathe underwater with lungs only"] },
  { q:"King的Greek gods?", correct:"Zeus", wrong:["Ares","Hermes"] },
{ q:"Norse god与hammer Mjölnir?", correct:"Thor", wrong:["Tyr","Baldur"] },
{ q:"Greek god的sea?", correct:"Poseidon", wrong:["Hades","Apollo"] },
{ q:"Egyptian太阳god经常shown与falcon head?", correct:"Ra", wrong:["Osiris","Anubis"] },
{ q:"Queen的gods在Greek myth?", correct:"Hera", wrong:["Athena","Artemis"] },
{ q:"Roman name为Zeus?", correct:"Jupiter", wrong:["Mars","Neptune"] },
{ q:"Greek god的underworld?", correct:"Hades", wrong:["Ares","Hephaestus"] },
{ q:"Norse father的all gods?", correct:"Odin", wrong:["Loki","Freyr"] },
{ q:"Winged horse在Greek myth?", correct:"Pegasus", wrong:["Cerberus","Hydra"] },
{ q:"Three-headed guard dog的Hades?", correct:"Cerberus", wrong:["Orthrus","Fenrir"] },

{ q:"Norse trickster god?", correct:"Loki", wrong:["Heimdall","Bragi"] },
{ q:"谁flew too close到太阳?", correct:"Icarus", wrong:["Theseus","Perseus"] },
{ q:"Hero谁killed Medusa?", correct:"Perseus", wrong:["Heracles","Achilles"] },
{ q:"Woman与snakes为hair?", correct:"Medusa", wrong:["Stheno","Scylla"] },
{ q:"什么是Valhalla?", correct:"Hall of fallen warriors", wrong:["Frozen underworld","World tree root"] },
{ q:"Greek goddess的wisdom and war strategy?", correct:"Athena", wrong:["Aphrodite","Demeter"] },
{ q:"Norse world tree that links realms?", correct:"Yggdrasil", wrong:["Bifrost","Niflheim"] },
{ q:"Thunder god在Slavic folklore?", correct:"Perun", wrong:["Cernunnos","Veles"] },
{ q:"Aztec太阳and war god?", correct:"Huitzilopochtli", wrong:["Quetzalcoatl","Tlaloc"] },
{ q:"Feathered serpent god的Mesoamerica?", correct:"Quetzalcoatl", wrong:["Tezcatlipoca","Xipe Totec"] },

{ q:"Greek hero与near-invincible body except his heel?", correct:"Achilles", wrong:["Jason","Odysseus"] },
{ q:"Heracles是known在Rome为?", correct:"Hercules", wrong:["Hermes","Aeneas"] },
{ q:"Mjölnir是?", correct:"Thor's hammer", wrong:["Odin's spear","Loki's dagger"] },
{ q:"Odin's one missing thing?", correct:"An eye", wrong:["A hand","A leg"] },
{ q:"谁guards Egyptian dead and有jackal head?", correct:"Anubis", wrong:["Sobek","Horus"] },
{ q:"Greek goddess的love and beauty?", correct:"Aphrodite", wrong:["Hestia","Persephone"] },
{ q:"Roman god的war?", correct:"Mars", wrong:["Mercury","Janus"] },
{ q:"Name的Greek underworld为normal dead?", correct:"Hades", wrong:["Elysium","Asphodel Meadows"] },
{ q:"Valkyries choose谁?", correct:"Warriors who die in battle", wrong:["Kings only","Children only"] },
{ q:"Banshee在Irish folklore是known为?", correct:"Wailing to warn of death", wrong:["Bringing treasure","Granting wishes"] },

{ q:"什么是Ragnarok?", correct:"Norse end of the world battle", wrong:["Greek harvest rite","Egyptian new year"] },
{ q:"Japanese fox spirit that can shapeshift?", correct:"Kitsune", wrong:["Tengu","Oni"] },
{ q:"在Greek myth, Minotaur lived在?", correct:"Labyrinth", wrong:["Palace tower","River cave"] },
{ q:"谁killed Minotaur?", correct:"Theseus", wrong:["Perseus","Orpheus"] },
{ q:"Cupid是Roman version的?", correct:"Eros", wrong:["Hermes","Pan"] },
{ q:"Greek messenger god与winged sandals?", correct:"Hermes", wrong:["Ares","Dionysus"] },
{ q:"Norse rainbow bridge到gods?", correct:"Bifrost", wrong:["Gjallarhorn","Sköll"] },
{ q:"Egyptian goddess与lioness head, linked到war?", correct:"Sekhmet", wrong:["Isis","Bastet"] },
{ q:"在myth, Excalibur是?", correct:"King Arthur's sword", wrong:["Merlin's staff","Lancelot's shield"] },
{ q:"Avalon是?", correct:"Mythical island of healing", wrong:["Undersea kingdom","Gate to Hell"] },

{ q:"Greek titan谁held up sky?", correct:"Atlas", wrong:["Cronus","Prometheus"] },
{ q:"Prometheus是famous为giving humans?", correct:"Fire", wrong:["Immortality","Wings"] },
{ q:"在Greek myth, 谁opened forbidden box/jar的evils?", correct:"Pandora", wrong:["Helen","Andromeda"] },
{ q:"Greek underworld boatman?", correct:"Charon", wrong:["Cerberus","Hector"] },
{ q:"Weapon的Poseidon?", correct:"Trident", wrong:["Spear of light","Lightning bow"] },
{ q:"Egyptian god的chaos and沙漠storms?", correct:"Set", wrong:["Thoth","Ptah"] },
{ q:"Osiris是god的?", correct:"Afterlife and rebirth", wrong:["Sky and storms","Craftsmanship"] },
{ q:"Isis在Egyptian mythology是known为?", correct:"Magic and motherhood", wrong:["War and lightning","Volcanoes"] },
{ q:"Greek god的wine and madness?", correct:"Dionysus", wrong:["Apollo","Ares"] },
{ q:"centaur是half human and half?", correct:"Horse", wrong:["Bull","Lion"] },

{ q:"satyr是half human and half?", correct:"Goat", wrong:["Wolf","Snake"] },
{ q:"Medieval European dragon stereotype?", correct:"Fire-breathing, hoards treasure", wrong:["Cannot fly","Herbivore healer"] },
{ q:"Phoenix是famous为?", correct:"Being reborn from its ashes", wrong:["Turning invisible","Singing people to sleep forever"] },
{ q:"Baba Yaga在Slavic folklore是?", correct:"A witch in a walking hut", wrong:["A water dragon","A frost spirit prince"] },
{ q:"Kraken在legend是?", correct:"Giant sea monster", wrong:["Fire demon","Sand serpent"] },
{ q:"Loch Ness Monster是said到生活在哪?", correct:"A Scottish lake", wrong:["Icelandic glacier","Underground cavern in Wales"] },
{ q:"Werewolf folklore describes?", correct:"Human that turns into a wolf", wrong:["Fish that sings","Woman turning into a raven swarm"] },
{ q:"Vampire folklore core trait?", correct:"Drinks blood of the living", wrong:["Controls thunder","Heals crops"] },
{ q:"Chupacabra legend主要来自?", correct:"Latin America", wrong:["Japan","Finland"] },
{ q:"Headless Horseman是来自?", correct:"American folklore", wrong:["Norse saga","Aztec myth"] },

{ q:"Maui在Polynesian myth是known为?", correct:"Pulling up islands with a hook", wrong:["Making volcanoes from tears","Swallowing the sun forever"] },
{ q:"Trolls在Norse folklore经常?", correct:"Live in mountains/caves and hate sunlight", wrong:["Glow bright blue","Turn into dolphins"] },
{ q:"在Greek myth, sirens lure sailors与?", correct:"Song", wrong:["Treasure maps","Magic lanterns"] },
{ q:"在Greek myth, Scylla是?", correct:"Sea monster with many heads", wrong:["Winged horse","Snake-haired queen"] },
{ q:"Mermaids是traditionally?", correct:"Half woman, half fish", wrong:["Half deer, half owl","Half bat, half cat"] },
{ q:"在Aztec myth, Tlaloc ruled over?", correct:"Rain and storms", wrong:["War and sun","Trade and travel"] },
{ q:"Inca太阳god?", correct:"Inti", wrong:["Viracocha","Pachamama"] },
{ q:"Quirinus and Mars是gods来自哪个culture?", correct:"Roman", wrong:["Persian","Chinese"] },
{ q:"Japanese storm and sea god Susanoo是brother的?", correct:"Amaterasu", wrong:["Raijin","Hachiman"] },
{ q:"Amaterasu在Shinto是goddess的?", correct:"The sun", wrong:["The underworld","Chaos"] },

{ q:"Spirit messengers在Shinto经常appear为?", correct:"Foxes", wrong:["Owls","Sharks"] },
{ q:"Njord在Norse myth是linked到?", correct:"Sea and wealth", wrong:["Pure fire","Horses and oats"] },
{ q:"Hel在Norse myth rules?", correct:"The dead in the underworld", wrong:["The giants in the mountains","The dwarves under Yggdrasil"] },
{ q:"Fenrir在Norse myth是大?", correct:"Wolf", wrong:["Eagle","Serpent"] },
{ q:"Jörmungandr是?", correct:"World Serpent", wrong:["Sun chariot","Stone giant king"] },
{ q:"Greek god谁drives太阳chariot?", correct:"Helios", wrong:["Hermes","Pluto"] },
{ q:"Roman goddess的love?", correct:"Venus", wrong:["Minerva","Diana"] },
{ q:"Minerva在Roman myth equals哪个Greek goddess?", correct:"Athena", wrong:["Aphrodite","Hera"] },
{ q:"在myth, Cupid's arrows cause?", correct:"Love", wrong:["Death","Madness only"] },
{ q:"Pan在Greek myth是god的?", correct:"Wild nature and shepherds", wrong:["Sea storms","Volcanoes"] },

{ q:"Greek underworld paradise为heroes?", correct:"Elysium", wrong:["Tartarus","The Asphodel"] },
{ q:"Tartarus是?", correct:"Deepest hell-like pit for punishment", wrong:["Field of flowers for heroes","Heaven in Norse myth"] },
{ q:"谁solved riddle的Sphinx?", correct:"Oedipus", wrong:["Odysseus","Achilles"] },
{ q:"Odysseus是famous为?", correct:"Long voyage home after Trojan War", wrong:["Slaying Medusa","Creating the Minotaur"] },
{ q:"Trojan War began over?", correct:"Abduction of Helen", wrong:["Missing gold ship","Broken treaty with Sparta about olives"] },
{ q:"在Arthurian legend, Merlin是?", correct:"Wizard advisor", wrong:["King of dragons","Knight of the Round Table"] },
{ q:"Lady的Lake gave?", correct:"Excalibur", wrong:["Holy Grail","Dragon egg"] },
{ q:"Holy Grail是经常said到be?", correct:"A sacred cup", wrong:["A cursed spear","A living sword"] },
{ q:"在folklore, will-o'-the-wisp是?", correct:"Ghostly light that lures travelers", wrong:["Underground troll gate","Invisible wind spirit that sings"] },
{ q:"Basajaun在Basque folklore是?", correct:"Forest guardian giant", wrong:["Sea witch","Desert snake god"] },

{ q:"Wendigo legend是来自?", correct:"Algonquian/North American folklore", wrong:["Greek myth","Hindu epic"] },
{ q:"Wendigo是associated与?", correct:"Cannibal hunger and winter", wrong:["Ocean storms","Harvest luck"] },
{ q:"Skinwalker lore主要comes来自?", correct:"Navajo tradition", wrong:["Mayan priests","Celtic druids"] },
{ q:"Skinwalker ability?", correct:"Shapeshift", wrong:["Control metal","Turn invisible underwater"] },
{ q:"Morrígan在Irish myth是linked到?", correct:"War and fate", wrong:["Childbirth only","Harvest cooking"] },
{ q:"Cú Chulainn是hero来自?", correct:"Irish legend", wrong:["Greek myth","Zulu oral history"] },
{ q:"在Chinese myth, dragon symbolizes?", correct:"Power and good fortune", wrong:["Pure evil only","Cowardice"] },
{ q:"什么是kitsune known为?", correct:"Clever fox spirit with magic", wrong:["Winged horse demon","Undead samurai"] },
{ q:"在Yoruba mythology, Shango是linked到?", correct:"Thunder", wrong:["Oceans","Medicine"] },
{ q:"在Yoruba belief, Orisha是?", correct:"Spiritual deities/forces", wrong:["Cursed undead","Forest goblins"] },

{ q:"在Hindu myth, Vishnu是known为?", correct:"The Preserver", wrong:["The Destroyer","The Creator only"] },
{ q:"在Hindu myth, Shiva是known为?", correct:"The Destroyer / Transformer", wrong:["The Sun Rider","The Trickster Fox"] },
{ q:"在Hindu myth, Brahma是known为?", correct:"The Creator", wrong:["The Judge","The Messenger"] },
{ q:"Durga是?", correct:"Warrior goddess", wrong:["Snake demon god","Forest satyr"] },
{ q:"Ganesha是easily known按?", correct:"Elephant head", wrong:["Lion tail","Wings of fire"] },
{ q:"Ravana在Ramayana是?", correct:"A demon king with many heads", wrong:["A frog god","A sea horse spirit"] },
{ q:"Hanuman是divine?", correct:"Monkey hero", wrong:["Snake priest","Tiger prince"] },
{ q:"Japanese oni是usually?", correct:"Horned demons or ogres", wrong:["Ice dragons","Ghost foxes with wings"] },
{ q:"Tengu在Japanese folklore是?", correct:"Winged mountain spirits", wrong:["River sharks","Living swords"] },
{ q:"Bunyip是creature来自?", correct:"Australian Aboriginal folklore", wrong:["Icelandic saga","Mayan codex"] },

{ q:"Selkies在Celtic lore transform between?", correct:"Seal and human", wrong:["Wolf and bird","Tree and mist"] },
{ q:"La Llorona在Latin folklore是?", correct:"Weeping ghost woman", wrong:["Forest troll queen","Desert fire cat"] },
{ q:"El Dorado legend是about?", correct:"A city/king of great gold", wrong:["Immortal snake god","Floating glass island"] },
{ q:"Bermuda Triangle legend involves?", correct:"Disappearances of ships and planes", wrong:["Vampire storms","Talking dolphins kidnapping people"] },
{ q:"在Greek myth, Artemis是goddess的?", correct:"Hunt and moon", wrong:["Seas and storms","Wine and madness"] },
{ q:"在Greek myth, Hephaestus是god的?", correct:"Forge and fire", wrong:["Wind and sky","Love and beauty"] },
{ q:"在Greek myth, Demeter controls?", correct:"Harvest and crops", wrong:["War and rage","Earthquakes"] },
{ q:"在Norse myth, Freyja是goddess的?", correct:"Love, beauty, battle choice", wrong:["Pure ice storms","Only childbirth"] },
{ q:"在Norse myth, berserkers是?", correct:"Fierce warriors in battle-trance", wrong:["Priests who never fought","Blind poets only"] },
{ q:"在folklore, golem是?", correct:"Animated figure made from clay", wrong:["Invisible wind spirit","Half-horse demon"] },


/* ===== FOOD & DRINK (101-200) ===== */

{ q:"主要ingredient在traditional hummus?", correct:"Chickpeas", wrong:["Lentils","White beans only"] },
{ q:"Sushi traditionally uses?", correct:"Vinegared rice", wrong:["Raw cabbage","Boiled wheat"] },
{ q:"Guacamole's主要fruit?", correct:"Avocado", wrong:["Banana","Green tomato"] },
{ q:"主要grain在bread?", correct:"Wheat", wrong:["Rice","Corn husk"] },
{ q:"主要grain在corn tortillas?", correct:"Maize", wrong:["Wheat","Barley"] },

{ q:"什么 'al dente' pasta mean?", correct:"Firm to the bite", wrong:["Totally soft","Undercooked/raw"] },
{ q:"哪个dairy product是churned到make butter?", correct:"Cream", wrong:["Yogurt","Skim milk powder"] },
{ q:"什么gives多少chilis their heat?", correct:"Capsaicin", wrong:["Caffeine","Citric acid"] },
{ q:"哪个vitamin是high在citrus fruit?", correct:"Vitamin C", wrong:["Vitamin D","Vitamin K2"] },
{ q:"哪个mineral是high在食盐?", correct:"Sodium", wrong:["Calcium","Iron"] },

{ q:"主要ingredient在tofu?", correct:"Soybeans", wrong:["Potatoes","Coconut"] },
{ q:"Tempeh是made来自?", correct:"Fermented soybeans", wrong:["Pickled cabbage","Pressed rice"] },
{ q:"Kimchi是traditionally?", correct:"Fermented spicy cabbage", wrong:["Fried noodles","Coconut soup"] },
{ q:"Miso是paste made来自?", correct:"Fermented soybeans", wrong:["Fermented apples","Fermented corn syrup"] },
{ q:"Tahini是paste来自?", correct:"Sesame seeds", wrong:["Peanuts","Sunflower seeds"] },

{ q:"Saffron comes来自哪个植物part?", correct:"Crocus flower stigma", wrong:["Poppy seed","Rose petal"] },
{ q:"Vanilla comes来自?", correct:"An orchid pod", wrong:["Tree bark","Seaweed"] },
{ q:"Caviar traditionally是?", correct:"Salted fish roe", wrong:["Fried squid skin","Pickled shrimp eyes"] },
{ q:"Foie gras comes来自?", correct:"Fatty duck/goose liver", wrong:["Cow heart","Pig kidney"] },
{ q:"Prosciutto是?", correct:"Cured ham", wrong:["Smoked fish","A cheese sauce"] },

{ q:"什么是mozzarella?", correct:"Soft Italian cheese", wrong:["Cured pork","Flatbread"] },
{ q:"Parmigiano Reggiano是type的?", correct:"Hard aged cheese", wrong:["Sweet pastry","Boiled sausage"] },
{ q:"Brie comes来自哪个在哪个国家?", correct:"France", wrong:["Greece","Denmark"] },
{ q:"Feta是traditionally来自?", correct:"Greece", wrong:["Sweden","Morocco"] },
{ q:"Halloumi是known为?", correct:"Grilling without melting", wrong:["Being blue-veined","Exploding in oil"] },

{ q:"Paella originated在哪?", correct:"Spain", wrong:["Brazil","Iceland"] },
{ q:"Ramen是originally来自?", correct:"Japan", wrong:["Peru","Poland"] },
{ q:"Pho是noodle soup来自?", correct:"Vietnam", wrong:["Korea","Laos"] },
{ q:"Curry是heavily associated与?", correct:"Indian cuisine", wrong:["Finnish cuisine","Icelandic cuisine"] },
{ q:"Bibimbap是来自?", correct:"Korea", wrong:["Peru","Germany"] },

{ q:"Tacos是most associated与?", correct:"Mexico", wrong:["Switzerland","Egypt"] },
{ q:"Pierogi是来自?", correct:"Poland", wrong:["Kenya","Chile"] },
{ q:"Baklava是layered pastry与?", correct:"Nuts and honey syrup", wrong:["Meat sauce","Pickled fish"] },
{ q:"Falafel是usually?", correct:"Deep-fried chickpea balls", wrong:["Grilled eggplant skins","Raw minced lamb patties"] },
{ q:"Borscht是soup made主要来自?", correct:"Beetroot", wrong:["Coconut milk","Zucchini flowers"] },

{ q:"Pesto traditionally uses?", correct:"Basil, pine nuts, olive oil, cheese", wrong:["Tomato paste and sugar","Only parsley and butter"] },
{ q:"Guanciale是?", correct:"Cured pork cheek", wrong:["Goat yogurt","Beef tendon stew"] },
{ q:"Carbonara traditionally uses?", correct:"Egg, cheese, cured pork", wrong:["Cream sauce only","Tomato and basil only"] },
{ q:"Sashimi是?", correct:"Raw sliced fish", wrong:["Fried eel roll","Cooked crab cake"] },
{ q:"Ceviche 'cooks' 鱼类使用?", correct:"Citrus acid", wrong:["Boiling milk","Salt smoke only"] },

{ q:"Tempura是?", correct:"Lightly battered and fried seafood/veg", wrong:["Raw beef strips","Fermented tofu drink"] },
{ q:"Dim sum refers到?", correct:"Small Cantonese dishes", wrong:["Single giant stew","Only dessert buns"] },
{ q:"Bao bun texture?", correct:"Soft steamed bread", wrong:["Crispy fried shell","Crunchy cracker sheet"] },
{ q:"Gyro meat是usually?", correct:"Seasoned meat cooked on a vertical spit", wrong:["Raw lamb cubes","Boiled chicken skin only"] },
{ q:"Shawarma是similar到?", correct:"Rotating spit-roasted meat wrap", wrong:["Cold pickled fish patty","Deep-fried milk block"] },

{ q:"什么alcohol是在margarita?", correct:"Tequila", wrong:["Whiskey","Vodka"] },
{ q:"主要alcohol在mojito?", correct:"Rum", wrong:["Gin","Tequila"] },
{ q:"主要spirit在gin & tonic?", correct:"Gin", wrong:["Vodka","Rum"] },
{ q:"Whisky/whiskey是traditionally made来自?", correct:"Grain mash", wrong:["Grape juice","Cactus sap"] },
{ q:"Tequila是distilled来自?", correct:"Blue agave", wrong:["Potato","Barley"] },

{ q:"Vodka是commonly distilled来自?", correct:"Grain or potato", wrong:["Banana leaves","Cocoa butter"] },
{ q:"Sake是?", correct:"Japanese rice wine", wrong:["Korean seaweed beer","Chinese corn rum"] },
{ q:"红色wine gets color来自?", correct:"Grape skins", wrong:["Beet juice","Added dye"] },
{ q:"Champagne是type的?", correct:"Sparkling wine", wrong:["Whiskey","Vodka soda"] },
{ q:"IPA代表什么?", correct:"India Pale Ale", wrong:["Island Pine Ale","Imperial Pale Acid"] },

{ q:"Lactose是sugar发现于在哪?", correct:"Milk", wrong:["Salted fish","Leafy greens"] },
{ q:"Gluten是protein发现于在哪?", correct:"Wheat and related grains", wrong:["Pure coconut","Only meat"] },
{ q:"People与celiac disease must avoid?", correct:"Gluten", wrong:["All fruit","All fats"] },
{ q:"People与lactose intolerance struggle到digest?", correct:"Milk sugar", wrong:["Protein in meat","Vitamin C"] },
{ q:"Kombucha是fermented?", correct:"Tea drink", wrong:["Tomato sauce","Yogurt cheese"] },

{ q:"Espresso是made按forcing?", correct:"Hot water through fine coffee grounds", wrong:["Steam through tea leaves only","Cold milk through cocoa powder"] },
{ q:"Latte是basically?", correct:"Espresso with steamed milk", wrong:["Filtered tea with butter","Cold brew with soda"] },
{ q:"Matcha是?", correct:"Powdered green tea", wrong:["Seaweed paste","Chili oil"] },
{ q:"Yerba mate是drink来自?", correct:"South America", wrong:["Iceland","Japan"] },
{ q:"Bubble tea traditionally includes?", correct:"Tapioca pearls", wrong:["Chia seeds only","Pop rocks candy"] },

{ q:"Cocoa beans是used到make?", correct:"Chocolate", wrong:["Tofu","White bread"] },
{ q:"Dark chocolate usually有more?", correct:"Cocoa solids", wrong:["Milk fat only","Gelatin powder"] },
{ q:"White chocolate有no?", correct:"Cocoa solids", wrong:["Sugar","Fat"] },
{ q:"Umami是described为?", correct:"Savory taste", wrong:["Pure sour burn","Frozen texture"] },
{ q:"MSG是commonly used到enhance?", correct:"Umami flavor", wrong:["Color only","Sugar level"] },

{ q:"主要ingredient在French fries?", correct:"Potato", wrong:["Plantain peel","Radish skin"] },
{ q:"主要ingredient在gnocchi?", correct:"Potato", wrong:["Pumpkin seed","Spinach stems"] },
{ q:"主要ingredient在polenta?", correct:"Cornmeal", wrong:["Rice flour","Almond butter"] },
{ q:"主要grain在risotto?", correct:"Arborio rice", wrong:["Oats","Buckwheat"] },
{ q:"主要carb在couscous?", correct:"Semolina wheat", wrong:["Chickpea skin","Coconut flour"] },

{ q:"Edamame是?", correct:"Immature soybeans", wrong:["Pickled eggs","Baby cucumbers"] },
{ q:"Gazpacho是served?", correct:"Cold", wrong:["Deep-fried","Frozen solid"] },
{ q:"Gazpacho是主要made来自?", correct:"Tomato and veg blended", wrong:["Milk and egg yolk only","Beef stock and barley"] },
{ q:"Tiramisu flavor base?", correct:"Coffee and cocoa", wrong:["Lime and mint","Banana and rum only"] },
{ q:"Baklava sweetness主要comes来自?", correct:"Honey or syrup", wrong:["Tomato sauce","Fermented fish paste"] },

{ q:"Churros是?", correct:"Fried dough pastry with sugar", wrong:["Raw corn mash","Frozen milk cubes"] },
{ q:"Crêpe是?", correct:"Very thin pancake", wrong:["Deep-fried cheese ball","Grilled breadstick"] },
{ q:"Pancetta是?", correct:"Cured pork belly", wrong:["Pressed goat cheese","Dried squid skin"] },
{ q:"Chorizo是usually?", correct:"Spiced sausage", wrong:["Fermented yogurt drink","Leaf-wrapped cheese"] },
{ q:"Saucisson refers到?", correct:"Dry-cured sausage", wrong:["Pickled cabbage","Fried bread"] },

{ q:"什么是ghee?", correct:"Clarified butter", wrong:["Fermented garlic","Rice vinegar"] },
{ q:"什么是naan?", correct:"Leavened flatbread", wrong:["Soup dumpling","Cold rice cake"] },
{ q:"什么是paneer?", correct:"Fresh cheese", wrong:["Flatbread","Chili paste"] },
{ q:"什么是tikka masala sauce例如?", correct:"Spiced tomato-cream style sauce", wrong:["Plain soy sauce","Cold citrus broth"] },
{ q:"什么是vindaloo known为?", correct:"Being very spicy", wrong:["Being raw only","Being a dessert custard"] },

{ q:"Sourdough rises使用?", correct:"Wild yeast culture", wrong:["Baking soda only","Whipped egg whites only"] },
{ q:"Baking soda needs什么到react?", correct:"Acid", wrong:["UV light","Liquid nitrogen"] },
{ q:"Baking powder already contains?", correct:"Acid + base to leaven", wrong:["Only sugar crystals","Only salt"] },
{ q:"Yeast在bread produces?", correct:"Carbon dioxide gas", wrong:["Chlorine gas","Pure helium"] },
{ q:"Over-kneading dough can make bread?", correct:"Too tough/chewy", wrong:["Explode in oven","Taste like lemon"] },

{ q:"什么是cevapi/ćevapi?", correct:"Grilled minced meat sausages (Balkan)", wrong:["Raw fish paste","Sweet rice dumplings"] },
{ q:"什么是taramasalata?", correct:"Fish roe dip", wrong:["Cabbage roll","Fried potato cake"] },
{ q:"什么是baba ganoush?", correct:"Roasted eggplant dip", wrong:["Spicy yogurt drink","Raw lamb tartare"] },
{ q:"什么是tzatziki主要made的?", correct:"Yogurt, cucumber, garlic", wrong:["Tomato, tuna, rice","Egg yolk and vinegar only"] },
{ q:"什么是sauerkraut?", correct:"Fermented cabbage", wrong:["Dried apples","Pickled beef skin"] },

{ q:"什么是bratwurst?", correct:"German sausage", wrong:["Icelandic cheese","Spanish custard"] },
{ q:"什么是schnitzel?", correct:"Breaded fried cutlet", wrong:["Cold raw fish cubes","Steamed bread pudding"] },
{ q:"什么是fondue?", correct:"Melted cheese dip", wrong:["Pickled onion soup","Frozen wine slush only"] },
{ q:"什么是churro traditionally coated与?", correct:"Sugar and sometimes cinnamon", wrong:["Sesame oil","Soy sauce"] },
{ q:"什么是dulce de leche?", correct:"Slow-cooked sweet milk caramel", wrong:["Chili paste","Pickled mango brine"] },

{ q:"什么是espresso martini base spirit?", correct:"Vodka", wrong:["Rum","Tequila"] },
{ q:"什么是Irish coffee spiked与?", correct:"Whiskey", wrong:["Gin","Tequila"] },
{ q:"什么是Bloody Mary base alcohol?", correct:"Vodka", wrong:["Rum","Whiskey"] },
{ q:"主要flavor在licorice candy?", correct:"Anise-like flavor", wrong:["Mint only","Vanilla only"] },
{ q:"什么是wasabi traditionally?", correct:"A pungent Japanese root paste", wrong:["Sweet soy jam","Pickled ginger leaf"] },

{ q:"Tempura dipping sauce是usually?", correct:"Light soy/dashi-based", wrong:["Pure ketchup","Honey mustard"] },
{ q:"Teriyaki flavor profile?", correct:"Sweet soy glaze", wrong:["Plain vinegar","Pure chili oil"] },
{ q:"Gochujang是?", correct:"Korean chili paste", wrong:["Japanese fish flakes","Chinese rice noodle"] },
{ q:"Sriracha是?", correct:"Garlic chili sauce", wrong:["Fermented bean curd","Sweet plum syrup only"] },
{ q:"Harissa是?", correct:"North African chili paste", wrong:["Russian beet cream","Icelandic fermented shark oil"] },

{ q:"Piri piri chicken flavor comes来自?", correct:"Chili pepper marinade", wrong:["Sugar glaze only","Raw milk soak"] },
{ q:"Jerk seasoning是来自?", correct:"Jamaica", wrong:["Sweden","Turkey"] },
{ q:"Plantains是?", correct:"Starchy cooking bananas", wrong:["Seaweed chips","Sweet melons only"] },
{ q:"Poutine是fries topped与?", correct:"Cheese curds and gravy", wrong:["Raw tuna and wasabi","Caramel sauce"] },
{ q:"什么是baozi?", correct:"Stuffed steamed bun", wrong:["Cold jelly noodle","Dried fish strip"] },

{ q:"什么是ceviche usually served为?", correct:"Cold marinated seafood dish", wrong:["Boiling stew","Frozen dessert"] },
{ q:"什么是gazpacho known为temperature-wise?", correct:"Served chilled", wrong:["Served boiling","Served frozen solid"] },
{ q:"什么是carpaccio?", correct:"Very thin raw meat/fish slices", wrong:["Deep-fried bread balls","Fermented cabbage roll"] },
{ q:"什么是tartare?", correct:"Raw minced meat seasoned", wrong:["Burnt sugar shell","Freeze-dried soup"] },
{ q:"什么是sashimi NOT served与traditionally?", correct:"Bread slices", wrong:["Soy sauce","Wasabi"] },

{ q:"为什么we marinate meat在acid/citrus?", correct:"Tenderize and flavor", wrong:["Make it waterproof","Remove protein completely"] },
{ q:"为什么rest cooked steak before cutting?", correct:"Let juices redistribute", wrong:["Cool it for safety only","Increase bone density"] },
{ q:"为什么sear meat?", correct:"Brown surface for flavor", wrong:["Seal in all juices magically","Sterilize to lab-grade"] },
{ q:"为什么是olive oil被称为 'extra virgin'?", correct:"First cold pressing, minimal processing", wrong:["Mixed with butter","Boiled with sugar"] },
{ q:"为什么onions make you cry?", correct:"Sulfur compounds released", wrong:["Pure capsaicin","Random pollen"] },

{ q:"为什么是√2 irrational?", correct:"It cannot be expressed as a ratio of integers", wrong:["Its decimal never ends","It was proven by Euclid only"] },
{ q:"为什么division按zero fail?", correct:"No number satisfies the inverse operation", wrong:["Infinity is too large","Zero has no sign"] },
{ q:"为什么是0! equal到1?", correct:"It preserves combinatorial identities", wrong:["Zero multiplied by one","By definition only"] },
{ q:"为什么是derivative的constant zero?", correct:"No change occurs with respect to input", wrong:["Constants cancel out","Limits stop working"] },
{ q:"为什么harmonic series diverge?", correct:"Its partial sums grow without bound", wrong:["Terms do not approach zero","It oscillates"] },
{ q:"为什么是e base的天然的logarithms?", correct:"It simplifies growth and calculus rules", wrong:["It is irrational","Euler chose it arbitrarily"] },
{ q:"为什么是matrix multiplication not commutative?", correct:"Order changes linear transformations", wrong:["Matrices are not numbers","Determinants differ"] },
{ q:"为什么mean minimize squared error?", correct:"It is the least-squares minimizer", wrong:["It balances values","It averages distances"] },
{ q:"为什么是median robust到outliers?", correct:"It depends only on order, not magnitude", wrong:["It ignores extremes","It is always central"] },
{ q:"为什么是area under velocity displacement?", correct:"Velocity is rate of change of position", wrong:["Speed adds distance","Acceleration integrates twice"] },

{ q:"为什么 ∫1/x dx equal ln|x|?", correct:"Its derivative equals 1/x", wrong:["Because x cancels","By logarithm rules"] },
{ q:"为什么是determinant zero为dependent vectors?", correct:"They span zero volume", wrong:["They overlap","Rows repeat"] },
{ q:"为什么是negative discriminant complex?", correct:"No real roots satisfy the equation", wrong:["Imaginary numbers appear","Square roots fail"] },
{ q:"为什么correlation not imply causation?", correct:"Variables may share external influences", wrong:["Correlation is weak","Graphs are misleading"] },
{ q:"为什么Central Limit Theorem hold?", correct:"Independent sums converge to normality", wrong:["Means are symmetric","Variance disappears"] },
{ q:"为什么是unit circle radius one?", correct:"It normalizes trigonometric definitions", wrong:["It simplifies graphs","It is arbitrary"] },
{ q:"为什么是log(ab)=log + log b?", correct:"Logs convert multiplication to addition", wrong:["Exponents distribute","Products scale"] },
{ q:"为什么是empty set subset的all sets?", correct:"No element violates the definition", wrong:["It contains zero","It is universal"] },
{ q:"为什么sin²x + cos²x = 1?", correct:"It follows from the unit circle", wrong:["Trig identity","Pythagoras applies"] },
{ q:"为什么是inverse的function unique?", correct:"Only one mapping undoes outputs uniquely", wrong:["Functions are injective","Graphs mirror"] },

{ q:"为什么Newton's method有时fail?", correct:"Poor initial guesses diverge", wrong:["Derivatives vanish","Roots move"] },
{ q:"为什么是series absolutely convergent stronger?", correct:"Order of summation does not matter", wrong:["Terms shrink faster","Signs cancel"] },
{ q:"为什么是rank-nullity theorem true?", correct:"Domain splits into kernel and image", wrong:["Dimensions add","Matrices balance"] },
{ q:"为什么exp(ix)=cos x + i sin x?", correct:"It follows from Taylor series", wrong:["Euler defined it","Complex rotation"] },
{ q:"为什么是eigenvalues invariant under similarity?", correct:"They represent intrinsic transformations", wrong:["Matrices reorder","Traces match"] },
{ q:"为什么convex function有one minimum?", correct:"No local minima exist besides global", wrong:["Curves bend upward","Slopes vanish once"] },
{ q:"为什么是derivative linear?", correct:"Limits preserve linear operations", wrong:["Rates add","Slopes scale"] },
{ q:"为什么是probability measure normalized?", correct:"Total probability must equal one", wrong:["Outcomes sum","Events exhaust space"] },
{ q:"为什么是variance squared units?", correct:"It averages squared deviations", wrong:["Distances square","Statistics require it"] },
{ q:"为什么是bijection invertible?", correct:"Each output maps to exactly one input", wrong:["Sets match size","Functions reverse"] },

{ q:"为什么是modular arithmetic cyclic?", correct:"Values wrap after fixed modulus", wrong:["Remainders repeat","Division truncates"] },
{ q:"为什么Fermat's Little Theorem hold?", correct:"It follows from modular exponent cycles", wrong:["Primes dominate","Powers reduce"] },
{ q:"为什么是cross product zero为parallel vectors?", correct:"No perpendicular component exists", wrong:["Angles vanish","Magnitudes cancel"] },
{ q:"为什么是dot product maximized何时aligned?", correct:"Cosine of zero is one", wrong:["Lengths multiply","Angles shrink"] },
{ q:"为什么是function continuous在point?", correct:"Limits equal function value", wrong:["Graph connects","No jumps"] },
{ q:"为什么是normal distribution symmetric?", correct:"It depends only on squared deviations", wrong:["Means center","Variance balances"] },
{ q:"为什么integration undo differentiation?", correct:"They are inverse limit processes", wrong:["Areas cancel slopes","Fundamental theorem"] },
{ q:"为什么Jacobian探测invertibility?", correct:"Nonzero determinant preserves volume", wrong:["Gradients align","Matrices rotate"] },
{ q:"为什么Gauss elimination work?", correct:"Row operations preserve solutions", wrong:["Equations simplify","Zeros appear"] },
{ q:"为什么是limit unique if it exists?", correct:"Two different limits contradict ε-δ", wrong:["Approaches converge","Graphs meet"] },

{ q:"为什么是spanning tree minimal?", correct:"Removing any edge disconnects it", wrong:["No cycles exist","Graphs shrink"] },
{ q:"为什么Bayesian updating work?", correct:"It applies conditional probability consistently", wrong:["Data accumulates","Prior disappears"] },
{ q:"为什么是entropy maximized在equilibrium?", correct:"Most microstates correspond to it", wrong:["Energy spreads","Systems settle"] },
{ q:"为什么是solution space的linear equations affine?", correct:"It is a translated subspace", wrong:["Lines shift","Vectors move"] },
{ q:"为什么Simpson's paradox occur?", correct:"Aggregated data hides group trends", wrong:["Statistics lie","Samples mismatch"] },
{ q:"为什么是spectral theorem restricted?", correct:"It requires symmetry or normality", wrong:["Eigenvalues fail","Matrices skew"] },
{ q:"为什么是质数greater than 3的form 6k±1?", correct:"Other residues are composite", wrong:["Modulo cycles","Factors repeat"] },
{ q:"为什么inverse Laplace transform exist?", correct:"Original function satisfies growth bounds", wrong:["Integrals converge","Transforms reverse"] },
{ q:"为什么Taylor series approximate locally?", correct:"Higher-order terms vanish near point", wrong:["Polynomials fit","Derivatives guide"] },
{ q:"为什么是real line uncountable?", correct:"No bijection with naturals exists", wrong:["Decimals infinite","Cantor proved it"] },

{ q:"为什么是probability density not probability?", correct:"It must be integrated to give probability", wrong:["Values exceed one","Units differ"] },
{ q:"为什么binomial distribution approach normal?", correct:"It satisfies CLT conditions", wrong:["Trials increase","Symmetry emerges"] },
{ q:"为什么是kernel subspace?", correct:"It is closed under addition and scaling", wrong:["Zeros group","Solutions align"] },
{ q:"为什么rotation matrix preserve length?", correct:"Its columns are orthonormal", wrong:["Angles fixed","Determinant one"] },
{ q:"为什么是determinant multiplicative?", correct:"Volume scales multiplicatively", wrong:["Matrices combine","Rows expand"] },
{ q:"为什么continuous function在closed interval attain extrema?", correct:"The set is compact", wrong:["Graphs flatten","Endpoints count"] },
{ q:"为什么是z-transform useful?", correct:"It converts difference equations to algebraic", wrong:["Signals shift","Frequencies appear"] },
{ q:"为什么是inverse的exp log?", correct:"They undo each other’s growth", wrong:["Bases match","Curves mirror"] },
{ q:"为什么是probability的exact value zero?", correct:"Continuous outcomes have zero measure", wrong:["Decimals infinite","Intervals matter"] },
{ q:"为什么Cauchy–Schwarz inequality hold?", correct:"It bounds projection magnitude", wrong:["Angles restrict","Lengths compare"] },

{ q:"什么是0 divided按5?", correct:"0", wrong:["Undefined","5"] },
{ q:"什么是5 divided按0?", correct:"Undefined", wrong:["0","Infinity"] },
{ q:"是1质数number?", correct:"No", wrong:["Yes","Only sometimes"] },
{ q:"什么是square root的0?", correct:"0", wrong:["Undefined","1"] },
{ q:"什么是value的1⁰?", correct:"1", wrong:["0","Undefined"] },
{ q:"什么是value的0⁰?", correct:"Undefined", wrong:["0","1"] },
{ q:"是−2² equal到4?", correct:"No", wrong:["Yes","Depends on calculator"] },
{ q:"什么是value的|−0|?", correct:"0", wrong:["−0","Undefined"] },
{ q:"0.999... equal 1?", correct:"Yes", wrong:["No","Almost"] },
{ q:"什么是next number: 2,4,8,16,?", correct:"32", wrong:["24","30"] },

{ q:"是√9 equal到 −3?", correct:"No", wrong:["Yes","Both ±3"] },
{ q:"什么是slope的vertical line?", correct:"Undefined", wrong:["0","Infinite"] },
{ q:"什么是log₁(10)?", correct:"Undefined", wrong:["1","0"] },
{ q:"什么是log(1)?", correct:"0", wrong:["1","Undefined"] },
{ q:"是0 even number?", correct:"Yes", wrong:["No","Neither"] },
{ q:"什么是derivative的constant?", correct:"0", wrong:["1","Undefined"] },
{ q:"什么是area的line?", correct:"0", wrong:["Undefined","1"] },
{ q:"多少sides circle有?", correct:"0", wrong:["1","Infinite"] },
{ q:"什么是sum的angles在triangle?", correct:"180°", wrong:["360°","Depends on size"] },
{ q:"是infinity number?", correct:"No", wrong:["Yes","Sometimes"] },

{ q:"什么是median的[1,2,100]?", correct:"2", wrong:["1","100"] },
{ q:"Can function be its own inverse?", correct:"Yes", wrong:["No","Only linear"] },
{ q:"是√(²) always equal到?", correct:"No", wrong:["Yes","Only positive"] },
{ q:"什么是probability的sure event?", correct:"1", wrong:["0","100"] },
{ q:"是0 positive?", correct:"No", wrong:["Yes","Both"] },
{ q:"是−0 less than 0?", correct:"No", wrong:["Yes","Sometimes"] },
{ q:"什么是perimeter的point?", correct:"0", wrong:["Undefined","1"] },
{ q:"什么是value的sin(0)?", correct:"0", wrong:["1","Undefined"] },
{ q:"converging sequence always reach its limit?", correct:"No", wrong:["Yes","Eventually"] },
{ q:"是every continuous function differentiable?", correct:"No", wrong:["Yes","Almost"] },

{ q:"什么是volume的2D shape?", correct:"0", wrong:["Undefined","Depends"] },
{ q:"是square rectangle?", correct:"Yes", wrong:["No","Only special cases"] },
{ q:"是rectangle always square?", correct:"No", wrong:["Yes","If equal sides"] },
{ q:"什么是additive identity?", correct:"0", wrong:["1","−1"] },
{ q:"什么是multiplicative identity?", correct:"1", wrong:["0","−1"] },
{ q:"是empty set empty?", correct:"Yes", wrong:["No","Depends"] },
{ q:"多少elements在empty set?", correct:"0", wrong:["1","Infinite"] },
{ q:"是division distributive over addition?", correct:"No", wrong:["Yes","Sometimes"] },
{ q:"larger sample size always remove bias?", correct:"No", wrong:["Yes","Eventually"] },
{ q:"是2仅even质数?", correct:"Yes", wrong:["No","Depends on base"] },
{ q:"谁创作了Mona Lisa?", correct:"Leonardo da Vinci", wrong:["Michelangelo","Raphael"] },
{ q:"Physicist behind theory的relativity?", correct:"Albert Einstein", wrong:["Isaac Newton","Niels Bohr"] },
{ q:"第一个person到walk在月球?", correct:"Neil Armstrong", wrong:["Buzz Aldrin","Yuri Gagarin"] },
{ q:"谁发现了penicillin?", correct:"Alexander Fleming", wrong:["Louis Pasteur","Edward Jenner"] },
{ q:"作者的'1984'?", correct:"George Orwell", wrong:["Aldous Huxley","Ray Bradbury"] },
{ q:"Apple co-founder known为iPhone era?", correct:"Steve Jobs", wrong:["Bill Gates","Tim Cook"] },
{ q:"Microsoft co-founder?", correct:"Bill Gates", wrong:["Steve Ballmer","Steve Jobs"] },
{ q:"Founder的Amazon?", correct:"Jeff Bezos", wrong:["Elon Musk","Larry Page"] },
{ q:"CEO谁leads SpaceX and helped建造Tesla?", correct:"Elon Musk", wrong:["Jeff Bezos","Peter Thiel"] },
{ q:"Founder的Facebook?", correct:"Mark Zuckerberg", wrong:["Jack Dorsey","Larry Page"] },
{ q:"谁formulated law的universal gravitation?", correct:"Isaac Newton", wrong:["Galileo Galilei","Johannes Kepler"] },
{ q:"Pioneer的smallpox vaccine?", correct:"Edward Jenner", wrong:["Louis Pasteur","Robert Koch"] },
{ q:"作者的'Pride and Prejudice'?", correct:"Jane Austen", wrong:["Charlotte Brontë","Emily Brontë"] },
{ q:"作者的Harry Potter series?", correct:"J.K. Rowling", wrong:["Suzanne Collins","Stephenie Meyer"] },
{ q:"Anti-apartheid leader谁became South Africa's president?", correct:"Nelson Mandela", wrong:["Desmond Tutu","Thabo Mbeki"] },
{ q:"Indian independence leader谁practiced nonviolence?", correct:"Mahatma Gandhi", wrong:["Jawaharlal Nehru","Sardar Patel"] },
{ q:"Civil rights leader谁gave 'I有Dream' speech?", correct:"Martin Luther King Jr.", wrong:["Malcolm X","Rosa Parks"] },
{ q:"第一个woman到win Nobel Prize and pioneer的radioactivity?", correct:"Marie Curie", wrong:["Lise Meitner","Rosalind Franklin"] },
{ q:"Brothers credited与第一个powered airplane flight?", correct:"Wright brothers", wrong:["Montgolfier brothers","Santos-Dumont"] },
{ q:"Explorer谁reached Americas在1492?", correct:"Christopher Columbus", wrong:["Vasco da Gama","Ferdinand Magellan"] },
{ q:"Navigator whose expedition第一个circumnavigated globe?", correct:"Ferdinand Magellan", wrong:["Francis Drake","James Cook"] },
{ q:"Naturalist谁proposed evolution按天然的selection?", correct:"Charles Darwin", wrong:["Alfred Russel Wallace","Gregor Mendel"] },
{ q:"Reformer known为founder的modern nursing?", correct:"Florence Nightingale", wrong:["Clara Barton","Mary Seacole"] },
{ q:"Founder的psychoanalysis?", correct:"Sigmund Freud", wrong:["Carl Jung","Alfred Adler"] },
{ q:"Astronomer谁发现了laws的planetary motion?", correct:"Johannes Kepler", wrong:["Nicolaus Copernicus","Tycho Brahe"] },
{ q:"Composer的Fifth Symphony在C minor?", correct:"Ludwig van Beethoven", wrong:["Wolfgang Amadeus Mozart","Johann Sebastian Bach"] },
{ q:"Composer的' Magic Flute'?", correct:"Wolfgang Amadeus Mozart", wrong:["Joseph Haydn","Ludwig van Beethoven"] },
{ q:"Artist谁painted Sistine Chapel ceiling?", correct:"Michelangelo", wrong:["Raphael","Sandro Botticelli"] },
{ q:"Actor谁played Jack在'Titanic'?", correct:"Leonardo DiCaprio", wrong:["Brad Pitt","Tom Cruise"] },
{ q:"Director的'Pulp Fiction'?", correct:"Quentin Tarantino", wrong:["Martin Scorsese","Steven Spielberg"] },
{ q:"Director的'Schindler's List'?", correct:"Steven Spielberg", wrong:["Ridley Scott","James Cameron"] },
{ q:"Beatle谁wrote and sang 'Imagine'?", correct:"John Lennon", wrong:["Paul McCartney","George Harrison"] },
{ q:"Lead singer的Rolling Stones?", correct:"Mick Jagger", wrong:["Keith Richards","Roger Daltrey"] },
{ q:"Lead vocalist的Queen?", correct:"Freddie Mercury", wrong:["David Bowie","Robert Plant"] },
{ q:"F1 legend nicknamed 'Schumi'?", correct:"Michael Schumacher", wrong:["Ayrton Senna","Lewis Hamilton"] },
{ q:"Tennis star nicknamed 'King的Clay'?", correct:"Rafael Nadal", wrong:["Roger Federer","Novak Djokovic"] },
{ q:"Sprinter known为 'Lightning'?", correct:"Usain Bolt", wrong:["Carl Lewis","Yohan Blake"] },
{ q:"Boxer nicknamed ' Greatest'?", correct:"Muhammad Ali", wrong:["Mike Tyson","Joe Frazier"] },
{ q:"画家的' Starry Night'?", correct:"Vincent van Gogh", wrong:["Paul Gauguin","Claude Monet"] },
{ q:"Impressionist famous为water-lily paintings?", correct:"Claude Monet", wrong:["Pierre-Auguste Renoir","Édouard Manet"] },
{ q:"Originator的quantum theory?", correct:"Max Planck", wrong:["Niels Bohr","Albert Einstein"] },
{ q:"第一个woman到fly solo across Atlantic?", correct:"Amelia Earhart", wrong:["Bessie Coleman","Sally Ride"] },
{ q:"第一个American在space?", correct:"Alan Shepard", wrong:["John Glenn","Gus Grissom"] },
{ q:"第一个human在space?", correct:"Yuri Gagarin", wrong:["Valentina Tereshkova","Alexei Leonov"] },
{ q:"Scientists谁proposed DNA double-helix model?", correct:"Watson and Crick", wrong:["Mendel and Pasteur","Bohr and Heisenberg"] },
{ q:"Creator的Sherlock Holmes?", correct:"Arthur Conan Doyle", wrong:["Agatha Christie","Bram Stoker"] },
{ q:"Director的'Avatar' and 'Titanic'?", correct:"James Cameron", wrong:["Peter Jackson","George Lucas"] },
{ q:"Creator的'Star Wars'?", correct:"George Lucas", wrong:["J.J. Abrams","Christopher Nolan"] },
{ q:"UK质数Minister during most的WWII?", correct:"Winston Churchill", wrong:["Neville Chamberlain","Clement Attlee"] },
{ q:"French leader crowned Emperor在1804?", correct:"Napoleon Bonaparte", wrong:["Louis XIV","Charlemagne"] },
{ q:"谁designed 'Analytical Engine' concept?", correct:"Charles Babbage", wrong:["Ada Lovelace","Alan Turing"] },
{ q:"经常被称为第一个computer programmer?", correct:"Ada Lovelace", wrong:["Grace Hopper","Charles Babbage"] },
{ q:"Codebreaker谁helped建造Bombe在Bletchley Park?", correct:"Alan Turing", wrong:["Claude Shannon","John von Neumann"] },
{ q:"Researchers credited与discovering insulin?", correct:"Banting and Best", wrong:["Salk and Sabin","Watson and Crick"] },
{ q:"Physicist谁proposed uncertainty principle?", correct:"Werner Heisenberg", wrong:["Erwin Schrödinger","Paul Dirac"] },
{ q:"Mathematician谁founded set theory?", correct:"Georg Cantor", wrong:["David Hilbert","Kurt Gödel"] },
{ q:"作者的' Second Sex'?", correct:"Simone de Beauvoir", wrong:["Betty Friedan","Virginia Woolf"] },
{ q:"第一个woman在space?", correct:"Valentina Tereshkova", wrong:["Sally Ride","Mae Jemison"] },
{ q:"Climbers谁第一个summited Everest在1953?", correct:"Edmund Hillary and Tenzing Norgay", wrong:["Reinhold Messner","George Mallory"] },
{ q:"画家的' Garden的Earthly Delights'?", correct:"Hieronymus Bosch", wrong:["Pieter Bruegel","Albrecht Dürer"] },
{ q:"Composer的'Boléro'?", correct:"Maurice Ravel", wrong:["Claude Debussy","Camille Saint-Saëns"] },
{ q:"作者的'One Hundred Years的Solitude'?", correct:"Gabriel García Márquez", wrong:["Jorge Luis Borges","Mario Vargas Llosa"] },
{ q:"Philosopher谁wrote 'Thus Spoke Zarathustra'?", correct:"Friedrich Nietzsche", wrong:["Arthur Schopenhauer","Søren Kierkegaard"] },
{ q:"'God的Manga', creator的Astro Boy?", correct:"Osamu Tezuka", wrong:["Hayao Miyazaki","Akira Toriyama"] },
{ q:"Chemist谁created periodic table?", correct:"Dmitri Mendeleev", wrong:["Antoine Lavoisier","John Dalton"] },
{ q:"Physicist谁发现了radioactivity在uranium salts (1896)?", correct:"Henri Becquerel", wrong:["Wilhelm Röntgen","Pierre Curie"] },
{ q:"Engineer known为AC motors and Tesla coil?", correct:"Nikola Tesla", wrong:["Thomas Edison","George Westinghouse"] },
{ q:"发明者的World Wide Web?", correct:"Tim Berners-Lee", wrong:["Vint Cerf","Bill Gates"] },
{ q:"Mathematician谁proved Fermat's Last Theorem?", correct:"Andrew Wiles", wrong:["Terence Tao","Grigori Perelman"] },
{ q:"Mathematician谁proved Poincaré conjecture?", correct:"Grigori Perelman", wrong:["Andrew Wiles","Edward Witten"] },
{ q:"Nurse celebrated为work在Crimean War alongside Nightingale?", correct:"Mary Seacole", wrong:["Edith Cavell","Clara Barton"] },
{ q:"作者的' Vindication的Rights的Woman'?", correct:"Mary Wollstonecraft", wrong:["Emmeline Pankhurst","John Stuart Mill"] },
{ q:"Suffragette谁died在1913 Epsom Derby?", correct:"Emily Davison", wrong:["Emmeline Pankhurst","Millicent Fawcett"] },
{ q:"Physician谁发现了systemic blood circulation?", correct:"William Harvey", wrong:["Andreas Vesalius","Galen"] },
{ q:"画家的'Guernica'?", correct:"Pablo Picasso", wrong:["Salvador Dalí","Joan Miró"] },
{ q:"画家谁co-founded Cubism与Picasso?", correct:"Georges Braque", wrong:["Juan Gris","Paul Cézanne"] },
{ q:"Composer的' Rite的Spring'?", correct:"Igor Stravinsky", wrong:["Sergei Prokofiev","Dmitri Shostakovich"] },
{ q:"Director的'Seven Samurai'?", correct:"Akira Kurosawa", wrong:["Yasujirō Ozu","Kenji Mizoguchi"] },
{ q:"作者的' Trial'?", correct:"Franz Kafka", wrong:["Thomas Mann","Albert Camus"] },
{ q:"Philosopher谁wrote 'Critique的Pure Reason'?", correct:"Immanuel Kant", wrong:["G.W.F. Hegel","René Descartes"] },
{ q:"Co-inventor的calculus independent的Newton?", correct:"Gottfried Wilhelm Leibniz", wrong:["Leonhard Euler","Descartes"] },
{ q:"Monk known为father的genetics?", correct:"Gregor Mendel", wrong:["Thomas Hunt Morgan","Barbara McClintock"] },
{ q:"Physicist的wave equation ψ在quantum mechanics?", correct:"Erwin Schrödinger", wrong:["Max Born","Werner Heisenberg"] },
{ q:"Chemist谁proposed ring structure的benzene?", correct:"August Kekulé", wrong:["Friedrich Wöhler","A.W. Hofmann"] },
{ q:"Leader的Haitian Revolution?", correct:"Toussaint Louverture", wrong:["Jean-Jacques Dessalines","Simón Bolívar"] },
{ q:"'El Libertador'的much的South美洲?", correct:"Simón Bolívar", wrong:["José de San Martín","Miguel Hidalgo"] },
{ q:"第一个emperor到unify China?", correct:"Qin Shi Huang", wrong:["Liu Bang","Han Wudi"] },
{ q:"Mongol founder谁built最大的contiguous empire?", correct:"Genghis Khan", wrong:["Kublai Khan","Tamerlane"] },
{ q:"Ottoman sultan谁conquered Constantinople在1453?", correct:"Mehmed II", wrong:["Suleiman the Magnificent","Murad II"] },
{ q:"Soviet leader during Cuban Missile Crisis?", correct:"Nikita Khrushchev", wrong:["Leonid Brezhnev","Mikhail Gorbachev"] },
{ q:"Composer的Symphony No. 9 '来自New World'?", correct:"Antonín Dvořák", wrong:["Gustav Mahler","Johannes Brahms"] },
{ q:"Italian画家的' Birth的Venus'?", correct:"Sandro Botticelli", wrong:["Titian","Giorgione"] },
{ q:"Pharaoh whose tomb是发现于intact在1922?", correct:"Tutankhamun", wrong:["Ramses II","Akhenaten"] },
{ q:"'Father的information theory'?", correct:"Claude Shannon", wrong:["Norbert Wiener","John McCarthy"] },
{ q:"Mathematician谁founded cybernetics?", correct:"Norbert Wiener", wrong:["Claude Shannon","John von Neumann"] },
{ q:"Norwegian画家的' Scream'?", correct:"Edvard Munch", wrong:["Wassily Kandinsky","Paul Klee"] },
{ q:"Astronomer谁第一个observed pulsars (1967)?", correct:"Jocelyn Bell Burnell", wrong:["Antony Hewish","Vera Rubin"] },
{ q:"Astronomer whose work在galaxy rotation implied dark matter?", correct:"Vera Rubin", wrong:["Cecilia Payne-Gaposchkin","Annie Jump Cannon"] },
{ q:"Radio pioneer and Nobel laureate?", correct:"Guglielmo Marconi", wrong:["Heinrich Hertz","Nikola Tesla"] },
{ q:"Surgeon谁performed第一个human心脏transplant (1967)?", correct:"Christiaan Barnard", wrong:["Denton Cooley","Michael DeBakey"] },
{ q:"Unit的electrical resistance?", correct:"Ohm", wrong:["Weber","Henry"] },
{ q:"Unit的capacitance?", correct:"Farad", wrong:["Tesla","Pascal"] },
{ q:"Unit的inductance?", correct:"Henry", wrong:["Coulomb","Watt"] },
{ q:"Unit的magnetic flux?", correct:"Weber", wrong:["Tesla","Joule"] },
{ q:"Unit的magnetic flux density?", correct:"Tesla", wrong:["Weber","Gauss"] },
{ q:"SI unit的power?", correct:"Watt", wrong:["Joule","Volt"] },
{ q:"SI unit的pressure?", correct:"Pascal", wrong:["Newton","Bar"] },
{ q:"SI unit的energy?", correct:"Joule", wrong:["Watt","Newton"] },
{ q:"Unit的electric charge?", correct:"Coulomb", wrong:["Ampere","Ohm"] },
{ q:"Unit的electric potential?", correct:"Volt", wrong:["Watt","Farad"] },

{ q:"1st law thermodynamics relates到?", correct:"Energy conservation", wrong:["Entropy increase","Ideal gas law"] },
{ q:"2nd law thermodynamics implies?", correct:"Entropy tends to increase", wrong:["Energy is created","Pressure is constant"] },
{ q:"3rd law: entropy在0 K为perfect crystal?", correct:"Approaches zero", wrong:["Is infinite","Equals heat capacity"] },
{ q:"Heat transfer按fluid motion?", correct:"Convection", wrong:["Conduction","Radiation"] },
{ q:"Heat transfer through vacuum?", correct:"Radiation", wrong:["Convection","Conduction"] },
{ q:"Dimensionless Re number compares?", correct:"Inertial to viscous forces", wrong:["Pressure to gravity","Heat to mass"] },
{ q:"Mach number是ratio的?", correct:"Flow speed to sound speed", wrong:["Lift to drag","Pressure to density"] },
{ q:"Bernoulli equation links pressure到?", correct:"Velocity and elevation", wrong:["Temperature only","Viscosity only"] },
{ q:"Continuity equation enforces?", correct:"Mass conservation", wrong:["Energy conservation","Momentum conservation"] },
{ q:"Venturi effect causes pressure到?", correct:"Drop in a constriction", wrong:["Rise in a constriction","Stay constant always"] },

{ q:"Brittle fracture occurs与?", correct:"Little plastic deformation", wrong:["Large yielding","High ductility"] },
{ q:"Stress是force divided按?", correct:"Area", wrong:["Volume","Length"] },
{ q:"Strain是change在length over?", correct:"Original length", wrong:["Area","Time"] },
{ q:"Hooke's law relates stress到?", correct:"Strain (linear)", wrong:["Temperature","Density"] },
{ q:"Young's modulus measures?", correct:"Stiffness", wrong:["Hardness","Toughness"] },
{ q:"Shear modulus also被称为?", correct:"Modulus of rigidity", wrong:["Bulk modulus","Poisson modulus"] },
{ q:"Poisson's ratio是lateral strain over?", correct:"Axial strain", wrong:["Shear strain","Thermal strain"] },
{ q:"Yield strength marks start的?", correct:"Plastic deformation", wrong:["Elastic recovery","Fracture"] },
{ q:"Ultimate tensile strength是?", correct:"Maximum stress before necking", wrong:["Stress at first yield","Stress at zero strain"] },
{ q:"Fatigue failure是driven按?", correct:"Cyclic loading", wrong:["Single overload","Pure temperature"] },

{ q:"Stress concentration increases在?", correct:"Sharp notches", wrong:["Smooth fillets","Uniform sections"] },
{ q:"Buckling risk rises与?", correct:"Slender columns", wrong:["Short thick columns","Low load"] },
{ q:"Euler buckling critical load鳞片与?", correct:"EI/L^2", wrong:["E/L","I·L^2"] },
{ q:"Safety factor equals?", correct:"Strength / applied stress", wrong:["Stress / strength","Load / area"] },
{ q:"Torsion在shaft creates?", correct:"Shear stress", wrong:["Only normal stress","Only compressive stress"] },
{ q:"Bending stress是highest在?", correct:"Outer fibers", wrong:["Neutral axis","Centroid always"] },
{ q:"Neutral axis是哪里bending stress是?", correct:"Zero", wrong:["Maximum","Always tensile"] },
{ q:"Area moment的inertia affects?", correct:"Bending stiffness", wrong:["Electrical resistance","Thermal expansion"] },
{ q:"Polar moment的inertia affects?", correct:"Torsional stiffness", wrong:["Buckling only","Hardness"] },
{ q:"Creep是time-dependent deformation在?", correct:"Sustained load (often high temp)", wrong:["Zero load","Only low temp"] },

{ q:"Cast铁通常有?", correct:"High carbon content", wrong:["No carbon","Pure aluminum"] },
{ q:"Stainless steel resists corrosion通过?", correct:"Chromium oxide film", wrong:["Copper plating","High carbon"] },
{ q:"Heat treatment that increases hardness在steel?", correct:"Quenching", wrong:["Annealing","Tempering only"] },
{ q:"Annealing通常makes metal?", correct:"Softer and more ductile", wrong:["Harder","Brittle"] },
{ q:"Tempering after quench主要improves?", correct:"Toughness", wrong:["Electrical conductivity","Density"] },
{ q:"Aluminum alloys是valued为?", correct:"High strength-to-weight", wrong:["High melting point","Ferromagnetism"] },
{ q:"Polymer that softens何时reheated?", correct:"Thermoplastic", wrong:["Thermoset","Ceramic"] },
{ q:"Thermoset polymers是?", correct:"Cross-linked and not remeltable", wrong:["Always recyclable by melting","Metallic"] },
{ q:"Composite material example?", correct:"Carbon fiber reinforced polymer", wrong:["Pure copper","Glass only"] },
{ q:"Corrosion type与dissimilar metals?", correct:"Galvanic corrosion", wrong:["Erosion corrosion","Crevice only"] },

{ q:"Ohm's law是?", correct:"V = I·R", wrong:["P = V/I","Q = m·c"] },
{ q:"Power在DC circuit是?", correct:"P = V·I", wrong:["P = I/R","P = V/R^2"] },
{ q:"Series resistors add按?", correct:"Summing resistances", wrong:["Summing reciprocals","Multiplying"] },
{ q:"Parallel resistors add按?", correct:"Summing reciprocals", wrong:["Summing resistances","Subtracting"] },
{ q:"Kirchhoff's current law applies在?", correct:"Node", wrong:["Loop","Transformer core"] },
{ q:"Kirchhoff's voltage law applies around?", correct:"Closed loop", wrong:["Single node","Open circuit"] },
{ q:"Capacitor current relates到?", correct:"Rate of change of voltage", wrong:["Voltage squared","Resistance only"] },
{ q:"Inductor voltage relates到?", correct:"Rate of change of current", wrong:["Current squared","Capacitance only"] },
{ q:"Diode主要allows current在哪?", correct:"One direction", wrong:["Both equally","Neither direction"] },
{ q:"transformer works按?", correct:"Electromagnetic induction", wrong:["Static electric fields","Chemical reaction"] },

{ q:"Digital logic NOT gate outputs?", correct:"Inverse of input", wrong:["Same as input","Always 1"] },
{ q:"NAND gate是universal because it can建造?", correct:"Any Boolean function", wrong:["Only XOR","Only memory"] },
{ q:"Nyquist rate是在least?", correct:"2× highest frequency", wrong:["Half highest frequency","Equal to amplitude"] },
{ q:"PWM controls average power按varying?", correct:"Duty cycle", wrong:["Wire gauge","Frequency only"] },
{ q:"Op-amp ideal input current是?", correct:"Zero", wrong:["Infinite","Equal to output"] },
{ q:"Closed-loop control uses feedback到reduce?", correct:"Error", wrong:["Voltage","Mass"] },
{ q:"PID controller terms是?", correct:"Proportional, Integral, Derivative", wrong:["Power, Input, Delay","Position, Inertia, Damping"] },
{ q:"stable system's response到bounded input是?", correct:"Bounded", wrong:["Always unbounded","Always oscillatory"] },
{ q:"Aliasing happens何时sampling是?", correct:"Too slow", wrong:["Too fast","At DC"] },
{ q:"Bode plot shows magnitude/phase vs?", correct:"Frequency", wrong:["Time","Temperature"] },

{ q:"在piping, cavitation occurs何时pressure falls below?", correct:"Vapor pressure", wrong:["Atmospheric pressure","Critical pressure ratio"] },
{ q:"Pump ‘head'是measure的?", correct:"Energy per unit weight", wrong:["Mass flow rate","Viscosity"] },
{ q:"Hydraulic power是proportional到?", correct:"Pressure × flow", wrong:["Flow ÷ pressure","Density × voltage"] },
{ q:"Laminar flow在pipe通常有?", correct:"Parabolic velocity profile", wrong:["Flat profile","Random shocks"] },
{ q:"Turbulent flow increases?", correct:"Mixing and friction losses", wrong:["Only density","Only temperature"] },
{ q:"Darcy-Weisbach equation estimates?", correct:"Pipe pressure loss", wrong:["Heat capacity","Lift coefficient"] },
{ q:"diffuser converts velocity into?", correct:"Pressure", wrong:["Heat","Mass"] },
{ q:"Lift在airfoil是主要来自pressure difference due到?", correct:"Circulation/flow field", wrong:["Weight reduction","Only viscosity"] },
{ q:"Drag coefficient是dimensionless ratio的?", correct:"Drag to dynamic pressure area", wrong:["Lift to drag","Mass to volume"] },
{ q:"Boundary layer separation tends到increase?", correct:"Pressure drag", wrong:["Buoyancy","Conductivity"] },

{ q:"Weld porosity是经常caused按?", correct:"Contamination or shielding failure", wrong:["Too much clamping","Low voltage only"] },
{ q:"Heat-affected zone (HAZ)是?", correct:"Region altered by welding heat", wrong:["Unmelted filler only","Base metal unchanged"] },
{ q:"Brazing differs来自welding because base metal?", correct:"Does not melt", wrong:["Always melts fully","Is cast only"] },
{ q:"Soldering通常occurs below?", correct:"450°C", wrong:["1000°C","1500°C"] },
{ q:"Tolerance stack-up refers到?", correct:"Accumulated dimensional variation", wrong:["Metal fatigue","Thermal shock"] },
{ q:"GD&T datum是?", correct:"Reference feature", wrong:["Surface finish","Material grade"] },
{ q:"Surface roughness Ra measures?", correct:"Average profile deviation", wrong:["Hardness","Thickness"] },
{ q:"key cause的shaft misalignment vibration?", correct:"Angular or parallel offset", wrong:["Low paint gloss","High humidity"] },
{ q:"Bearing ‘lubrication regime' that separates surfaces fully?", correct:"Hydrodynamic", wrong:["Boundary","Dry friction"] },
{ q:"Gear backlash是?", correct:"Clearance between mating teeth", wrong:["Tooth hardness","Pitch diameter"] },

{ q:"Thermal expansion是ΔL proportional到?", correct:"α·L·ΔT", wrong:["L/ΔT","α·ΔT/L"] },
{ q:"Heat capacity在constant pressure是?", correct:"Cp", wrong:["Cv only","k"] },
{ q:"Ideal气体law是?", correct:"PV = nRT", wrong:["P = ρg","V = IR"] },
{ q:"Isentropic process有constant?", correct:"Entropy", wrong:["Enthalpy","Volume"] },
{ q:"Enthalpy是?", correct:"Internal energy + pV", wrong:["Entropy × temperature","Pressure ÷ volume"] },
{ q:"Heat exchanger effectiveness relates actual heat transfer到?", correct:"Maximum possible", wrong:["Minimum possible","Zero heat flow"] },
{ q:"COP的refrigerator是?", correct:"Qcold / Winput", wrong:["Winput / Qcold","Qhot / Qcold"] },
{ q:"Rankine cycle是associated与?", correct:"Steam power plants", wrong:["Jet engines","Refrigerators only"] },
{ q:"Brayton cycle是associated与?", correct:"Gas turbines", wrong:["Boilers","Hydraulic rams"] },
{ q:"nozzle主要converts pressure into?", correct:"Velocity", wrong:["Temperature","Mass"] },
{ q:"在chess, castling是illegal if king?", correct:"Would pass through check", wrong:["Has moved a rook","Is on a dark square"] },
{ q:"在chess, en passant capture must be made?", correct:"Immediately on the next move", wrong:["Any time later","Only in endgames"] },
{ q:"在chess notation, 'O-O-O'是什么意思?", correct:"Queenside castling", wrong:["Kingside castling","Promote to queen"] },
{ q:"在chess, 'skewer'是attack哪里?", correct:"A valuable piece is forced to move exposing another", wrong:["Two pieces are attacked at once","A piece is pinned to the king"] },
{ q:"在chess, 'back rank mate' usually exploits?", correct:"Blocked escape squares for the king", wrong:["A trapped queen","A discovered check"] },
{ q:"在Go, capturing stone requires?", correct:"Removing all its liberties", wrong:["Surrounding with 8 stones","Playing on star points only"] },
{ q:"在Go, ko rule prevents?", correct:"Immediate repetition of the prior board state", wrong:["Captures on edges","Playing in corners"] },
{ q:"在Go, komi是?", correct:"Points added to White to offset first move", wrong:["A handicap stone","A capture bonus"] },
{ q:"在Go scoring, territory是主要?", correct:"Empty points surrounded by one color", wrong:["Total stones placed","Only captured stones"] },
{ q:"在Go, 'sente'是什么意思?", correct:"Having the initiative", wrong:["A corner enclosure","A dead group"] },

{ q:"在backgammon, 'gammon' wins按?", correct:"Opponent has borne off none", wrong:["Winning by 1 point","Capturing all checkers"] },
{ q:"在backgammon, 'backgammon' requires?", correct:"Opponent has borne off none and has a checker in your home/bar", wrong:["Doubles rolled twice","All checkers on the bar"] },
{ q:"在backgammon, blot是?", correct:"A point occupied by a single checker", wrong:["A blocked point with 2+ checkers","A prime of 6 points"] },
{ q:"在backgammon, you enter来自bar into?", correct:"Opponent’s home board", wrong:["Your home board","Any open point"] },
{ q:"在backgammon, 'prime'是?", correct:"Consecutive blocked points", wrong:["Any double roll","A single checker run"] },

{ q:"在Scrabble, blank tiles是worth?", correct:"0 points", wrong:["5 points","10 points"] },
{ q:"在Scrabble, 'bingo'是?", correct:"Using all 7 tiles in one play", wrong:["Playing on a triple word", "Forming two words at once"] },
{ q:"在Scrabble, premium squares apply到?", correct:"Only tiles placed that turn", wrong:["Any tiles already there","Only vowels"] },
{ q:"在Scrabble, hooks是letters added到?", correct:"Extend an existing word", wrong:["Replace a letter","Cancel scoring"] },
{ q:"在Scrabble, cross-checks refer到?", correct:"Letters allowed by perpendicular words", wrong:["Double letter scores","Invalid word challenges"] },

{ q:"在Catan, robber是moved何时?", correct:"A 7 is rolled (or a knight is played)", wrong:["A 6 is rolled","A player has 10 points"] },
{ q:"在Catan, 最长的Road是lost何时?", correct:"Another player builds a longer continuous road", wrong:["You build a city","You roll a 7"] },
{ q:"在Catan, ports通常improve trade到?", correct:"2:1 or 3:1 ratios", wrong:["1:1 ratios always","5:1 ratios only"] },
{ q:"在Catan, development cards can be played?", correct:"Not on the turn they’re bought", wrong:["Immediately always","Only after building a city"] },
{ q:"在Catan, 'desert' produces?", correct:"No resources", wrong:["Any resource you choose","Only sheep"] },

{ q:"在Risk, you must capture territories到?", correct:"Get a card at end of turn", wrong:["Move armies twice","Draft extra dice"] },
{ q:"在Risk, trading sets的cards gives?", correct:"Reinforcements", wrong:["Extra attacks","Free continents"] },
{ q:"在Risk, occupying大陆grants?", correct:"A reinforcement bonus", wrong:["Immediate victory","A wildcard card"] },
{ q:"在Risk, attack dice是limited按?", correct:"Armies in the attacking territory", wrong:["Total armies on board","Cards held"] },
{ q:"在Risk, defender rolls在most?", correct:"2 dice", wrong:["3 dice","4 dice"] },

{ q:"在Ticket到Ride, 最长的route bonus是为?", correct:"Longest continuous path", wrong:["Most tickets completed","Most trains left"] },
{ q:"在Ticket到Ride, you can claim route if?", correct:"You have enough matching cards (or wilds)", wrong:["You have the ticket only","You roll highest"] },
{ q:"在Ticket到Ride, grey routes require?", correct:"Any single color set", wrong:["Two different colors","Only wilds"] },
{ q:"在Ticket到Ride, failing tickets是?", correct:"Subtracted from score", wrong:["Ignored","Converted to 0"] },
{ q:"在Ticket到Ride, drawing cards allows?", correct:"2 cards (1 if you take a face-up locomotive)", wrong:["3 cards always","1 card only"] },

{ q:"在Carcassonne, meeple placed在road是?", correct:"Thief", wrong:["Knight","Monk"] },
{ q:"在Carcassonne, cities是scored何时?", correct:"Completed/closed", wrong:["Immediately on placement","Only at game end"] },
{ q:"在Carcassonne, farms score在?", correct:"Game end", wrong:["When completed","Each time a city closes"] },
{ q:"在Carcassonne, cloister scores何时?", correct:"Surrounded by 8 tiles", wrong:["Connected to a road","It touches a city"] },
{ q:"在Carcassonne, you can place meeple仅if?", correct:"No meeple is already in that feature", wrong:["You have 2 meeples left","The feature is incomplete"] },

{ q:"在Dominion, default hand size是?", correct:"5 cards", wrong:["6 cards","7 cards"] },
{ q:"在Dominion, victory cards主要?", correct:"Provide points, clogging your deck", wrong:["Give actions","Give coins"] },
{ q:"在Dominion, 'trashing'是什么意思?", correct:"Removing cards from your deck", wrong:["Discarding to the pile","Shuffling discard into deck"] },
{ q:"在Dominion, you normally get多少buys per变?", correct:"1 buy", wrong:["2 buys","Unlimited buys"] },
{ q:"在Dominion, 'Action' card是played在哪个phase?", correct:"Action phase", wrong:["Buy phase only","Cleanup phase"] },

{ q:"在Pandemic, game是won按?", correct:"Curing 4 diseases", wrong:["Eradicating 1 disease","Surviving 10 rounds"] },
{ q:"在Pandemic, outbreaks chain何时?", correct:"A city would get a 4th cube", wrong:["You cure a disease","You draw 2 epidemics"] },
{ q:"在Pandemic, epidemic increases?", correct:"Infection rate and intensifies infections", wrong:["Hand limit","Number of roles"] },
{ q:"在Pandemic, you can remove cubes faster if?", correct:"The disease is cured", wrong:["You have 2 cards","You are Dispatcher"] },
{ q:"在Pandemic, you lose if player deck?", correct:"Runs out", wrong:["Has 5 cards left","Is reshuffled twice"] },

{ q:"在Azul, penalties come来自tiles?", correct:"Placed on the floor line", wrong:["Placed in the center","Taken from factories"] },
{ q:"在Azul, you must place tiles在row if?", correct:"The color matches and row is empty", wrong:["Any color always","It has at least 1 tile"] },
{ q:"在Azul, you score tile按?", correct:"Adjacency in row/column (plus itself)", wrong:["Only its row length","Only its column length"] },
{ q:"在Azul, 第一个player marker causes?", correct:"A penalty point and first next round", wrong:["Bonus points","Extra factory"] },
{ q:"在Azul, you cannot place color在row if?", correct:"That color already exists in the corresponding wall row", wrong:["You have fewer than 3 tiles","It came from the center"] },

{ q:"在Terraforming Mars, TR主要increases?", correct:"Income and endgame points", wrong:["Only steel production","Only hand size"] },
{ q:"在Terraforming Mars, oxygen, temperature, oceans是?", correct:"Global parameters", wrong:["Corporation traits","Milestones"] },
{ q:"在Terraforming Mars, placing海洋gives?", correct:"2 TR (via parameters?)", wrong:["2 cards","2 titanium"] },
{ q:"在Terraforming Mars, standard projects是?", correct:"Always available actions with fixed costs", wrong:["One-time events only","Free when TR is 20"] },
{ q:"在Terraforming Mars, blue cards是通常?", correct:"Active effects", wrong:["Events only","Corporations only"] },

{ q:"在7 Wonders, you draft按passing cards?", correct:"Left, then right, then left", wrong:["Always left","Random each age"] },
{ q:"在7 Wonders, military conflicts score何时?", correct:"At end of each age", wrong:["Each time you build red","Only at game end"] },
{ q:"在7 Wonders, science sets score按?", correct:"Squares + set bonuses", wrong:["Linear addition only","Counting coins"] },
{ q:"在7 Wonders, you can建造stage的wonder按?", correct:"Paying its cost with resources/coins", wrong:["Discarding 2 cards","Winning a conflict"] },
{ q:"在7 Wonders, you may play card按?", correct:"Build, build wonder, or discard for coins", wrong:["Trade only","Steal from neighbor"] },

{ q:"在Magic: Gathering, summoning sickness prevents?", correct:"Attacking and tapping for abilities", wrong:["Blocking","Casting spells"] },
{ q:"在MTG, 'stack' resolves?", correct:"Last in, first out", wrong:["First in, first out","Random order"] },
{ q:"在MTG, 'trample' allows damage到?", correct:"Carry over to player after lethal to blocker", wrong:["Ignore blockers entirely","Hit all creatures"] },
{ q:"在MTG, 'legend rule'是什么意思?", correct:"Only one of the same legendary per player", wrong:["Legends are indestructible","Legends cost double"] },
{ q:"在MTG, 'mana curve' refers到?", correct:"Distribution of spell costs", wrong:["Land types ratio","Combat math"] },

{ q:"在Warhammer (wargames), 'line的sight' determines?", correct:"Whether a model can target another", wrong:["Initiative order","Morale check"] },
{ q:"在多少minis games, 'WYSIWYG'是什么意思?", correct:"Model gear matches rules loadout", wrong:["Roll twice take highest","Your turn never ends"] },
{ q:"在多少tabletop skirmish games, activation是经常?", correct:"Alternating unit activations", wrong:["One player moves all forever","Only random dice"] },
{ q:"在hex-and-counter wargames, 'ZOC'是什么意思?", correct:"Zone of Control", wrong:["Zero Order Cost","Zonal Objective Card"] },
{ q:"在多少wargames, 'CRT' 代表什么?", correct:"Combat Results Table", wrong:["Critical Roll Timing","Card Response Trigger"] },

{ q:"在UNO, playing Wild Draw Four是legal仅if?", correct:"You have no card matching the current color", wrong:["You have any wild","Opponent has 1 card"] },
{ q:"在UNO, you must say 'UNO' 何时?", correct:"You have 1 card left after playing", wrong:["You draw a wild","You skip someone"] },
{ q:"在UNO, reverse acts为什么在2-player?", correct:"A skip", wrong:["A draw two","A wild"] },
{ q:"在Resistance/Avalon, vote是在?", correct:"Whether the team goes on the mission", wrong:["Who is Merlin","Who is assassin"] },
{ q:"在Secret Hitler, Hitler是revealed何时?", correct:"Elected Chancellor", wrong:["First fascist policy passes","Liberals pass 3 policies"] },

{ q:"在Clue/Cluedo, you win按?", correct:"Correct accusation of suspect/weapon/room", wrong:["Most suggestions","Collecting all rooms"] },
{ q:"在Clue/Cluedo, suggestion是made在哪?", correct:"The room your pawn is in", wrong:["Any room anytime","Only at start"] },
{ q:"在Monopoly, mortgaged property can collect rent?", correct:"No", wrong:["Yes always","Only from railroads"] },
{ q:"在Monopoly, houses must be built?", correct:"Evenly across a color set", wrong:["All on one property","Only on utilities"] },
{ q:"在Monopoly, 'Free Parking' money是?", correct:"House rule only", wrong:["Official jackpot","Official tax refund"] },

{ q:"在chess, stalemate results在哪?", correct:"A draw", wrong:["Win for player to move","Loss for player with no moves"] },
{ q:"在chess, threefold repetition allows?", correct:"A draw claim", wrong:["Forced checkmate","Extra time"] },
{ q:"在Go, 'seki'是?", correct:"Mutual life", wrong:["A sacrifice move","A ladder"] },
{ q:"在Go, 'ladder'是?", correct:"Chasing capture pattern", wrong:["Corner framework","Endgame counting"] },
{ q:"在backgammon, bearing off starts何时?", correct:"All checkers are in your home board", wrong:["You hit a blot","You roll doubles"] },

{ q:"在Bridge, partnership有?", correct:"Two players", wrong:["Three players","Four players"] },
{ q:"在Bridge, trick是won按?", correct:"Highest card of led suit or trump", wrong:["Highest rank always","Lowest trump"] },
{ q:"在Bridge, 'NT'是什么意思?", correct:"No Trump", wrong:["New Trick","North Team"] },
{ q:"在Hearts, goal是到?", correct:"Avoid points", wrong:["Collect hearts","Win most tricks"] },
{ q:"在Spades, goal是到?", correct:"Meet your bid in tricks", wrong:["Avoid all tricks","Collect only spades"] },
{ q:"在*Avatar: Last Airbender*, 什么是name的Aang's original sky bison?", correct:"Appa", wrong:["Momo","Naga"] },
{ q:"在*Avatar: Last Airbender*, 什么是name的Aang's lemur companion?", correct:"Momo", wrong:["Appa","Pabu"] },
{ q:"在*Avatar: Last Airbender*, 哪个city是地球Kingdom首都?", correct:"Ba Sing Se", wrong:["Omashu","Zaofu"] },
{ q:"在*Avatar: Last Airbender*, 谁leads Kyoshi Warriors第一个seen在series?", correct:"Suki", wrong:["Ty Lee","Mai"] },
{ q:"在*Avatar: Last Airbender*, 什么是Iroh's nickname among some?", correct:"Dragon of the West", wrong:["Phoenix King","Blue Spirit"] },
{ q:"在*Adventure Time*, 什么是name的Finn's magical dog brother?", correct:"Jake", wrong:["BMO","Ice King"] },
{ q:"在*Adventure Time*, 什么kingdom Princess Bubblegum rule?", correct:"Candy Kingdom", wrong:["Ice Kingdom","Fire Kingdom"] },
{ q:"在*Adventure Time*, 什么是Ice King's real name?", correct:"Simon Petrikov", wrong:["Evergreen","Gunter"] },
{ q:"在*Adventure Time*, 哪个character是small, 现存game console?", correct:"BMO", wrong:["NEPTR","Shelby"] },
{ q:"在*Adventure Time*, 什么是name的Marceline's bass axe?", correct:"Axe Bass", wrong:["Night Bass","Demon Chord"] },
{ q:"在*Gravity Falls*, 什么是Dipper's real第一个name?", correct:"Mason", wrong:["Dipper","Stanley"] },
{ q:"在*Gravity Falls*, 什么是Mabel's pig named?", correct:"Waddles", wrong:["Puddles","Snuffles"] },
{ q:"在*Gravity Falls*, 谁是one-eyed dream demon?", correct:"Bill Cipher", wrong:["The Axolotl","Gideon Gleeful"] },
{ q:"在*Gravity Falls*, 什么是name的tourist trap哪里Pines work?", correct:"Mystery Shack", wrong:["Oddity Hut","Curiosity Cabin"] },
{ q:"在*Gravity Falls*, 哪个journal number Dipper第一个find?", correct:"Journal 3", wrong:["Journal 1","Journal 2"] },
{ q:"在*Steven Universe*, 什么gemstone是Garnet fusion的?", correct:"Ruby and Sapphire", wrong:["Pearl and Amethyst","Jasper and Lapis"] },
{ q:"在*Steven Universe*, 什么是name的Steven's hometown?", correct:"Beach City", wrong:["Ocean Town","Coast Bay"] },
{ q:"在*Steven Universe*, 哪个Gem是known为shapeshifting and whip weapon?", correct:"Amethyst", wrong:["Pearl","Peridot"] },
{ q:"在*Steven Universe*, 什么是Pearl's weapon?", correct:"Spear", wrong:["Hammer","Scythe"] },
{ q:"在*Steven Universe*, 什么是name的Steven's father?", correct:"Greg Universe", wrong:["Marty Universe","Andy Universe"] },
{ q:"在* Simpsons*, 什么是name的Simpsons' hometown?", correct:"Springfield", wrong:["Shelbyville","Ogdenville"] },
{ q:"在* Simpsons*, 什么是Homer's middle initial?", correct:"J", wrong:["D","B"] },
{ q:"在* Simpsons*, 什么是name的Mr. Burns' assistant?", correct:"Waylon Smithers", wrong:["Lenny Leonard","Carl Carlson"] },
{ q:"在* Simpsons*, 什么instrument Lisa play?", correct:"Saxophone", wrong:["Clarinet","Trumpet"] },
{ q:"在* Simpsons*, 什么是name的bar Homer frequents?", correct:"Moe’s Tavern", wrong:["The Rusty Anchor","Duff House"] },
{ q:"在*Futurama*, 什么是Fry's第一个name?", correct:"Philip", wrong:["Hubert","Zapp"] },
{ q:"在*Futurama*, 什么是Leela's full name?", correct:"Turanga Leela", wrong:["Leela Turanga","Leela Nibbler"] },
{ q:"在*Futurama*, 什么是Bender's full designation?", correct:"Bender Bending Rodríguez", wrong:["Bender Unit-9","Bender Steelson"] },
{ q:"在*Futurama*, 什么是行星Express ship's nickname?", correct:"The Planet Express Ship", wrong:["The Nimbus","The Starbug"] },
{ q:"在*Futurama*, 谁是elderly professor and founder的行星Express?", correct:"Professor Farnsworth", wrong:["Professor Frink","Professor X"] },
{ q:"在*Rick and Morty*, 什么是Morty's last name?", correct:"Smith", wrong:["Sanchez","Johnson"] },
{ q:"在*Rick and Morty*, 什么是Rick's last name?", correct:"Sanchez", wrong:["Smith","Wong"] },
{ q:"在*Rick and Morty*, 什么是name的family's father?", correct:"Jerry", wrong:["Summer","Beth"] },
{ q:"在*Rick and Morty*, 什么是name的family's mother?", correct:"Beth", wrong:["Diane","Tammy"] },
{ q:"在*Rick and Morty*, 哪个agency是经常shown opposing Rick?", correct:"Galactic Federation", wrong:["U.N.I.T.","S.H.I.E.L.D."] },
{ q:"在*Archer*, 什么是spy agency's name在early seasons?", correct:"ISIS", wrong:["MI6","CIA"] },
{ q:"在*Archer*, 什么是Archer's第一个name?", correct:"Sterling", wrong:["Cyril","Ray"] },
{ q:"在*Archer*, 什么是Malory Archer's relationship到Sterling?", correct:"Mother", wrong:["Aunt","Sister"] },
{ q:"在*Archer*, 什么是name的Archer's on-again off-again partner?", correct:"Lana Kane", wrong:["Pam Poovey","Cheryl Tunt"] },
{ q:"在*Archer*, 什么是Cyril Figgis' typical role?", correct:"Accountant/agent", wrong:["Pilot","Medic"] },
{ q:"在*Batman: Animated Series*, 谁voices Batman most famously?", correct:"Kevin Conroy", wrong:["Mark Hamill","Bruce Timm"] },
{ q:"在*Batman: Animated Series*, 谁voices Joker most famously?", correct:"Mark Hamill", wrong:["Kevin Conroy","Clancy Brown"] },
{ q:"在*Batman: Animated Series*, 什么是Harley Quinn's real第一个name?", correct:"Harleen", wrong:["Helena","Hazel"] },
{ q:"在*Justice League Unlimited*, 什么是name的Martian hero?", correct:"J'onn J'onzz", wrong:["Kara Zor-El","John Stewart"] },
{ q:"在*Justice League* (animated), 哪个Lantern是主要team member?", correct:"John Stewart", wrong:["Hal Jordan","Kyle Rayner"] },
{ q:"在*Teen Titans* (2003), 什么是Raven's father?", correct:"Trigon", wrong:["Darkseid","Slade"] },
{ q:"在*Teen Titans* (2003), 什么是Beast Boy's real name?", correct:"Garfield Logan", wrong:["Victor Stone","Dick Grayson"] },
{ q:"在*Teen Titans* (2003), 什么是Cyborg's real name?", correct:"Victor Stone", wrong:["Wally West","Roy Harper"] },
{ q:"在*Teen Titans* (2003), 谁是masked主要antagonist经常被称为?", correct:"Slade", wrong:["Bane","Riddler"] },
{ q:"在*Teen Titans* (2003), Starfire's home行星是?", correct:"Tamaran", wrong:["Krypton","Thanagar"] },
{ q:"在* Powerpuff Girls*, city they protect是?", correct:"Townsville", wrong:["Metro City","Springfield"] },
{ q:"在* Powerpuff Girls*, girls是created使用?", correct:"Chemical X", wrong:["Element X","Compound Z"] },
{ q:"在* Powerpuff Girls*, mayor's assistant/secretary是named?", correct:"Ms. Bellum", wrong:["Ms. Keane","Ms. Sara"] },
{ q:"在* Powerpuff Girls*, girls' creator是?", correct:"Professor Utonium", wrong:["Professor Farnsworth","Dr. Doofenshmirtz"] },
{ q:"在* Powerpuff Girls*, 主要villainous chimp是?", correct:"Mojo Jojo", wrong:["I.M. Weasel","Mr. Bobo"] },
{ q:"在*Samurai Jack*, Jack's主要enemy是?", correct:"Aku", wrong:["Oni","Ryuk"] },
{ q:"在*Dexter's Laboratory*, Dexter's sister是?", correct:"Dee Dee", wrong:["Darla","Didius"] },
{ q:"在*Courage Cowardly Dog*, elderly woman是?", correct:"Muriel", wrong:["Mabel","Martha"] },
{ q:"在*Courage Cowardly Dog*, grumpy farmer是?", correct:"Eustace", wrong:["Edgar","Ernest"] },
{ q:"在*Ed, Edd n Eddy*, 哪个character是also被称为?'Double D'?", correct:"Edd", wrong:["Ed","Eddy"] },
{ q:"在*Johnny Bravo*, Johnny's catchphrase includes?", correct:"‘Hoo-ha!’", wrong:["‘Wubba lubba dub-dub!’","‘Spoon!’"] },
{ q:"在* Grim Adventures的Billy & Mandy*, Grim是?", correct:"Grim Reaper", wrong:["Vampire","Werewolf"] },
{ q:"在*Foster's Home为Imaginary Friends*, founder是?", correct:"Madame Foster", wrong:["Mr. Herriman","Frankie Foster"] },
{ q:"在*Foster's Home为Imaginary Friends*, blue imaginary friend是?", correct:"Blooregard ‘Bloo’ Q. Kazoo", wrong:["Wilt","Eduardo"] },
{ q:"在*Chowder*, Chowder是apprentice到?", correct:"Mung Daal", wrong:["Shnitzel","Endive"] },
{ q:"在*Phineas and Ferb*, 谁是family pet?", correct:"Perry the Platypus", wrong:["Kenny the Koala","Rufus the Mole Rat"] },
{ q:"在*Phineas and Ferb*, villain's full name includes?", correct:"Dr. Heinz Doofenshmirtz", wrong:["Dr. Julius No","Dr. Victor Fries"] },
{ q:"在*Kim Possible*, Kim's best friend是?", correct:"Ron Stoppable", wrong:["Wade Load","Josh Mankey"] },
{ q:"在*Kim Possible*, Kim's主要villain是经常?", correct:"Shego", wrong:["Azula","Blackfire"] },
{ q:"在*SpongeBob SquarePants*, SpongeBob works在?", correct:"The Krusty Krab", wrong:["The Chum Bucket","The Salty Spitoon"] },
{ q:"在*SpongeBob SquarePants*, Mr. Krabs' 第一个name是?", correct:"Eugene", wrong:["Edward","Ernest"] },
{ q:"在*SpongeBob SquarePants*, Plankton's computer wife是?", correct:"Karen", wrong:["Janet","Darla"] },
{ q:"在*Fairly OddParents*, Timmy's fairy godparents是?", correct:"Cosmo and Wanda", wrong:["Chip and Dale","Phil and Lil"] },
{ q:"在*Fairly OddParents*, rulebook governing wishes是?", correct:"Da Rules", wrong:["The Code","Wish Law"] },
{ q:"在*Danny Phantom*, Danny's ghost name是?", correct:"Danny Phantom", wrong:["Dark Danny","Specter Kid"] },
{ q:"在*Ben 10* (classic), device that lets Ben transform是?", correct:"Omnitrix", wrong:["AllSpark","Chronosphere"] },
{ q:"在*Ben 10* (classic), Ben's cousin是?", correct:"Gwen", wrong:["Julie","Kai"] },
{ q:"在*Ben 10* (classic), Ben's grandpa是?", correct:"Max", wrong:["Frank","Phil"] },
{ q:"在*Scooby-Doo*, Scooby's full name是?", correct:"Scoobert Doo", wrong:["Scoobington Doo","Scoobyvan Doo"] },
{ q:"在*Scooby-Doo*, Shaggy's real第一个name是?", correct:"Norville", wrong:["Neville","Norman"] },
{ q:"在*Looney Tunes*, Marvin Martian是来自?", correct:"Mars", wrong:["Venus","Saturn"] },
{ q:"在*Looney Tunes*, Bugs Bunny's famous greeting begins与?", correct:"‘What’s up, doc?’", wrong:["‘Eh, what’s up?’","‘Hello, nurse!’"] },
{ q:"在*Tom and Jerry*, 什么kind的动物是Jerry?", correct:"Mouse", wrong:["Hamster","Squirrel"] },
{ q:"在*Pinky and Brain*, Pinky and Brain是?", correct:"Lab mice", wrong:["Hamsters","Rats"] },
{ q:"在*Animaniacs*, siblings是被称为?", correct:"Warner siblings", wrong:["Watterson siblings","Griffin siblings"] },
{ q:"在* Amazing World的Gumball*, Gumball's last name是?", correct:"Watterson", wrong:["Anderson","Patterson"] },
{ q:"在* Amazing World的Gumball*, Darwin是?", correct:"Goldfish", wrong:["Turtle","Rabbit"] },
{ q:"在*Regular Show*, blue jay protagonist是?", correct:"Mordecai", wrong:["Rigby","Benson"] },
{ q:"在*Regular Show*, Rigby是?", correct:"Raccoon", wrong:["Squirrel","Ferret"] },
{ q:"在*Regular Show*, Benson是?", correct:"Gumball machine", wrong:["Vending machine","Pachinko machine"] },
{ q:"在* Owl House*, 主要witch-in-training是?", correct:"Luz Noceda", wrong:["Amity Blight","Willow Park"] },
{ q:"在* Owl House*, tiny demon companion是?", correct:"King", wrong:["Hooty","Eda"] },
{ q:"在* Owl House*, Eda's nickname是?", correct:"The Owl Lady", wrong:["The Cat Witch","The Raven Queen"] },
{ q:"在*Amphibia*, human protagonist是?", correct:"Anne Boonchuy", wrong:["Star Butterfly","Luz Noceda"] },
{ q:"在*Star vs. Forces的Evil*, Star's last name是?", correct:"Butterfly", wrong:["Starling","Moon"] },
{ q:"在*Over Garden Wall*, two brothers是named?", correct:"Wirt and Greg", wrong:["Finn and Jake","Dipper and Mabel"] },
{ q:"在*Over Garden Wall*, bluebird companion是?", correct:"Beatrice", wrong:["Lapis","Robin"] },
{ q:"在*BoJack Horseman*, BoJack's species是?", correct:"Horse", wrong:["Dog","Donkey"] },
{ q:"在*BoJack Horseman*, BoJack's memoir ghostwriter是?", correct:"Diane Nguyen", wrong:["Princess Carolyn","Todd Chavez"] },
{ q:"在*South Park*, boy谁经常dies在early seasons是?", correct:"Kenny", wrong:["Kyle","Craig"] },
{ q:"什么year Formula One World Championship begin?", correct:"1950", wrong:["1946","1960"] },
{ q:"哪个flag indicates race是stopped immediately?", correct:"Red flag", wrong:["Black flag","Blue flag"] },
{ q:"DRS代表什么?", correct:"Drag Reduction System", wrong:["Downforce Recovery System","Dynamic Racing Stabilizer"] },
{ q:"什么是parc fermé在F1主要about?", correct:"Restricted car setup/changes after qualifying", wrong:["Mandatory fuel draining after the race","A tyre storage area only"] },
{ q:"多少points是awarded为Grand Prix win (modern system)?", correct:"25", wrong:["20","10"] },
{ q:"多少points是awarded为10th place (modern system)?", correct:"1", wrong:["2","0"] },
{ q:"什么是minimum number的tyre compounds driver must用途在dry race?", correct:"Two different compounds", wrong:["One compound","Three different compounds"] },
{ q:"什么是‘107% rule' applied到?", correct:"Qualifying participation threshold", wrong:["Maximum fuel flow","Pit lane speed limit"] },
{ q:"什么是主要purpose的Virtual Safety Car (VSC)?", correct:"Neutralize race with mandated delta without bunching the field", wrong:["Stop the race and restart from the grid","Allow DRS everywhere"] },
{ q:"哪个tyre marking color通常indicates最硬的dry compound?", correct:"White", wrong:["Yellow","Red"] },
{ q:"哪个circuit是traditionally shortest按lap length among common F1 venues?", correct:"Monaco", wrong:["Spa-Francorchamps","Suzuka"] },
{ q:"哪个circuit是famous为Eau Rouge/Raidillon?", correct:"Spa-Francorchamps", wrong:["Monza","Interlagos"] },
{ q:"哪个circuit是known为 ‘ Temple的Speed'?", correct:"Monza", wrong:["Silverstone","Bahrain"] },
{ q:"哪个track features ‘S' curves Maggots–Becketts–Chapel?", correct:"Silverstone", wrong:["Suzuka","Zandvoort"] },
{ q:"哪里是Interlagos located?", correct:"São Paulo", wrong:["Rio de Janeiro","Brasília"] },
{ q:"哪个circuit是located在Principality的Monaco?", correct:"Circuit de Monaco", wrong:["Circuit Paul Ricard","Circuit de la Sarthe"] },
{ q:"哪个circuit是known为 ‘Wall的Champions'?", correct:"Circuit Gilles Villeneuve", wrong:["Baku City Circuit","Singapore Street Circuit"] },
{ q:"哪个circuit uses ‘130R' corner name?", correct:"Suzuka", wrong:["Fuji","Sepang"] },
{ q:"哪个venue是most associated与‘ Corkscrew' (not在modern F1 calendar)?", correct:"Laguna Seca", wrong:["Watkins Glen","Road America"] },
{ q:"哪个是street circuit known为frequent Safety Cars and walls?", correct:"Singapore", wrong:["Monza","Red Bull Ring"] },
{ q:"哪个team是仅one到有competed在every F1 season since 1950?", correct:"Ferrari", wrong:["McLaren","Williams"] },
{ q:"哪个constructor是nicknamed ‘银Arrows' historically?", correct:"Mercedes", wrong:["Ferrari","Red Bull"] },
{ q:"哪个team won Constructors' Championship在2009与double diffuser-era car?", correct:"Brawn GP", wrong:["Renault","Toyota"] },
{ q:"什么是Renault's team name何时it won titles在2005–2006?", correct:"Renault F1 Team", wrong:["Benetton","Lotus F1 Team"] },
{ q:"哪个team introduced ‘F-duct'在2010?", correct:"McLaren", wrong:["Ferrari","Red Bull"] },
{ q:"哪个team是based在Maranello?", correct:"Ferrari", wrong:["AlphaTauri","Sauber"] },
{ q:"哪个team是based在Woking?", correct:"McLaren", wrong:["Williams","Mercedes"] },
{ q:"哪个team's base是traditionally associated与Milton Keynes?", correct:"Red Bull Racing", wrong:["Mercedes","Ferrari"] },
{ q:"哪个constructor name是strongly linked与Grove, Oxfordshire?", correct:"Williams", wrong:["Lotus","Minardi"] },
{ q:"哪个team originally entered F1为 ‘Stewart Grand Prix' (later renamed)?", correct:"Jaguar/Red Bull lineage", wrong:["Benetton/Renault lineage","Jordan/Force India lineage"] },
{ q:"多少cylinders modern F1 internal combustion engines有?", correct:"6", wrong:["8","10"] },
{ q:"Modern F1 engines是best described为?", correct:"1.6L turbocharged V6 hybrids", wrong:["2.4L naturally aspirated V8s","3.0L turbocharged V10s"] },
{ q:"哪个energy recovery unit是connected到turbocharger shaft (classic hybrid era)?", correct:"MGU-H", wrong:["MGU-K","KERS"] },
{ q:"哪个energy recovery unit是connected到drivetrain under braking?", correct:"MGU-K", wrong:["MGU-H","ERS-D"] },
{ q:"在simple terms, downforce是aerodynamic force pushing car?", correct:"Down onto the track", wrong:["Forward along the track","Up away from the track"] },
{ q:"Ground effect downforce主要comes来自?", correct:"Venturi tunnels/floor airflow management", wrong:["Rear wing only","Tyre deformation"] },
{ q:"什么是‘porpoising'在F1?", correct:"Aerodynamic oscillation causing bouncing at speed", wrong:["Excessive wheelspin on exits","Engine misfire under load"] },
{ q:"什么 ‘t-bar' (older-era terminology) relate到?", correct:"A structural mount/brace in chassis packaging", wrong:["A tyre heating device","A fuel flow limiter"] },
{ q:"‘halo'是主要?", correct:"Driver head protection device", wrong:["Fuel tank vent system","Rear wing support"] },
{ q:"在F1, ‘monocoque' refers到car's?", correct:"Single-shell safety chassis/tub", wrong:["Rear suspension layout","Front wing endplate"] },
{ q:"什么 ‘undercut' strategy usually mean?", correct:"Pitting earlier to gain time on fresh tyres", wrong:["Staying out longer to save tyres","Double-stacking both cars every stop"] },
{ q:"什么 ‘overcut' strategy usually mean?", correct:"Staying out longer to gain time/track position", wrong:["Pitting early to avoid traffic","Skipping mandatory tyre changes"] },
{ q:"什么是‘dirty air'在F1 most associated与?", correct:"Turbulent wake that reduces following car downforce", wrong:["Oil smoke from engines","Rain spray only"] },
{ q:"什么是主要tactical用途的Safety Car period为多少teams?", correct:"A cheaper pit stop time-loss and position gamble", wrong:["Allowing DRS activation immediately","Changing engine mapping freely"] },
{ q:"什么是‘double-stacking'在pit strategy?", correct:"Pitting both team cars one after the other same lap", wrong:["Doing two tyre changes in one stop","Using two different fuel blends"] },
{ q:"什么 ‘box' mean在team radio?", correct:"Pit this lap", wrong:["Retire immediately","Swap positions now"] },
{ q:"什么是通常biggest cause的tyre ‘graining'?", correct:"Rubber tearing and re-depositing due to sliding/low temps", wrong:["Excessive tyre pressure always","Overheating brakes only"] },
{ q:"什么是tyre ‘blistering' associated与?", correct:"Overheating causing bubbles under the tread surface", wrong:["Low tyre wear from careful driving","Waterlogged rubber in rain"] },
{ q:"什么是primary goal的‘cool-down lap' after qualifying?", correct:"Reduce temps and return to pit safely while managing fuel/temps", wrong:["Enable DRS for next lap","Trigger an automatic penalty reset"] },
{ q:"什么是slipstreaming主要used为?", correct:"Reducing drag to increase straight-line speed", wrong:["Increasing downforce in corners","Cooling tyres faster"] },
{ q:"哪个flag indicates faster car是approaching and you should allow it到pass (in-race)?", correct:"Blue flag", wrong:["Yellow flag","Green flag"] },
{ q:"什么single waved yellow flag mean?", correct:"Danger ahead, no overtaking, be prepared to slow", wrong:["Race stopped immediately","You must pit within one lap"] },
{ q:"什么double waved yellow flag indicate?", correct:"Be prepared to stop; serious hazard/obstruction ahead", wrong:["Track is clear and fast","DRS is enabled"] },
{ q:"什么green flag signal?", correct:"Track is clear / end of caution", wrong:["Mandatory pit stop window open","Last lap"] },
{ q:"什么black-and-white diagonal flag warn driver about?", correct:"Unsportsmanlike driving / track limits warning", wrong:["Immediate disqualification","Oil on track"] },
{ q:"什么orange/black flag (meatball) usually mean?", correct:"Car has a dangerous mechanical problem; pit now", wrong:["Driver penalty for speeding","Rain expected"] },
{ q:"什么black flag在F1 mean?", correct:"Disqualified; must return to pits", wrong:["Drive-through penalty","Safety Car deployed"] },
{ q:"什么是usual pit lane speed limit order的magnitude?", correct:"~80 km/h at many circuits (varies)", wrong:["~200 km/h at all circuits","~30 km/h at all circuits"] },
{ q:"什么是FIA Super Licence minimum points requirement (typical rule)?", correct:"40 points over 3 years", wrong:["25 points over 2 years","60 points in 1 year"] },
{ q:"哪个是*not* standard type的penalty?", correct:"Turbo penalty", wrong:["Drive-through","Time penalty"] },
{ q:"哪个driver是famously associated与nickname ‘ Professor'?", correct:"Alain Prost", wrong:["Nigel Mansell","Kimi Räikkönen"] },
{ q:"哪个driver是strongly associated与phrase ‘If you no longer go为gap...'?", correct:"Ayrton Senna", wrong:["Juan Manuel Fangio","Niki Lauda"] },
{ q:"哪个driver won championships与Benetton and Ferrari在modern era?", correct:"Michael Schumacher", wrong:["Sebastian Vettel","Fernando Alonso"] },
{ q:"哪个driver's 1976 comeback来自near-fatal crash是legendary?", correct:"Niki Lauda", wrong:["Gilles Villeneuve","Jochen Rindt"] },
{ q:"哪个driver是strongly linked与number 14在F1 history?", correct:"Fernando Alonso", wrong:["Ayrton Senna","Damon Hill"] },
{ q:"哪个driver是known为 ‘Iceman'?", correct:"Kimi Räikkönen", wrong:["Mika Häkkinen","Valtteri Bottas"] },
{ q:"哪个driver won 1992 title与Williams and活动suspension era dominance?", correct:"Nigel Mansell", wrong:["Alain Prost","Nelson Piquet"] },
{ q:"哪个driver won 1996 title driving为Williams?", correct:"Damon Hill", wrong:["Jacques Villeneuve","Mika Häkkinen"] },
{ q:"哪个driver是第一个 (and so far仅) champion来自Finland在2000s?", correct:"Kimi Räikkönen", wrong:["Keke Rosberg","Mika Häkkinen"] },
{ q:"哪个driver是most associated与Ferrari's第一个Drivers' title在1975?", correct:"Niki Lauda", wrong:["Jody Scheckter","Emerson Fittipaldi"] },
{ q:"什么是术语为最快的qualifying time (starting第一个)?", correct:"Pole position", wrong:["Fastest lap","Sprint pole"] },
{ q:"什么是‘pneumatic valve' tech most associated与在F1 engines?", correct:"Valve return using compressed air instead of springs", wrong:["Turbo spool using pressurized air","Tyre inflation during pit stops"] },
{ q:"什么 ‘ERS' stand为在modern F1 context?", correct:"Energy Recovery System", wrong:["Engine Rotation Stabilizer","Electronic Racing Suspension"] },
{ q:"什么是primary job的front wing endplates?", correct:"Manage airflow and vortices around front tyres", wrong:["Cool the brakes directly","Hold the nose cone to the chassis"] },
{ q:"哪个是common carbon-fibre brake material used在F1?", correct:"Carbon-carbon composite", wrong:["Cast iron","Ceramic tile"] },
{ q:"什么 ‘FP1' refer到在F1 weekend?", correct:"Free Practice 1", wrong:["First Pitstop","Final Phase 1"] },
{ q:"什么 ‘Q3' refer到?", correct:"Final qualifying segment for top runners", wrong:["Third sprint race","Third Safety Car phase"] },
{ q:"什么是purpose的‘weighbridge' procedure during sessions?", correct:"Random car weight checks for legality", wrong:["Measuring driver height","Checking tyre tread depth only"] },
{ q:"什么是‘scrutineering'?", correct:"Technical inspection for rule compliance", wrong:["National anthem ceremony","Track resurfacing process"] },
{ q:"什么是‘formation lap' 主要为?", correct:"Warming tyres/brakes and forming the grid order", wrong:["Allowing refuelling","Opening DRS zones"] },
{ q:"哪个infamous 2008 Singapore incident是known按什么nickname?", correct:"Crashgate", wrong:["Spygate","Dieselgate"] },
{ q:"什么是‘Spygate' (2007) 主要about?", correct:"Illegally obtained technical information between teams", wrong:["Fixing tyres with illegal chemicals","A manipulated start procedure"] },
{ q:"哪个safety innovation replaced refuelling-era pit lane fire risk most directly?", correct:"Ban on race refuelling (post-2009)", wrong:["Mandatory wet tyres every race","Shorter races"] },
{ q:"什么 ‘blue flag' 通常apply到most strongly?", correct:"Lapped traffic being shown a faster car approaching", wrong:["Start procedure failure","Mandatory tyre change"] },
{ q:"哪个是correct order的session progression (traditional weekend)?", correct:"Practice → Qualifying → Race", wrong:["Qualifying → Practice → Race","Race → Practice → Qualifying"] },
{ q:"什么是‘push-to-pass' 被称为在F1 (overtake aid)?", correct:"DRS", wrong:["KERS-only button","Nitro"] },
{ q:"哪个component是主要responsible为steering input transfer?", correct:"Steering rack/column", wrong:["Differential","MGU-H"] },
{ q:"什么是‘pit wall'在F1 terms?", correct:"Team’s trackside operations/strategy stand", wrong:["The concrete barrier at pit entry","A mandatory safety structure inside the garage"] },
{ q:"什么 ‘lift and coast' mean?", correct:"Lifting off throttle early and coasting to save fuel/temps", wrong:["Accelerating later to save tyres","Braking later to save pads"] },
{ q:"什么是主要purpose的‘engine modes'/maps (within rules)?", correct:"Adjust power deployment and efficiency/temps", wrong:["Change tyre compound hardness","Increase DRS angle beyond limits"] },
{ q:"哪个circuit是famous为 ‘ Senna S' (第一个corner complex)?", correct:"Interlagos", wrong:["Imola","Suzuka"] },
{ q:"哪个circuit includes ‘Piscine' section?", correct:"Monaco", wrong:["Barcelona","Hungaroring"] },
{ q:"哪个circuit是known为 ‘ Esses' and ‘Degner' corners?", correct:"Suzuka", wrong:["Silverstone","COTA"] },
{ q:"哪个circuit's layout historically included ‘Hockenheim forest' long straights?", correct:"Hockenheimring", wrong:["Nürburgring GP","Zolder"] },
{ q:"哪个circuit是commonly associated与‘ Hungaroring' being hard到overtake在?", correct:"Budapest venue (Hungaroring)", wrong:["Monza","Spa"] },
{ q:"哪个circuit是commonly known为 ‘COTA'?", correct:"Circuit of the Americas", wrong:["Circuit de Catalunya","Circuit of Australia"] },
{ q:"哪个circuit是在Netherlands known为steep banking在modern F1?", correct:"Zandvoort", wrong:["Assen","Zolder"] },
{ q:"哪个race是most associated与‘Triple Crown' 条腿在Monaco?", correct:"Monaco Grand Prix", wrong:["Italian Grand Prix","British Grand Prix"] },
{ q:"什么 ‘DNF' stand为在timing screens?", correct:"Did Not Finish", wrong:["Driver Not Found","Downforce Not Functioning"] },
{ q:"什么 ‘DNS' stand为在timing screens?", correct:"Did Not Start", wrong:["Driver Needs Service","Downshift Not Smooth"] },
{ q:"第一个modern Olympic Games (1896) host city?", correct:"Athens", wrong:["Paris","London"] },
{ q:"IOC founded在哪个year?", correct:"1894", wrong:["1886","1900"] },
{ q:"Founder most associated与modern Olympics?", correct:"Pierre de Coubertin", wrong:["Avery Brundage","Juan Antonio Samaranch"] },
{ q:"Olympic motto begins与哪个Latin word?", correct:"Citius", wrong:["Gloria","Virtus"] },
{ q:"Olympic rings第一个appeared在哪个Games?", correct:"1920 Antwerp", wrong:["1896 Athens","1908 London"] },
{ q:"多少rings是在Olympic的符号是什么?", correct:"5", wrong:["4","6"] },
{ q:"Olympic flame/torch relay introduced在哪个Games?", correct:"1936 Berlin", wrong:["1924 Paris","1948 London"] },
{ q:"第一个Winter Olympics host (1924)?", correct:"Chamonix", wrong:["St. Moritz","Oslo"] },
{ q:"哪个Games是cancelled due到World War I?", correct:"1916", wrong:["1912","1920"] },
{ q:"哪个Games是cancelled due到World War II (第一个)?", correct:"1940", wrong:["1936","1948"] },
{ q:"哪个Games是cancelled due到World War II (second)?", correct:"1944", wrong:["1940","1952"] },
{ q:"Marathon distance standardized到42.195 km after哪个Games?", correct:"1908 London", wrong:["1896 Athens","1924 Paris"] },
{ q:"第一个Olympics held在United States?", correct:"1904 St. Louis", wrong:["1932 Los Angeles","1984 Los Angeles"] },
{ q:"第一个Olympics held在亚洲 (Summer)?", correct:"1964 Tokyo", wrong:["1952 Helsinki","1972 Munich"] },
{ q:"仅city到host Summer Olympics three times?", correct:"London", wrong:["Paris","Los Angeles"] },
{ q:"国家that有participated在every modern Summer Olympics?", correct:"Greece", wrong:["USA","France"] },
{ q:"第一个year women competed在modern Olympics?", correct:"1900", wrong:["1896","1912"] },
{ q:"Olympic anthem composer?", correct:"Spyridon Samaras", wrong:["Giuseppe Verdi","Jean Sibelius"] },
{ q:"Olympic anthem lyrics written按?", correct:"Kostis Palamas", wrong:["Homer","Sappho"] },
{ q:"Olympic oath第一个used在哪个Games?", correct:"1920 Antwerp", wrong:["1900 Paris","1936 Berlin"] },
{ q:"哪个sport是NOT在modern pentathlon?", correct:"Cycling", wrong:["Fencing","Swimming"] },
{ q:"Modern pentathlon includes哪个equestrian discipline (traditional format)?", correct:"Show jumping", wrong:["Dressage","Cross-country"] },
{ q:"Decathlon includes哪个long run?", correct:"1500 m", wrong:["5000 m","800 m"] },
{ q:"Heptathlon includes哪个final event?", correct:"800 m", wrong:["1500 m","400 m"] },
{ q:"Sport that debuted在1998 Winter Olympics?", correct:"Snowboarding", wrong:["Biathlon","Bobsleigh"] },
{ q:"Beach volleyball第一个became Olympic sport在哪?", correct:"1996", wrong:["1992","2000"] },
{ q:"Triathlon debuted在哪个Summer Olympics?", correct:"2000 Sydney", wrong:["1996 Atlanta","2004 Athens"] },
{ q:"哪个是Olympic rowing boat class (historically common)?", correct:"Coxless four", wrong:["Dragon boat","Outrigger canoe"] },
{ q:"FIE governs Olympic哪个sport?", correct:"Fencing", wrong:["Archery","Judo"] },
{ q:"哪个是NOT track cycling discipline category?", correct:"Downhill", wrong:["Sprint","Keirin"] },
{ q:"哪个sport uses piste?", correct:"Fencing", wrong:["Badminton","Canoe slalom"] },
{ q:"在Olympic boxing, 什么RSC historically indicate?", correct:"Referee stops contest", wrong:["Ring side coach","Round score count"] },
{ q:"哪个国家won第一个modern Olympic marathon (1896) athlete nationality?", correct:"Greek", wrong:["French","American"] },
{ q:"Ancient Olympics是held在Olympia在honor的?", correct:"Zeus", wrong:["Apollo","Ares"] },
{ q:"Olympic rings是commonly said到represent?", correct:"The union of continents", wrong:["Five oceans","Five athletic virtues"] },
{ q:"哪个是NOT one的ring colors?", correct:"Purple", wrong:["Green","Black"] },
{ q:"Olympic flag background color?", correct:"White", wrong:["Blue","Gold"] },
{ q:"Traditional Olympic opening includes athletes marching按?", correct:"Nation", wrong:["Sport","Alphabetical by surname"] },
{ q:"哪个nation traditionally enters第一个在opening parade?", correct:"Greece", wrong:["Host nation","France"] },
{ q:"哪个nation traditionally enters last在opening parade?", correct:"Host nation", wrong:["Greece","IOC Refugee Team"] },
{ q:"Most Olympic黄金medals (all sports) athlete?", correct:"Michael Phelps", wrong:["Usain Bolt","Paavo Nurmi"] },
{ q:"Most total Olympic medals (all sports) athlete?", correct:"Michael Phelps", wrong:["Larisa Latynina","Mark Spitz"] },
{ q:"Soviet gymnast与18 Olympic medals (classic trivia)?", correct:"Larisa Latynina", wrong:["Nadia Comăneci","Svetlana Khorkina"] },
{ q:"仅athlete到win Olympic黄金在Summer and Winter (classic trivia)?", correct:"Eddie Eagan", wrong:["Eric Heiden","Clara Hughes"] },
{ q:"Jesse Owens won four黄金medals在哪个Olympics?", correct:"1936 Berlin", wrong:["1928 Amsterdam","1948 London"] },
{ q:"Nadia Comăneci's第一个perfect 10是在哪个Olympics?", correct:"1976 Montreal", wrong:["1972 Munich","1980 Moscow"] },
{ q:"Usain Bolt's signature triple (100/200/4x100) 第一个achieved在?", correct:"2008 Beijing", wrong:["2004 Athens","2016 Rio"] },
{ q:"Paavo Nurmi是most associated与哪个sport?", correct:"Athletics (distance)", wrong:["Wrestling","Rowing"] },
{ q:"第一个Olympic Games到feature mascot (widely cited)是?", correct:"1972 Munich", wrong:["1968 Mexico City","1980 Moscow"] },
{ q:"'Miracle on Ice' happened at 哪个 Winter Olympics?", correct:"1980 Lake Placid", wrong:["1976 Innsbruck","1984 Sarajevo"] },
{ q:"在Olympic swimming, 什么stroke order是used在medley relay?", correct:"Back-Breast-Fly-Free", wrong:["Fly-Back-Breast-Free","Breast-Back-Free-Fly"] },
{ q:"在decathlon, 哪个event是NOT included?", correct:"800 m", wrong:["Pole vault","Discus"] },
{ q:"在judo, ippon signifies?", correct:"Instant win", wrong:["Penalty only","Tie-break score"] },
{ q:"在Olympic taekwondo, contest area是被称为?", correct:"Octagon", wrong:["Dojo","Mat circle"] },
{ q:"在fencing, right-of-way applies到哪个weapons?", correct:"Foil and sabre", wrong:["Épée only","All three equally"] },
{ q:"Olympic shooting:是SF代表什么?", correct:"International Shooting Sport Federation", wrong:["International Sport Safety Federation","International Smallbore & Shot Federation"] },
{ q:"Canoe slalom是competed在?", correct:"Whitewater course", wrong:["Stillwater lake","Open ocean"] },
{ q:"在modern Olympic archery, standard target face有多少colored rings?", correct:"10 scoring rings", wrong:["5 scoring rings","12 scoring rings"] },
{ q:"在Olympic badminton, shuttle是also被称为?", correct:"Shuttlecock", wrong:["Birdie ball","Feather dart"] },
{ q:"Handball team size在court (indoor) per side?", correct:"7", wrong:["6","5"] },
{ q:"在volleyball, team是allowed多少touches before returning ball?", correct:"3", wrong:["2","4"] },
{ q:"在水polo, team fields多少players在pool?", correct:"7", wrong:["6","8"] },
{ q:"在Olympic football (soccer), men's tournament是主要?", correct:"U-23 with limited overage", wrong:["Open age like FIFA World Cup","U-19 only"] },
{ q:"在rugby sevens, match half是通常?", correct:"7 minutes", wrong:["10 minutes","15 minutes"] },
{ q:"在basketball, FIBA games是多少minutes total?", correct:"40", wrong:["48","36"] },
{ q:"在Olympic baseball/softball,?'mercy rule' refers to?", correct:"Ending game at large lead", wrong:["Extra innings","Free base on error"] },
{ q:"在equestrian,?'dressage' is best described as?", correct:"Horse training test of movements", wrong:["Jumping over fences only","Cross-country endurance"] },
{ q:"哪个是Winter Olympic sliding sport?", correct:"Skeleton", wrong:["Nordic combined","Ski jumping"] },
{ q:"Biathlon combines cross-国家skiing与?", correct:"Rifle shooting", wrong:["Archery","Pistol dueling"] },
{ q:"Curling teams通常有多少players?", correct:"4", wrong:["5","3"] },
{ q:"Figure skating:?'toe loop' is a type of?", correct:"Jump", wrong:["Spin","Step sequence"] },
{ q:"Alpine skiing: slalom vs大slalom differs主要在哪?", correct:"Gate spacing and turn radius", wrong:["Skis must be longer","Only slalom uses poles"] },
{ q:"在speed skating, races是在oval的?", correct:"400 m track", wrong:["200 m track","500 m track"] },
{ q:"在short track, overtaking rules是known到be?", correct:"More contact-prone/tactical", wrong:["No passing allowed","Only inside passes count"] },
{ q:"Nordic combined includes cross-国家skiing plus?", correct:"Ski jumping", wrong:["Alpine downhill","Freestyle moguls"] },
{ q:"Ski jumping hill size是经常labeled为?", correct:"K-point/HS", wrong:["MPH-index","Slope grade"] },
{ q:"Freestyle skiing?'moguls' course features?", correct:"Bumps and jumps", wrong:["Gates like slalom","Halfpipe walls"] },
{ q:"Snowboard?'halfpipe' is a?", correct:"U-shaped ramp", wrong:["Downhill gate course","Flat rail park"] },
{ q:"Cross-国家skiing sprint format经常uses?", correct:"Heats to final", wrong:["Single time trial only","Best-of-3 races"] },
{ q:"Ice hockey period length (international)是?", correct:"20 minutes", wrong:["15 minutes","25 minutes"] },
{ q:"2028 Summer Olympics host city?", correct:"Los Angeles", wrong:["Paris","Brisbane"] },
{ q:"2032 Summer Olympics host city?", correct:"Brisbane", wrong:["Rome","Berlin"] },
{ q:"2026 Winter Olympics是hosted在Italy按?", correct:"Milano-Cortina", wrong:["Turin-Genoa","Rome-Naples"] },
{ q:"Olympic motto是officially updated按adding哪个word?", correct:"Together", wrong:["Forever","Unity"] },
{ q:"motto?'Citius, Altius, Fortius' means?", correct:"Faster, Higher, Stronger", wrong:["Stronger, Braver, Bolder","Swifter, Safer, Smarter"] },
{ q:"Olympic Movement's top governing body是?", correct:"IOC", wrong:["FIFA","WADA"] },
{ q:"nation's Olympic body是被称为?", correct:"NOC", wrong:["NPC","NWC"] },
{ q:"Olympic?'A' standard/qualification generally refers to?", correct:"Eligibility entry requirement", wrong:["Gold medal score","Host city selection"] },
{ q:"'Olympiad' technically denotes a period of?", correct:"Four years", wrong:["One year","Two years"] },
{ q:"Summer Olympics是officially numbered按?", correct:"Olympiad", wrong:["Calendar year","Host city order"] },
{ q:"哪个city hosted 1968 Summer Olympics (high altitude)?", correct:"Mexico City", wrong:["Madrid","Lima"] },
{ q:"哪个city hosted 1972 Summer Olympics?", correct:"Munich", wrong:["Montreal","Moscow"] },
{ q:"哪个city hosted 1988 Summer Olympics?", correct:"Seoul", wrong:["Barcelona","Atlanta"] },
{ q:"哪个city hosted 1992 Summer Olympics?", correct:"Barcelona", wrong:["Sydney","Athens"] },
{ q:"哪个city hosted 2004 Summer Olympics?", correct:"Athens", wrong:["Beijing","London"] },
{ q:"哪个city hosted 2016 Summer Olympics?", correct:"Rio de Janeiro", wrong:["Tokyo","Beijing"] },
{ q:"Winter host city为1994 Olympics?", correct:"Lillehammer", wrong:["Nagano","Salt Lake City"] },
{ q:"Winter host city为2010 Olympics?", correct:"Vancouver", wrong:["Turin","Sochi"] },
{ q:"哪个Winter Olympics是held在Japan在1998?", correct:"Nagano", wrong:["Sapporo","Tokyo"] },
{ q:"哪个Winter Olympics是held在China在2022?", correct:"Beijing", wrong:["Harbin","Shanghai"] }

]; 
})();
(function ShowdownModule(){



const TEAM_T  = 2;   
const TEAM_CT = 3;   


const QUIZ_QUESTIONS_PER_ROUND = 7;


const QUIZ_ANSWER_TIME = 12.0; 


const QUIZ_GAP_BETWEEN = 5.0;  


const WT_Q     = "quiz_q";      
const WT_A     = "quiz_a";      
const WT_B     = "quiz_b";      
const WT_C     = "quiz_c";      
const WT_HSCORE= "quiz_hscore"; 
const WT_ZSCORE= "quiz_zscore"; 
const WT_STATUS= "quiz_status"; 


const QUIZ_DEBUG_OVERLAY = false;


const HUMAN_POINTS_PER_PLAYER  = 1; 
const ZOMBIE_POINTS_PER_PLAYER = 1; 

const mvpCorrect_CT = new Map();
const mvpCorrect_T  = new Map();


const QUESTION_BANK = [
  // --------- SPORT  ----------

  { id:"sport_001", topic:"sport",
  text:"哪个nation won第一个ever Olympic men's marathon在1896?",
  answers:["Greece","United States","France"],
  correct:0 },

{ id:"sport_002", topic:"sport",
  text:"哪个football club是第一个到win European Cup three times consecutively?",
  answers:["Real Madrid","Ajax","Benfica"],
  correct:0 },

{ id:"sport_003", topic:"sport",
  text:"在cricket, 哪个bowler delivered仅recorded ‘double hat-trick'在Test history?",
  answers:["Jimmy Matthews","Wasim Akram","Anil Kumble"],
  correct:0 },

{ id:"sport_004", topic:"sport",
  text:"哪个国家hosted inaugural Rugby World Cup在1987 alongside Australia?",
  answers:["New Zealand","England","South Africa"],
  correct:0 },

{ id:"sport_005", topic:"sport",
  text:"谁是仅athlete到win Olympic黄金medals在both decathlon and heptathlon?",
  answers:["Jackie Joyner-Kersee","Daley Thompson","Ashton Eaton"],
  correct:0 },

{ id:"sport_006", topic:"sport",
  text:"哪个Formula 1 driver holds record为most consecutive Grand Prix starts?",
  answers:["Lewis Hamilton","Rubens Barrichello","Fernando Alonso"],
  correct:2 },

{ id:"sport_007", topic:"sport",
  text:"哪个nation won第一个FIFA Women's World Cup在1991?",
  answers:["United States","Norway","China"],
  correct:0 },

{ id:"sport_008", topic:"sport",
  text:"‘Triple Crown'在horse racing refers到three races; 哪个的these是included?",
  answers:["Belmont Stakes","Melbourne Cup","Dubai World Cup"],
  correct:0 },

{ id:"sport_009", topic:"sport",
  text:"谁是第一个tennis player到win all four Grand Slams在single calendar year?",
  answers:["Don Budge","Rod Laver","Roy Emerson"],
  correct:0 },

{ id:"sport_010", topic:"sport",
  text:"哪个nation有won most Olympic weightlifting medals在history?",
  answers:["China","Soviet Union","Bulgaria"],
  correct:1 },

{ id:"sport_011", topic:"sport",
  text:"哪个golfer achieved ‘Tiger Slam', holding all four majors simultaneously?",
  answers:["Tiger Woods","Rory McIlroy","Jack Nicklaus"],
  correct:0 },

{ id:"sport_012", topic:"sport",
  text:"什么sport James Naismith invent在1891?",
  answers:["Basketball","Volleyball","Ice hockey"],
  correct:0 },

{ id:"sport_013", topic:"sport",
  text:"哪个city hosted第一个modern Olympic Games在1896?",
  answers:["Athens","Paris","Rome"],
  correct:0 },

{ id:"sport_014", topic:"sport",
  text:"谁是youngest ever Formula 1 Grand Prix winner?",
  answers:["Max Verstappen","Sebastian Vettel","Fernando Alonso"],
  correct:0 },

{ id:"sport_015", topic:"sport",
  text:"哪个国家有won most Davis Cup titles在tennis?",
  answers:["United States","Australia","Spain"],
  correct:0 },

{ id:"sport_016", topic:"sport",
  text:"谁是仅boxer到win world titles在eight weight divisions?",
  answers:["Manny Pacquiao","Floyd Mayweather Jr.","Oscar De La Hoya"],
  correct:0 },

{ id:"sport_017", topic:"sport",
  text:"哪个非洲nation第一个qualified为FIFA World Cup?",
  answers:["Egypt","Cameroon","Morocco"],
  correct:0 },

{ id:"sport_018", topic:"sport",
  text:"什么year Premier League replace English第一个Division?",
  answers:["1992","1988","1996"],
  correct:0 },

{ id:"sport_019", topic:"sport",
  text:"哪个nation won第一个ICC Cricket World Cup在1975?",
  answers:["West Indies","Australia","England"],
  correct:0 },

{ id:"sport_020", topic:"sport",
  text:"谁是第一个female gymnast到receive perfect 10在Olympics?",
  answers:["Nadia Comăneci","Larisa Latynina","Olga Korbut"],
  correct:0 },

{ id:"sport_021", topic:"sport",
  text:"哪个cyclist won Tour de France five times在1970s?",
  answers:["Eddy Merckx","Bernard Hinault","Miguel Induráin"],
  correct:0 },

{ id:"sport_022", topic:"sport",
  text:"谁是第一个footballer到score 1,000 career goals?",
  answers:["Pelé","Romário","Gerd Müller"],
  correct:0 },

{ id:"sport_023", topic:"sport",
  text:"哪个国家有most Winter Olympics黄金medals overall?",
  answers:["Norway","Russia","United States"],
  correct:0 },

{ id:"sport_024", topic:"sport",
  text:"什么year Michael Phelps win his record 8黄金medals?",
  answers:["2008","2004","2012"],
  correct:0 },

{ id:"sport_025", topic:"sport",
  text:"哪个baseball team有won most World Series titles?",
  answers:["New York Yankees","Boston Red Sox","Los Angeles Dodgers"],
  correct:0 },

{ id:"sport_026", topic:"sport",
  text:"谁是仅sprinter到win 100m, 200m, and 4x100m在three straight Olympics?",
  answers:["Usain Bolt","Carl Lewis","Justin Gatlin"],
  correct:0 },

{ id:"sport_027", topic:"sport",
  text:"哪个国家发明了table tennis?",
  answers:["England","China","Japan"],
  correct:0 },

{ id:"sport_028", topic:"sport",
  text:"哪个nation won第一个Rugby Sevens Olympic黄金?",
  answers:["Fiji","New Zealand","South Africa"],
  correct:0 },

{ id:"sport_029", topic:"sport",
  text:"谁是第一个woman到run marathon under 2:20:00?",
  answers:["Catherine Ndereba","Paula Radcliffe","Grete Waitz"],
  correct:1 },

{ id:"sport_030", topic:"sport",
  text:"在ice hockey, 哪个team won第一个Stanley Cup?",
  answers:["Montreal Hockey Club","Toronto Arenas","Quebec Bulldogs"],
  correct:0 },

{ id:"sport_031", topic:"sport",
  text:"什么year Muhammad Ali win his第一个heavyweight title?",
  answers:["1964","1970","1959"],
  correct:0 },

{ id:"sport_032", topic:"sport",
  text:"哪个国家有won most Olympic fencing medals?",
  answers:["Italy","France","Hungary"],
  correct:2 },

{ id:"sport_033", topic:"sport",
  text:"谁是仅driver到win Indy 500, Daytona 500, and Formula One championship?",
  answers:["Mario Andretti","Jim Clark","Juan Pablo Montoya"],
  correct:0 },

{ id:"sport_034", topic:"sport",
  text:"哪个national team有most Copa América titles?",
  answers:["Uruguay","Argentina","Brazil"],
  correct:0 },

{ id:"sport_035", topic:"sport",
  text:"谁是第一个athlete到exceed 9 meters在long jump (wind-assisted)?",
  answers:["Mike Powell","Carl Lewis","Bob Beamon"],
  correct:1 },

{ id:"sport_036", topic:"sport",
  text:"哪里是1950 FIFA World Cup finals hosted?",
  answers:["Brazil","Uruguay","Switzerland"],
  correct:0 },

{ id:"sport_037", topic:"sport",
  text:"哪个professional team sport第一个introduced shot clock在1954?",
  answers:["Basketball","Handball","Water polo"],
  correct:0 },

{ id:"sport_038", topic:"sport",
  text:"谁holds women's record为most tennis Grand Slam titles?",
  answers:["Margaret Court","Serena Williams","Steffi Graf"],
  correct:0 },

{ id:"sport_039", topic:"sport",
  text:"在boxing, 哪个fighter是known为 ‘ Bronx Bull'?",
  answers:["Jake LaMotta","Joe Frazier","Rocky Graziano"],
  correct:0 },

{ id:"sport_040", topic:"sport",
  text:"哪个国家won第一个official Cricket T20 World Cup在2007?",
  answers:["India","Pakistan","Australia"],
  correct:0 },

{ id:"sport_041", topic:"sport",
  text:"谁是第一个非洲footballer到win Ballon d'Or?",
  answers:["George Weah","Samuel Eto’o","Roger Milla"],
  correct:0 },

{ id:"sport_042", topic:"sport",
  text:"哪个tennis player completed Golden Slam (all four majors + Olympic黄金)在1988?",
  answers:["Steffi Graf","Martina Navratilova","Monica Seles"],
  correct:0 },

{ id:"sport_043", topic:"sport",
  text:"哪个国家发明了badminton?",
  answers:["India","England","Denmark"],
  correct:0 },

{ id:"sport_044", topic:"sport",
  text:"谁是第一个snooker player到complete ‘Triple Crown'在single season?",
  answers:["Steve Davis","Stephen Hendry","Mark Williams"],
  correct:0 },

{ id:"sport_045", topic:"sport",
  text:"哪个club won第一个UEFA Europa League (formerly UEFA Cup)在1972?",
  answers:["Tottenham Hotspur","Feyenoord","Borussia Mönchengladbach"],
  correct:0 },

{ id:"sport_046", topic:"sport",
  text:"谁是第一个MLB pitcher到throw 7 no-hitters?",
  answers:["Nolan Ryan","Sandy Koufax","Cy Young"],
  correct:0 },

{ id:"sport_047", topic:"sport",
  text:"哪个国家dominated early Olympic gymnastics, winning 9 golds在1904?",
  answers:["United States","Russia","Germany"],
  correct:0 },

{ id:"sport_048", topic:"sport",
  text:"什么year Open Era begin在tennis?",
  answers:["1968","1954","1975"],
  correct:0 },

{ id:"sport_049", topic:"sport",
  text:"哪个rugby team是known为haka?",
  answers:["New Zealand All Blacks","Samoa","Fiji"],
  correct:0 },

{ id:"sport_050", topic:"sport",
  text:"哪个race是known为 ‘ Most Exciting Two Minutes在Sports'?",
  answers:["Kentucky Derby","Belmont Stakes","Preakness Stakes"],
  correct:0 },

{ id:"sport_051", topic:"sport",
  text:"哪个athlete famously broke 4-minute mile?",
  answers:["Roger Bannister","Jim Ryun","Seb Coe"],
  correct:0 },

{ id:"sport_052", topic:"sport",
  text:"哪个国家dominated early Olympic weightlifting before WWII?",
  answers:["Austria","Germany","Egypt"],
  correct:2 },

{ id:"sport_053", topic:"sport",
  text:"谁won第一个ever UFC event在1993?",
  answers:["Royce Gracie","Ken Shamrock","Dan Severn"],
  correct:0 },

{ id:"sport_054", topic:"sport",
  text:"哪个nation won most medals在第一个Winter Olympics (1924)?",
  answers:["Norway","Finland","Switzerland"],
  correct:0 },

{ id:"sport_055", topic:"sport",
  text:"谁是youngest Ballon d'Or winner在history?",
  answers:["George Best","Lionel Messi","Ronaldo Nazário"],
  correct:0 },

{ id:"sport_056", topic:"sport",
  text:"哪个city hosted第一个Commonwealth Games在1930?",
  answers:["Hamilton","London","Sydney"],
  correct:0 },

{ id:"sport_057", topic:"sport",
  text:"哪个国家发明了curling?",
  answers:["Scotland","Canada","Sweden"],
  correct:0 },

{ id:"sport_058", topic:"sport",
  text:"谁是仅NFL team到complete perfect season including Super Bowl?",
  answers:["Miami Dolphins","New England Patriots","San Francisco 49ers"],
  correct:0 },

{ id:"sport_059", topic:"sport",
  text:"什么是oldest活动tennis tournament在world?",
  answers:["Wimbledon","US Open","Davis Cup"],
  correct:0 },

{ id:"sport_060", topic:"sport",
  text:"哪个cyclist是stripped的seven Tour de France titles为doping?",
  answers:["Lance Armstrong","Jan Ullrich","Marco Pantani"],
  correct:0 },

  // --------- HISTORY ----------

  { id:"hist_001", topic:"history",
  text:"哪个ancient civilization built city的Carthage?",
  answers:["Phoenicians","Romans","Egyptians"],
  correct:0 },

{ id:"hist_002", topic:"history",
  text:"谁是第一个emperor的unified China?",
  answers:["Qin Shi Huang","Liu Bang","Wudi"],
  correct:0 },

{ id:"hist_003", topic:"history",
  text:"Battle的Hastings在1066 resulted在Norman conquest的哪个在哪个国家?",
  answers:["England","France","Wales"],
  correct:0 },

{ id:"hist_004", topic:"history",
  text:"哪个empire是ruled按Abbasid Caliphate?",
  answers:["Islamic Empire","Byzantine Empire","Persian Empire"],
  correct:0 },

{ id:"hist_005", topic:"history",
  text:"谁发现了sea route到India around Cape的Good Hope?",
  answers:["Vasco da Gama","Ferdinand Magellan","Bartolomeu Dias"],
  correct:0 },

{ id:"hist_006", topic:"history",
  text:"哪个war是结束按Treaty的Westphalia在1648?",
  answers:["Thirty Years’ War","Hundred Years’ War","War of Spanish Succession"],
  correct:0 },

{ id:"hist_007", topic:"history",
  text:"哪个ancient people constructed ziggurats的Mesopotamia?",
  answers:["Sumerians","Babylonians","Assyrians"],
  correct:0 },

{ id:"hist_008", topic:"history",
  text:"谁led Haitian Revolution against French colonial rule?",
  answers:["Toussaint Louverture","Jean-Jacques Dessalines","Henri Christophe"],
  correct:0 },

{ id:"hist_009", topic:"history",
  text:"哪个empire Suleiman Magnificent rule?",
  answers:["Ottoman Empire","Mughal Empire","Safavid Empire"],
  correct:0 },

{ id:"hist_010", topic:"history",
  text:"哪个ancient battle saw 300 Spartans resist Persian forces?",
  answers:["Battle of Thermopylae","Battle of Marathon","Battle of Plataea"],
  correct:0 },

{ id:"hist_011", topic:"history",
  text:"谁是第一个Roman emperor?",
  answers:["Augustus","Julius Caesar","Nero"],
  correct:0 },

{ id:"hist_012", topic:"history",
  text:"哪个Chinese dynasty built most的长城为we know it today?",
  answers:["Ming Dynasty","Han Dynasty","Tang Dynasty"],
  correct:0 },

{ id:"hist_013", topic:"history",
  text:"哪个Viking explorer reached North美洲around 1000 AD?",
  answers:["Leif Erikson","Erik the Red","Harald Hardrada"],
  correct:0 },

{ id:"hist_014", topic:"history",
  text:"哪个pandemic killed estimated one-third的欧洲在14th century?",
  answers:["Black Death","Spanish Flu","Smallpox Pandemic"],
  correct:0 },

{ id:"hist_015", topic:"history",
  text:"哪个empire collapsed after Battle的Manzikert在1071?",
  answers:["Byzantine Empire","Abbasid Caliphate","Frankish Empire"],
  correct:0 },

{ id:"hist_016", topic:"history",
  text:"谁led Soviet Union during WWII?",
  answers:["Joseph Stalin","Nikita Khrushchev","Leon Trotsky"],
  correct:0 },

{ id:"hist_017", topic:"history",
  text:"谁是第一个Norman king的England?",
  answers:["William the Conqueror","Henry I","Richard I"],
  correct:0 },

{ id:"hist_018", topic:"history",
  text:"哪个empire built city的Persepolis?",
  answers:["Achaemenid Persian Empire","Assyrian Empire","Babylonian Empire"],
  correct:0 },

{ id:"hist_019", topic:"history",
  text:"哪个war是triggered按assassination的Archduke Franz Ferdinand?",
  answers:["World War I","World War II","Balkan Wars"],
  correct:0 },

{ id:"hist_020", topic:"history",
  text:"Rosetta Stone helped scholars decode哪个ancient writing system?",
  answers:["Egyptian hieroglyphs","Linear B","Cuneiform"],
  correct:0 },

{ id:"hist_021", topic:"history",
  text:"哪个naval battle在1805 cemented British dominance在sea?",
  answers:["Battle of Trafalgar","Battle of Jutland","Battle of the Nile"],
  correct:0 },

{ id:"hist_022", topic:"history",
  text:"哪个Mongol leader conquered最大的contiguous empire在history?",
  answers:["Genghis Khan","Kublai Khan","Tamerlane"],
  correct:0 },

{ id:"hist_023", topic:"history",
  text:"哪个city是首都的Aztec Empire?",
  answers:["Tenochtitlan","Cuzco","Teotihuacan"],
  correct:0 },

{ id:"hist_024", topic:"history",
  text:"谁写了 '95 Theses', sparking Protestant Reformation?",
  answers:["Martin Luther","John Calvin","Jan Hus"],
  correct:0 },

{ id:"hist_025", topic:"history",
  text:"哪个civilization built Machu Picchu?",
  answers:["Inca","Maya","Olmec"],
  correct:0 },

{ id:"hist_026", topic:"history",
  text:"哪个empire是ruled按Charlemagne?",
  answers:["Carolingian Empire","Holy Roman Empire","Byzantine Empire"],
  correct:0 },

{ id:"hist_027", topic:"history",
  text:"在哪个year Berlin Wall fall?",
  answers:["1989","1991","1987"],
  correct:0 },

{ id:"hist_028", topic:"history",
  text:"哪个queen ruled Egypt during Ptolemaic period?",
  answers:["Cleopatra VII","Hatshepsut","Nefertiti"],
  correct:0 },

{ id:"hist_029", topic:"history",
  text:"谁led Bolshevik红色Army during Russian Civil War?",
  answers:["Leon Trotsky","Joseph Stalin","Grigory Zinoviev"],
  correct:0 },

{ id:"hist_030", topic:"history",
  text:"哪个ancient city是destroyed按Mount Vesuvius在79 AD?",
  answers:["Pompeii","Alexandria","Carthage"],
  correct:0 },

{ id:"hist_031", topic:"history",
  text:"哪个battle marked Napoleon's final defeat?",
  answers:["Battle of Waterloo","Battle of Austerlitz","Battle of Leipzig"],
  correct:0 },

{ id:"hist_032", topic:"history",
  text:"哪个ancient Greek historian是被称为 ‘Father的History'?",
  answers:["Herodotus","Thucydides","Xenophon"],
  correct:0 },

{ id:"hist_033", topic:"history",
  text:"‘Trail的Tears' involved forced relocation的哪个原产于American tribe?",
  answers:["Cherokee","Apache","Iroquois"],
  correct:0 },

{ id:"hist_034", topic:"history",
  text:"哪个European explorer reached India按sailing around Africa?",
  answers:["Vasco da Gama","Christopher Columbus","John Cabot"],
  correct:0 },

{ id:"hist_035", topic:"history",
  text:"谁是第一个emperor的Holy Roman Empire?",
  answers:["Charlemagne","Otto I","Frederick Barbarossa"],
  correct:0 },

{ id:"hist_036", topic:"history",
  text:"什么conflict是结束按Treaty的Guadalupe Hidalgo?",
  answers:["Mexican-American War","Spanish-American War","Texas Revolution"],
  correct:0 },

{ id:"hist_037", topic:"history",
  text:"哪个civilization开发了第一个known writing system?",
  answers:["Sumerians","Phoenicians","Hittites"],
  correct:0 },

{ id:"hist_038", topic:"history",
  text:"谁became第一个Roman emperor after fall的Julius Caesar?",
  answers:["Augustus","Tiberius","Caligula"],
  correct:0 },

{ id:"hist_039", topic:"history",
  text:"哪个war Florence Nightingale famously nurse wounded soldiers?",
  answers:["Crimean War","Boer War","Napoleonic Wars"],
  correct:0 },

{ id:"hist_040", topic:"history",
  text:"哪个empire built Hagia Sophia during Justinian's reign?",
  answers:["Byzantine Empire","Ottoman Empire","Roman Empire"],
  correct:0 },

{ id:"hist_041", topic:"history",
  text:"哪个civilization created Code的Hammurabi?",
  answers:["Babylonians","Assyrians","Hittites"],
  correct:0 },

{ id:"hist_042", topic:"history",
  text:"谁unified Japan under Tokugawa shogunate?",
  answers:["Tokugawa Ieyasu","Oda Nobunaga","Toyotomi Hideyoshi"],
  correct:0 },

{ id:"hist_043", topic:"history",
  text:"什么year American Civil War begin?",
  answers:["1861","1857","1865"],
  correct:0 },

{ id:"hist_044", topic:"history",
  text:"哪个English document limited monarchy's power在1689?",
  answers:["Bill of Rights","Petition of Right","Act of Settlement"],
  correct:0 },

{ id:"hist_045", topic:"history",
  text:"谁创立了Mongol Empire?",
  answers:["Genghis Khan","Ögedei Khan","Tamerlane"],
  correct:0 },

{ id:"hist_046", topic:"history",
  text:"哪个ancient wonder stood在Alexandria?",
  answers:["Lighthouse of Alexandria","Hanging Gardens","Temple of Artemis"],
  correct:0 },

{ id:"hist_047", topic:"history",
  text:"哪个Chinese dynasty第一个used paper money widely?",
  answers:["Song Dynasty","Tang Dynasty","Han Dynasty"],
  correct:0 },

{ id:"hist_048", topic:"history",
  text:"谁是第一个president的Weimar Republic?",
  answers:["Friedrich Ebert","Paul von Hindenburg","Gustav Stresemann"],
  correct:0 },

{ id:"hist_049", topic:"history",
  text:"哪个kingdom built Angkor Wat?",
  answers:["Khmer Empire","Sukhothai Kingdom","Majapahit Empire"],
  correct:0 },

{ id:"hist_050", topic:"history",
  text:"哪个ancient city是home到Hanging Gardens?",
  answers:["Babylon","Nineveh","Ur"],
  correct:0 },

{ id:"hist_051", topic:"history",
  text:"谁是第一个pharaoh的unified Upper and Lower Egypt?",
  answers:["Narmer","Khufu","Thutmose III"],
  correct:0 },

{ id:"hist_052", topic:"history",
  text:"Reconquista结束在1492与fall的哪个city?",
  answers:["Granada","Seville","Cordoba"],
  correct:0 },

{ id:"hist_053", topic:"history",
  text:"哪个battle stopped Muslim advance into Western欧洲在732?",
  answers:["Battle of Tours","Battle of Poitiers","Battle of Manzikert"],
  correct:0 },

{ id:"hist_054", topic:"history",
  text:"谁ruled Soviet Union during Cuban Missile Crisis?",
  answers:["Nikita Khrushchev","Joseph Stalin","Leonid Brezhnev"],
  correct:0 },

{ id:"hist_055", topic:"history",
  text:"哪个empire Hernán Cortés overthrow?",
  answers:["Aztec Empire","Inca Empire","Maya Civilization"],
  correct:0 },

{ id:"hist_056", topic:"history",
  text:"Peloponnesian War是fought between Athens and哪个rival city-state?",
  answers:["Sparta","Corinth","Thebes"],
  correct:0 },

{ id:"hist_057", topic:"history",
  text:"哪个treaty结束American Revolutionary War?",
  answers:["Treaty of Paris (1783)","Treaty of Ghent","Jay Treaty"],
  correct:0 },

{ id:"hist_058", topic:"history",
  text:"哪个ancient civilization built city的Babylon?",
  answers:["Babylonians","Hittites","Persians"],
  correct:0 },

{ id:"hist_059", topic:"history",
  text:"谁succeeded Alexander Great为rulers的Egypt?",
  answers:["Ptolemy I and the Ptolemaic Dynasty","Seleucid Dynasty","Macedonian Regents"],
  correct:0 },

{ id:"hist_060", topic:"history",
  text:"哪个20th-century war included Battle的Somme?",
  answers:["World War I","World War II","Korean War"],
  correct:0 },

  // --------- GEOGRAPHY ----------
{ id:"geo_001", topic:"geography",
  text:"哪个河是最长的在亚洲?",
  answers:["Yangtze","Yellow River","Lena"],
  correct:0 },

{ id:"geo_002", topic:"geography",
  text:"什么是world's最大的non-polar沙漠?",
  answers:["Sahara","Australian Outback","Gobi"],
  correct:0 },

{ id:"geo_003", topic:"geography",
  text:"哪个山range forms天然的border between France and Spain?",
  answers:["Pyrenees","Alps","Apennines"],
  correct:0 },

{ id:"geo_004", topic:"geography",
  text:"哪个lake是最深的在world?",
  answers:["Lake Baikal","Lake Tanganyika","Caspian Sea"],
  correct:0 },

{ id:"geo_005", topic:"geography",
  text:"哪个国家contains world's highest waterfall?",
  answers:["Venezuela","Canada","Brazil"],
  correct:0 },

{ id:"geo_006", topic:"geography",
  text:"什么是最大的是陆地在Mediterranean Sea?",
  answers:["Sicily","Sardinia","Cyprus"],
  correct:0 },

{ id:"geo_007", topic:"geography",
  text:"哪个国家有most天然的lakes?",
  answers:["Canada","Russia","Finland"],
  correct:0 },

{ id:"geo_008", topic:"geography",
  text:"什么是world's最长的山range?",
  answers:["Andes","Rockies","Himalayas"],
  correct:0 },

{ id:"geo_009", topic:"geography",
  text:"哪个沙漠covers most的Mongolia and northern China?",
  answers:["Gobi","Taklamakan","Karakum"],
  correct:0 },

{ id:"geo_010", topic:"geography",
  text:"哪个河flows through Baghdad?",
  answers:["Tigris","Euphrates","Jordan"],
  correct:0 },

{ id:"geo_011", topic:"geography",
  text:"哪个国家有greatest number的活动volcanoes?",
  answers:["Indonesia","Japan","United States"],
  correct:0 },

{ id:"geo_012", topic:"geography",
  text:"什么是最小的国家在South美洲?",
  answers:["Suriname","Guyana","Uruguay"],
  correct:0 },

{ id:"geo_013", topic:"geography",
  text:"哪个非洲国家是completely surrounded按South Africa?",
  answers:["Lesotho","Eswatini","Botswana"],
  correct:0 },

{ id:"geo_014", topic:"geography",
  text:"哪个European首都city lies在河Danube?",
  answers:["Vienna","Warsaw","Prague"],
  correct:0 },

{ id:"geo_015", topic:"geography",
  text:"哪个国家owns Easter是陆地?",
  answers:["Chile","Peru","Ecuador"],
  correct:0 },

{ id:"geo_016", topic:"geography",
  text:"什么是最大的peninsula在world?",
  answers:["Arabian Peninsula","Iberian Peninsula","Kamchatka Peninsula"],
  correct:0 },

{ id:"geo_017", topic:"geography",
  text:"哪个sea separates Saudi Arabia来自Africa?",
  answers:["Red Sea","Arabian Sea","Mediterranean Sea"],
  correct:0 },

{ id:"geo_018", topic:"geography",
  text:"哪个国家有highest average elevation?",
  answers:["Bhutan","Nepal","Tajikistan"],
  correct:1 },

{ id:"geo_019", topic:"geography",
  text:"哪个nation是world's最大的archipelago?",
  answers:["Indonesia","Philippines","Japan"],
  correct:0 },

{ id:"geo_020", topic:"geography",
  text:"哪个非洲lake是source的White Nile?",
  answers:["Lake Victoria","Lake Albert","Lake Edward"],
  correct:0 },

{ id:"geo_021", topic:"geography",
  text:"哪个河forms part的border between Mexico and United States?",
  answers:["Rio Grande","Colorado River","Balsas"],
  correct:0 },

{ id:"geo_022", topic:"geography",
  text:"什么是world's highest首都city按elevation?",
  answers:["La Paz","Quito","Thimphu"],
  correct:0 },

{ id:"geo_023", topic:"geography",
  text:"哪个沙漠lies主要within Botswana?",
  answers:["Kalahari","Namib","Karoo"],
  correct:0 },

{ id:"geo_024", topic:"geography",
  text:"哪个山是highest peak在Africa?",
  answers:["Kilimanjaro","Mount Kenya","Ras Dashen"],
  correct:0 },

{ id:"geo_025", topic:"geography",
  text:"什么是最大的lake在Africa按volume?",
  answers:["Lake Tanganyika","Lake Victoria","Lake Malawi"],
  correct:0 },

{ id:"geo_026", topic:"geography",
  text:"哪个nation controls Falkland是lands?",
  answers:["United Kingdom","Argentina","France"],
  correct:0 },

{ id:"geo_027", topic:"geography",
  text:"哪个河runs through Paris?",
  answers:["Seine","Loire","Rhône"],
  correct:0 },

{ id:"geo_028", topic:"geography",
  text:"哪个沙漠是considered driest place在地球?",
  answers:["Atacama Desert","Sahara Desert","Mojave Desert"],
  correct:0 },

{ id:"geo_029", topic:"geography",
  text:"哪个山range includes Mount Everest?",
  answers:["Himalayas","Karakoram","Hindu Kush"],
  correct:0 },

{ id:"geo_030", topic:"geography",
  text:"什么是最大的国家entirely在欧洲按陆地area?",
  answers:["Ukraine","France","Spain"],
  correct:0 },

{ id:"geo_031", topic:"geography",
  text:"哪个海洋是最小的?",
  answers:["Arctic Ocean","Indian Ocean","Southern Ocean"],
  correct:0 },

{ id:"geo_032", topic:"geography",
  text:"哪个河是最长的在欧洲?",
  answers:["Volga","Danube","Dnieper"],
  correct:0 },

{ id:"geo_033", topic:"geography",
  text:"哪个国家owns是lands的Zanzibar?",
  answers:["Tanzania","Kenya","Madagascar"],
  correct:0 },

{ id:"geo_034", topic:"geography",
  text:"哪个大陆有most countries?",
  answers:["Africa","Europe","Asia"],
  correct:0 },

{ id:"geo_035", topic:"geography",
  text:"哪个山range separates欧洲来自亚洲?",
  answers:["Ural Mountains","Caucasus Mountains","Carpathians"],
  correct:0 },

{ id:"geo_036", topic:"geography",
  text:"哪个国家有most time zones?",
  answers:["France","Russia","United States"],
  correct:0 },

{ id:"geo_037", topic:"geography",
  text:"什么是world's最大的是陆地that是not大陆?",
  answers:["Greenland","New Guinea","Borneo"],
  correct:0 },

{ id:"geo_038", topic:"geography",
  text:"哪个国家河Tigris NOT flow through?",
  answers:["Syria","Iraq","Turkey"],
  correct:0 },

{ id:"geo_039", topic:"geography",
  text:"哪个非洲国家有its首都在Addis Ababa?",
  answers:["Ethiopia","Eritrea","Sudan"],
  correct:0 },

{ id:"geo_040", topic:"geography",
  text:"哪个sea有lowest天然的point在Earth's陆地surface?",
  answers:["Dead Sea","Caspian Sea","Aral Sea"],
  correct:0 },

{ id:"geo_041", topic:"geography",
  text:"哪个国家's flag是仅national flag that是not rectangular?",
  answers:["Nepal","Switzerland","Bhutan"],
  correct:0 },

{ id:"geo_042", topic:"geography",
  text:"哪个河flows through Grand Canyon?",
  answers:["Colorado River","Snake River","Columbia River"],
  correct:0 },

{ id:"geo_043", topic:"geography",
  text:"哪个国家有最长的coastline在world?",
  answers:["Canada","Australia","Indonesia"],
  correct:0 },

{ id:"geo_044", topic:"geography",
  text:"哪个European首都city是furthest north?",
  answers:["Reykjavik","Helsinki","Oslo"],
  correct:0 },

{ id:"geo_045", topic:"geography",
  text:"哪个plateau covers much的central Mexico?",
  answers:["Mexican Plateau","Yucatán Plateau","Altiplano"],
  correct:0 },

{ id:"geo_046", topic:"geography",
  text:"哪个国家是home到world's最大的cave system, Son Doong?",
  answers:["Vietnam","China","Laos"],
  correct:0 },

{ id:"geo_047", topic:"geography",
  text:"哪个河forms border between North Korea and China?",
  answers:["Yalu River","Amnok River","Tumen River"],
  correct:0 },

{ id:"geo_048", topic:"geography",
  text:"哪个海洋current warms Western Europe's climate?",
  answers:["Gulf Stream","Kuroshio Current","Benguela Current"],
  correct:0 },

{ id:"geo_049", topic:"geography",
  text:"哪个山range contains world's highest number的peaks above 8,000 meters?",
  answers:["Himalayas","Karakoram","Pamir"],
  correct:0 },

{ id:"geo_050", topic:"geography",
  text:"哪个沙漠stretches across northern China and southern Mongolia?",
  answers:["Gobi Desert","Taklamakan Desert","Ordos Desert"],
  correct:0 },

{ id:"geo_051", topic:"geography",
  text:"哪个strait separates Alaska来自Russia?",
  answers:["Bering Strait","Cook Strait","Davis Strait"],
  correct:0 },

{ id:"geo_052", topic:"geography",
  text:"哪个lake holds最大的volume的fresh水?",
  answers:["Lake Baikal","Lake Superior","Lake Tanganyika"],
  correct:0 },

{ id:"geo_053", topic:"geography",
  text:"哪个South American河是world's最大的按discharge?",
  answers:["Amazon River","Orinoco River","Paraná River"],
  correct:0 },

{ id:"geo_054", topic:"geography",
  text:"哪个沙漠occupies most的Namibia?",
  answers:["Namib Desert","Kalahari Desert","Karoo Desert"],
  correct:0 },

{ id:"geo_055", topic:"geography",
  text:"哪个archipelago includes是陆地的Tenerife?",
  answers:["Canary Islands","Azores","Balearic Islands"],
  correct:0 },

{ id:"geo_056", topic:"geography",
  text:"哪个河是最长的在South美洲?",
  answers:["Amazon","Paraguay","São Francisco"],
  correct:0 },

{ id:"geo_057", topic:"geography",
  text:"哪个国家有首都city Tbilisi?",
  answers:["Georgia","Armenia","Azerbaijan"],
  correct:0 },

{ id:"geo_058", topic:"geography",
  text:"哪个国家是completely landlocked?",
  answers:["Bolivia","Ecuador","Peru"],
  correct:0 },

{ id:"geo_059", topic:"geography",
  text:"哪个沙漠separates Tibet来自Tarim Basin?",
  answers:["Taklamakan Desert","Gobi Desert","Kyzylkum Desert"],
  correct:0 },

{ id:"geo_060", topic:"geography",
  text:"哪个sea是bordered按Jordan,是rael, and Palestine?",
  answers:["Dead Sea","Red Sea","Mediterranean Sea"],
  correct:0 },

  // --------- MOVIES ----------
{ id:"mov_001", topic:"movies",
  text:"哪个film won第一个Academy Award为Best Picture在1929?",
  answers:["Wings","The Racket","Sunrise"],
  correct:0 },

{ id:"mov_002", topic:"movies",
  text:"谁directed 1954 Japanese classic 'Seven Samurai'?",
  answers:["Akira Kurosawa","Yasujirō Ozu","Kenji Mizoguchi"],
  correct:0 },

{ id:"mov_003", topic:"movies",
  text:"哪个actor played character的T.E. Lawrence在'Lawrence的Arabia'?",
  answers:["Peter O'Toole","Alec Guinness","Richard Burton"],
  correct:0 },

{ id:"mov_004", topic:"movies",
  text:"哪个film是经常considered第一个full-length animated feature?",
  answers:["Snow White and the Seven Dwarfs","Gertie the Dinosaur","Fantasia"],
  correct:0 },

{ id:"mov_005", topic:"movies",
  text:"哪个director created influential sci-fi film 'Metropolis' (1927)?",
  answers:["Fritz Lang","F.W. Murnau","Robert Wiene"],
  correct:0 },

{ id:"mov_006", topic:"movies",
  text:"什么是name的spaceship在film 'Alien' (1979)?",
  answers:["Nostromo","Sulaco","Magellan"],
  correct:0 },

{ id:"mov_007", topic:"movies",
  text:"哪个国家produced film ' Battle的Algiers' (1966)?",
  answers:["Italy","France","Algeria"],
  correct:0 },

{ id:"mov_008", topic:"movies",
  text:"哪个actress won Oscar为her role在' Silence的Lambs'?",
  answers:["Jodie Foster","Sigourney Weaver","Holly Hunter"],
  correct:0 },

{ id:"mov_009", topic:"movies",
  text:"谁directed 2007 film 'No国家为Old Men'?",
  answers:["Coen Brothers","Denis Villeneuve","Clint Eastwood"],
  correct:0 },

{ id:"mov_010", topic:"movies",
  text:"哪个film introduced character Indiana Jones?",
  answers:["Raiders of the Lost Ark","Indiana Jones and the Temple of Doom","The Last Crusade"],
  correct:0 },

{ id:"mov_011", topic:"movies",
  text:"哪个film是famous为quote 'I drink your milkshake!'?",
  answers:["There Will Be Blood","Gangs of New York","No Country for Old Men"],
  correct:0 },

{ id:"mov_012", topic:"movies",
  text:"什么year是'Citizen Kane' released?",
  answers:["1941","1939","1943"],
  correct:0 },

{ id:"mov_013", topic:"movies",
  text:"谁played Travis Bickle在'Taxi Driver' (1976)?",
  answers:["Robert De Niro","Al Pacino","Dustin Hoffman"],
  correct:0 },

{ id:"mov_014", topic:"movies",
  text:"哪个film won第一个Palme d'Or在Cannes Film Festival?",
  answers:["The Third Man","Marty","Summer Interlude"],
  correct:0 },

{ id:"mov_015", topic:"movies",
  text:"哪个director是known为films 'Persona' and ' Seventh Seal'?",
  answers:["Ingmar Bergman","Andrei Tarkovsky","Carl Dreyer"],
  correct:0 },

{ id:"mov_016", topic:"movies",
  text:"哪个movie features line 'Here's looking在you, kid'?",
  answers:["Casablanca","Gone with the Wind","The Maltese Falcon"],
  correct:0 },

{ id:"mov_017", topic:"movies",
  text:"哪个1979 film features USS Cygnus and sentient robot named Maximilian?",
  answers:["The Black Hole","Silent Running","Dark Star"],
  correct:0 },

{ id:"mov_018", topic:"movies",
  text:"谁directed '2001: Space Odyssey'?",
  answers:["Stanley Kubrick","Arthur C. Clarke","Robert Wise"],
  correct:0 },

{ id:"mov_019", topic:"movies",
  text:"哪个actor portrays Vito Corleone在original ' Godfather'?",
  answers:["Marlon Brando","Robert De Niro","Al Pacino"],
  correct:0 },

{ id:"mov_020", topic:"movies",
  text:"哪个1958 thriller是经常cited为Alfred Hitchcock's masterpiece?",
  answers:["Vertigo","Rear Window","Psycho"],
  correct:0 },

{ id:"mov_021", topic:"movies",
  text:"哪个film marked debut的character James Bond?",
  answers:["Dr. No","From Russia with Love","Goldfinger"],
  correct:0 },

{ id:"mov_022", topic:"movies",
  text:"什么语言是主要spoken在film 'Pan's Labyrinth'?",
  answers:["Spanish","Italian","Portuguese"],
  correct:0 },

{ id:"mov_023", topic:"movies",
  text:"哪个film是famous为line 'You're gonna need bigger boat'?",
  answers:["Jaws","The Abyss","Deep Blue Sea"],
  correct:0 },

{ id:"mov_024", topic:"movies",
  text:"哪个director helmed 1971 dystopian film ' Clockwork Orange'?",
  answers:["Stanley Kubrick","Nicolas Roeg","Ken Russell"],
  correct:0 },

{ id:"mov_025", topic:"movies",
  text:"哪个Japanese film inspired ‘ Magnificent Seven'?",
  answers:["Seven Samurai","Rashomon","Yojimbo"],
  correct:0 },

{ id:"mov_026", topic:"movies",
  text:"什么是name的AI antagonist在'2001: Space Odyssey'?",
  answers:["HAL 9000","GERTY","VIKI"],
  correct:0 },

{ id:"mov_027", topic:"movies",
  text:"哪个actor portrayed Joker在' Dark Knight'?",
  answers:["Heath Ledger","Joaquin Phoenix","Jack Nicholson"],
  correct:0 },

{ id:"mov_028", topic:"movies",
  text:"哪个film Steven Spielberg win his第一个Best Director Oscar为?",
  answers:["Schindler’s List","Jaws","E.T."],
  correct:0 },

{ id:"mov_029", topic:"movies",
  text:"哪个1940 film featured Charlie Chaplin satirizing Adolf Hitler?",
  answers:["The Great Dictator","Modern Times","City Lights"],
  correct:0 },

{ id:"mov_030", topic:"movies",
  text:"谁directed Soviet sci-fi classic 'Stalker'?",
  answers:["Andrei Tarkovsky","Sergei Eisenstein","Dziga Vertov"],
  correct:0 },

{ id:"mov_031", topic:"movies",
  text:"哪个film features character Rick Deckard?",
  answers:["Blade Runner","The Running Man","Dark City"],
  correct:0 },

{ id:"mov_032", topic:"movies",
  text:"谁played Forrest Gump在1994 film?",
  answers:["Tom Hanks","Kevin Costner","Billy Bob Thornton"],
  correct:0 },

{ id:"mov_033", topic:"movies",
  text:"哪个film won Best Picture在1995 Oscars?",
  answers:["Forrest Gump","Pulp Fiction","The Shawshank Redemption"],
  correct:0 },

{ id:"mov_034", topic:"movies",
  text:"哪个director made surrealist film 'Eraserhead'?",
  answers:["David Lynch","David Cronenberg","Terry Gilliam"],
  correct:0 },

{ id:"mov_035", topic:"movies",
  text:"哪个国家produced film 'Rashomon' (1950)?",
  answers:["Japan","South Korea","China"],
  correct:0 },

{ id:"mov_036", topic:"movies",
  text:"哪个musical film contains song ' Sound的Music'?",
  answers:["The Sound of Music","My Fair Lady","An American in Paris"],
  correct:0 },

{ id:"mov_037", topic:"movies",
  text:"谁directed film ' Seventh Seal' 哪里knight plays chess与Death?",
  answers:["Ingmar Bergman","F.W. Murnau","Carl Dreyer"],
  correct:0 },

{ id:"mov_038", topic:"movies",
  text:"哪个actor portrayed Luke Skywalker在original Star Wars trilogy?",
  answers:["Mark Hamill","Harrison Ford","Alec Guinness"],
  correct:0 },

{ id:"mov_039", topic:"movies",
  text:"哪个1982 sci-fi film按Ridley Scott是set在dystopian Los Angeles?",
  answers:["Blade Runner","Alien","Outland"],
  correct:0 },

{ id:"mov_040", topic:"movies",
  text:"哪个film features famous dance scene到 'Singin'在Rain'?",
  answers:["Singin’ in the Rain","Top Hat","On the Town"],
  correct:0 },

{ id:"mov_041", topic:"movies",
  text:"谁directed 'Schindler's List'?",
  answers:["Steven Spielberg","Roman Polanski","Oliver Stone"],
  correct:0 },

{ id:"mov_042", topic:"movies",
  text:"哪个film helped launch career的director Christopher Nolan?",
  answers:["Memento","Insomnia","Following"],
  correct:0 },

{ id:"mov_043", topic:"movies",
  text:"哪个movie includes quote 'Say hello到my little friend!'?",
  answers:["Scarface","Goodfellas","Heat"],
  correct:0 },

{ id:"mov_044", topic:"movies",
  text:"谁played Bride在'Kill Bill'?",
  answers:["Uma Thurman","Lucy Liu","Daryl Hannah"],
  correct:0 },

{ id:"mov_045", topic:"movies",
  text:"哪个film是known为phrase '第一个rule的Fight Club是: you not talk about Fight Club'?",
  answers:["Fight Club","Snatch","The Game"],
  correct:0 },

{ id:"mov_046", topic:"movies",
  text:"哪个Italian director made film 'La Dolce Vita'?",
  answers:["Federico Fellini","Vittorio De Sica","Roberto Rossellini"],
  correct:0 },

{ id:"mov_047", topic:"movies",
  text:"哪个horror film features Overlook Hotel?",
  answers:["The Shining","Rosemary’s Baby","The Exorcist"],
  correct:0 },

{ id:"mov_048", topic:"movies",
  text:"谁directed ' Terminator' (1984)?",
  answers:["James Cameron","Ridley Scott","John Carpenter"],
  correct:0 },

{ id:"mov_049", topic:"movies",
  text:"哪个film won Best Picture Oscar在1973?",
  answers:["The Godfather","Cabaret","Deliverance"],
  correct:0 },

{ id:"mov_050", topic:"movies",
  text:"哪个movie follows Corleone family after Vito's death?",
  answers:["The Godfather Part II","The Godfather Part III","Goodfellas"],
  correct:0 },

{ id:"mov_051", topic:"movies",
  text:"谁创作了original Star Wars score?",
  answers:["John Williams","Hans Zimmer","Jerry Goldsmith"],
  correct:0 },

{ id:"mov_052", topic:"movies",
  text:"哪个film features line 'Life finds way'?",
  answers:["Jurassic Park","The Thing","Interstellar"],
  correct:0 },

{ id:"mov_053", topic:"movies",
  text:"哪个film是set在fictional非洲国家Wakanda?",
  answers:["Black Panther","The Lion King","Hotel Rwanda"],
  correct:0 },

{ id:"mov_054", topic:"movies",
  text:"谁directed classic film ' Third Man' (1949)?",
  answers:["Carol Reed","Billy Wilder","David Lean"],
  correct:0 },

{ id:"mov_055", topic:"movies",
  text:"哪个pioneering sci-fi film introduced character Dr. Frankenstein?",
  answers:["Frankenstein (1931)","Dr. Jekyll and Mr. Hyde","Nosferatu"],
  correct:0 },

{ id:"mov_056", topic:"movies",
  text:"哪个film begins与line 'Rosebud'?",
  answers:["Citizen Kane","Vertigo","Rebecca"],
  correct:0 },

{ id:"mov_057", topic:"movies",
  text:"哪个filmmaker directed ' Lord的Rings' trilogy?",
  answers:["Peter Jackson","Sam Raimi","James Cameron"],
  correct:0 },

{ id:"mov_058", topic:"movies",
  text:"哪个1999 film features bullet-time cinematography?",
  answers:["The Matrix","Dark City","Equilibrium"],
  correct:0 },

{ id:"mov_059", topic:"movies",
  text:"哪个director created cyberpunk anime film 'Akira'?",
  answers:["Katsuhiro Otomo","Mamoru Oshii","Hayao Miyazaki"],
  correct:0 },

{ id:"mov_060", topic:"movies",
  text:"谁played Captain Jack Sparrow在'Pirates的Caribbean' franchise?",
  answers:["Johnny Depp","Orlando Bloom","Geoffrey Rush"],
  correct:0 },

  // --------- MUSIC ----------
{ id:"mus_001", topic:"music",
  text:"哪个composer created opera ' Magic Flute'?",
  answers:["Wolfgang Amadeus Mozart","Johann Sebastian Bach","Joseph Haydn"],
  correct:0 },

{ id:"mus_002", topic:"music",
  text:"哪个musical period是Ludwig van Beethoven considered到bridge?",
  answers:["Classical and Romantic","Baroque and Classical","Romantic and Modern"],
  correct:0 },

{ id:"mus_003", topic:"music",
  text:"谁创作了symphonic poem 'Also sprach Zarathustra'?",
  answers:["Richard Strauss","Gustav Mahler","Anton Bruckner"],
  correct:0 },

{ id:"mus_004", topic:"music",
  text:"哪个band released 1967 album 'Sgt. Pepper's Lonely Hearts Club Band'?",
  answers:["The Beatles","The Rolling Stones","The Who"],
  correct:0 },

{ id:"mus_005", topic:"music",
  text:"哪个composer wrote ballet ' Rite的Spring'?",
  answers:["Igor Stravinsky","Sergei Prokofiev","Dmitri Shostakovich"],
  correct:0 },

{ id:"mus_006", topic:"music",
  text:"哪个heavy metal band released album 'Master的Puppets'?",
  answers:["Metallica","Iron Maiden","Megadeth"],
  correct:0 },

{ id:"mus_007", topic:"music",
  text:"哪个jazz musician是nicknamed ' Bird'?",
  answers:["Charlie Parker","John Coltrane","Dizzy Gillespie"],
  correct:0 },

{ id:"mus_008", topic:"music",
  text:"谁创作了opera 'Carmen'?",
  answers:["Georges Bizet","Gioachino Rossini","Giuseppe Verdi"],
  correct:0 },

{ id:"mus_009", topic:"music",
  text:"哪个pianist composed 'Clair de Lune'?",
  answers:["Claude Debussy","Erik Satie","Maurice Ravel"],
  correct:0 },

{ id:"mus_010", topic:"music",
  text:"什么是considered第一个music video played在MTV?",
  answers:["Video Killed the Radio Star","Take On Me","Money for Nothing"],
  correct:0 },

{ id:"mus_011", topic:"music",
  text:"哪个Baroque composer wrote ' Four Seasons'?",
  answers:["Antonio Vivaldi","George Frideric Handel","Arcangelo Corelli"],
  correct:0 },

{ id:"mus_012", topic:"music",
  text:"哪个singer performed 'Respect,' popularized在1967?",
  answers:["Aretha Franklin","Etta James","Nina Simone"],
  correct:0 },

{ id:"mus_013", topic:"music",
  text:"谁创作了opera cycle 'Der Ring des Nibelungen'?",
  answers:["Richard Wagner","Richard Strauss","Gustav Mahler"],
  correct:0 },

{ id:"mus_014", topic:"music",
  text:"哪个guitarist是famous为playing solo在‘Stairway到Heaven'?",
  answers:["Jimmy Page","Eric Clapton","Jeff Beck"],
  correct:0 },

{ id:"mus_015", topic:"music",
  text:"哪个pop star released album 'Thriller'在1982?",
  answers:["Michael Jackson","Prince","Stevie Wonder"],
  correct:0 },

{ id:"mus_016", topic:"music",
  text:"哪个composer wrote 'Moonlight Sonata'?",
  answers:["Beethoven","Chopin","Brahms"],
  correct:0 },

{ id:"mus_017", topic:"music",
  text:"band Queen是fronted按哪个singer?",
  answers:["Freddie Mercury","David Bowie","Robert Plant"],
  correct:0 },

{ id:"mus_018", topic:"music",
  text:"哪个composer wrote opera 'Aida'?",
  answers:["Giuseppe Verdi","Giacomo Puccini","Richard Wagner"],
  correct:0 },

{ id:"mus_019", topic:"music",
  text:"什么是name的Beyoncé's第一个solo album?",
  answers:["Dangerously in Love","Lemonade","B’Day"],
  correct:0 },

{ id:"mus_020", topic:"music",
  text:"谁创作了 ' Planets' suite?",
  answers:["Gustav Holst","Edward Elgar","Jean Sibelius"],
  correct:0 },

{ id:"mus_021", topic:"music",
  text:"什么国家是band ABBA来自?",
  answers:["Sweden","Norway","Finland"],
  correct:0 },

{ id:"mus_022", topic:"music",
  text:"哪个film composer wrote score为 'Star Wars'?",
  answers:["John Williams","Hans Zimmer","James Horner"],
  correct:0 },

{ id:"mus_023", topic:"music",
  text:"哪个opera features famous 'Habanera' aria?",
  answers:["Carmen","La Traviata","Rigoletto"],
  correct:0 },

{ id:"mus_024", topic:"music",
  text:"哪个composer created ballet 'Swan Lake'?",
  answers:["Tchaikovsky","Prokofiev","Rachmaninoff"],
  correct:0 },

{ id:"mus_025", topic:"music",
  text:"什么genre的music是associated与Louis Armstrong?",
  answers:["Jazz","Blues","Swing"],
  correct:0 },

{ id:"mus_026", topic:"music",
  text:"哪个band released 'Dark Side的Moon'?",
  answers:["Pink Floyd","Led Zeppelin","The Doors"],
  correct:0 },

{ id:"mus_027", topic:"music",
  text:"哪个composer wrote 'Symphonie fantastique'?",
  answers:["Hector Berlioz","Franz Liszt","Modest Mussorgsky"],
  correct:0 },

{ id:"mus_028", topic:"music",
  text:"谁是known为 'King的Reggae'?",
  answers:["Bob Marley","Peter Tosh","Jimmy Cliff"],
  correct:0 },

{ id:"mus_029", topic:"music",
  text:"哪个singer recorded hit song 'Purple Rain'?",
  answers:["Prince","Jimi Hendrix","Michael Jackson"],
  correct:0 },

{ id:"mus_030", topic:"music",
  text:"Composer Johann Sebastian Bach是主要associated与哪个city?",
  answers:["Leipzig","Vienna","Berlin"],
  correct:0 },

{ id:"mus_031", topic:"music",
  text:"谁是drummer的Beatles?",
  answers:["Ringo Starr","John Bonham","Charlie Watts"],
  correct:0 },

{ id:"mus_032", topic:"music",
  text:"哪个composer wrote opera 'Turandot'?",
  answers:["Giacomo Puccini","Verdi","Rossini"],
  correct:0 },

{ id:"mus_033", topic:"music",
  text:"哪个1970s band wrote album 'Rumours'?",
  answers:["Fleetwood Mac","The Eagles","Chicago"],
  correct:0 },

{ id:"mus_034", topic:"music",
  text:"哪个singer是known为album 'Back到Black'?",
  answers:["Amy Winehouse","Duffy","Adele"],
  correct:0 },

{ id:"mus_035", topic:"music",
  text:"什么是title的Mozart's final unfinished Requiem mass?",
  answers:["Requiem in D minor","Mass in C minor","Coronation Mass"],
  correct:0 },

{ id:"mus_036", topic:"music",
  text:"哪个band released concept album ' Wall'?",
  answers:["Pink Floyd","Genesis","The Who"],
  correct:0 },

{ id:"mus_037", topic:"music",
  text:"谁创作了opera 'Madama Butterfly'?",
  answers:["Giacomo Puccini","Bellini","Donizetti"],
  correct:0 },

{ id:"mus_038", topic:"music",
  text:"哪个singer performed 1984 hit '例如Virgin'?",
  answers:["Madonna","Cyndi Lauper","Cher"],
  correct:0 },

{ id:"mus_039", topic:"music",
  text:"什么genre是composer Philip Glass associated与?",
  answers:["Minimalism","Romanticism","Expressionism"],
  correct:0 },

{ id:"mus_040", topic:"music",
  text:"谁创作了 'Boléro'?",
  answers:["Maurice Ravel","Claude Debussy","Fauré"],
  correct:0 },

{ id:"mus_041", topic:"music",
  text:"Freddie Mercury是born在哪个在哪个国家?",
  answers:["Zanzibar","India","England"],
  correct:0 },

{ id:"mus_042", topic:"music",
  text:"哪个composer是famous为ballet ' Firebird'?",
  answers:["Igor Stravinsky","Sergei Prokofiev","Dmitri Shostakovich"],
  correct:0 },

{ id:"mus_043", topic:"music",
  text:"哪个musician是known为 ' Godfather的Soul'?",
  answers:["James Brown","Ray Charles","Otis Redding"],
  correct:0 },

{ id:"mus_044", topic:"music",
  text:"哪个composer created ' Barber的Seville'?",
  answers:["Rossini","Verdi","Puccini"],
  correct:0 },

{ id:"mus_045", topic:"music",
  text:"哪个jazz musician recorded album 'Kind的Blue'?",
  answers:["Miles Davis","John Coltrane","Thelonious Monk"],
  correct:0 },

{ id:"mus_046", topic:"music",
  text:"哪个singer performed 'Bohemian Rhapsody'?",
  answers:["Queen","Led Zeppelin","Journey"],
  correct:0 },

{ id:"mus_047", topic:"music",
  text:"哪个band released song 'Hotel California'?",
  answers:["Eagles","Fleetwood Mac","Boston"],
  correct:0 },

{ id:"mus_048", topic:"music",
  text:"哪个composer wrote 'Symphony No. 9' also known为 ‘New World Symphony'?",
  answers:["Antonín Dvořák","Carl Nielsen","Jean Sibelius"],
  correct:0 },

{ id:"mus_049", topic:"music",
  text:"哪个singer released 1991 hit 'Smells例如Teen Spirit'?",
  answers:["Nirvana","Soundgarden","Pearl Jam"],
  correct:0 },

{ id:"mus_050", topic:"music",
  text:"谁创作了music为 ' Mission' and 'Cinema Paradiso'?",
  answers:["Ennio Morricone","John Barry","Howard Shore"],
  correct:0 },

{ id:"mus_051", topic:"music",
  text:"哪个singer是known为 'Queen的Pop'?",
  answers:["Madonna","Whitney Houston","Lady Gaga"],
  correct:0 },

{ id:"mus_052", topic:"music",
  text:"Bach's 'Brandenburg Concertos'是dedicated到哪个nobleman?",
  answers:["Christian Ludwig","Frederick the Great","Leopold I"],
  correct:0 },

{ id:"mus_053", topic:"music",
  text:"谁创作了opera 'La Bohème'?",
  answers:["Puccini","Verdi","Mascagni"],
  correct:0 },

{ id:"mus_054", topic:"music",
  text:"哪个Beatles album features song 'Come Together'?",
  answers:["Abbey Road","Revolver","Let It Be"],
  correct:0 },

{ id:"mus_055", topic:"music",
  text:"哪个blues musician是known为song ' Thrill是Gone'?",
  answers:["B.B. King","Muddy Waters","Howlin’ Wolf"],
  correct:0 },

{ id:"mus_056", topic:"music",
  text:"谁创作了opera 'Don Giovanni'?",
  answers:["Mozart","Beethoven","Handel"],
  correct:0 },

{ id:"mus_057", topic:"music",
  text:"哪个composer是known为piece 'Pictures在Exhibition'?",
  answers:["Mussorgsky","Rimsky-Korsakov","Borodin"],
  correct:0 },

{ id:"mus_058", topic:"music",
  text:"哪个band recorded album 'OK Computer'?",
  answers:["Radiohead","Blur","Oasis"],
  correct:0 },

{ id:"mus_059", topic:"music",
  text:"哪个composer created ballet 'Romeo and Juliet'?",
  answers:["Sergei Prokofiev","Tchaikovsky","Ravel"],
  correct:0 },

{ id:"mus_060", topic:"music",
  text:"哪个singer performed hit 'Imagine'?",
  answers:["John Lennon","Elton John","George Harrison"],
  correct:0 },

  // --------- BRITISH MILITARY ----------
{ id:"brit_001", topic:"brit_military",
  text:"哪个battle在1704 cemented Britain's reputation为major European power?",
  answers:["Battle of Blenheim","Battle of Ramillies","Battle of Oudenarde"],
  correct:0 },

{ id:"brit_002", topic:"brit_military",
  text:"哪个British military leader commanded defeat的Napoleon在Waterloo?",
  answers:["Duke of Wellington","Lord Hill","Sir Thomas Picton"],
  correct:0 },

{ id:"brit_003", topic:"brit_military",
  text:"什么是codename为British evacuation的Dunkirk在1940?",
  answers:["Operation Dynamo","Operation Claymore","Operation Scorch"],
  correct:0 },

{ id:"brit_004", topic:"brit_military",
  text:"哪个elite British regiment是formed在1941为deep-penetration raids在North Africa?",
  answers:["The SAS","The Parachute Regiment","Commandos"],
  correct:0 },

{ id:"brit_005", topic:"brit_military",
  text:"在哪个battle British Army suffer its worst defeat按原产于American force?",
  answers:["Battle of Isandlwana","Battle of Little Bighorn","Battle of New Orleans"],
  correct:0 },

{ id:"brit_006", topic:"brit_military",
  text:"哪个British ship fired第一个naval shot的World War I?",
  answers:["HMS Lance","HMS Dreadnought","HMS Lion"],
  correct:0 },

{ id:"brit_007", topic:"brit_military",
  text:"哪个British general surrendered Singapore到Japan在1942?",
  answers:["Arthur Percival","William Slim","Alan Brooke"],
  correct:0 },

{ id:"brit_008", topic:"brit_military",
  text:"哪个Royal Navy vessel sank German battleship Bismarck's sister ship Scharnhorst?",
  answers:["HMS Duke of York","HMS Hood","HMS Renown"],
  correct:0 },

{ id:"brit_009", topic:"brit_military",
  text:"哪个war saw introduction的British Mark I tank?",
  answers:["World War I","Boer War","World War II"],
  correct:0 },

{ id:"brit_010", topic:"brit_military",
  text:"谁是British commander during Battle的El Alamein?",
  answers:["Bernard Montgomery","Claude Auchinleck","Harold Alexander"],
  correct:0 },

{ id:"brit_011", topic:"brit_military",
  text:"哪个British unit是nicknamed ' Paras'?",
  answers:["Parachute Regiment","Royal Marines","Coldstream Guards"],
  correct:0 },

{ id:"brit_012", topic:"brit_military",
  text:"什么是name的Britain's planned invasion的Norway during WWII?",
  answers:["Operation Wilfred","Operation Fortitude","Operation Market"],
  correct:0 },

{ id:"brit_013", topic:"brit_military",
  text:"哪个19th-century rifle revolutionized British infantry firepower?",
  answers:["Martini–Henry","Brown Bess","Lee–Enfield No.4"],
  correct:0 },

{ id:"brit_014", topic:"brit_military",
  text:"哪个regiment led Charge的Light Brigade?",
  answers:["13th Light Dragoons","Royal Scots Greys","1st Dragoon Guards"],
  correct:0 },

{ id:"brit_015", topic:"brit_military",
  text:"哪个British admiral died during Battle的Trafalgar?",
  answers:["Horatio Nelson","Cuthbert Collingwood","Samuel Hood"],
  correct:0 },

{ id:"brit_016", topic:"brit_military",
  text:"哪个conflict是considered Britain's最长的continuous war?",
  answers:["The Troubles","Boer Wars","Afghan Wars"],
  correct:0 },

{ id:"brit_017", topic:"brit_military",
  text:"哪个British WWI offensive became infamous为massive casualties在第一个day?",
  answers:["Battle of the Somme","Battle of Cambrai","Battle of Loos"],
  correct:0 },

{ id:"brit_018", topic:"brit_military",
  text:"哪个ship是sunk在1982, dramatically shifting British opinion during Falklands War?",
  answers:["HMS Sheffield","HMS Invincible","HMS Broadsword"],
  correct:0 },

{ id:"brit_019", topic:"brit_military",
  text:"哪个British covert operations unit grew out的Special Operations Executive (SOE)?",
  answers:["SAS","SBS","GCHQ"],
  correct:0 },

{ id:"brit_020", topic:"brit_military",
  text:"哪个British structure是breached during German Zeppelin raids的WWI?",
  answers:["London’s East End","Windsor Castle","Portsmouth Dockyard"],
  correct:0 },

{ id:"brit_021", topic:"brit_military",
  text:"哪个British regiment是oldest continuously serving在regular army?",
  answers:["The Royal Scots","Grenadier Guards","Coldstream Guards"],
  correct:0 },

{ id:"brit_022", topic:"brit_military",
  text:"哪个British aircraft是crucial在Battle的Britain?",
  answers:["Supermarine Spitfire","Avro Lancaster","Hawker Tempest"],
  correct:0 },

{ id:"brit_023", topic:"brit_military",
  text:"哪个war featured infamous 'Black Week'的British defeats?",
  answers:["Second Boer War","Crimean War","Zulu War"],
  correct:0 },

{ id:"brit_024", topic:"brit_military",
  text:"谁commanded British forces during American War的Independence surrender在Yorktown?",
  answers:["Charles Cornwallis","Henry Clinton","Banastre Tarleton"],
  correct:0 },

{ id:"brit_025", topic:"brit_military",
  text:"哪个elite unit specializes在amphibious operations为UK?",
  answers:["SBS","SAS","Royal Gurkhas"],
  correct:0 },

{ id:"brit_026", topic:"brit_military",
  text:"哪个British tank是primary heavy tank在WWII?",
  answers:["Churchill","Cromwell","Matilda II"],
  correct:0 },

{ id:"brit_027", topic:"brit_military",
  text:"什么weapon British soldiers famously用途在Rorke's Drift?",
  answers:["Martini–Henry rifle","Baker rifle","Snider–Enfield rifle"],
  correct:0 },

{ id:"brit_028", topic:"brit_military",
  text:"哪个British commander led Gallipoli landings?",
  answers:["Ian Hamilton","Douglas Haig","John French"],
  correct:0 },

{ id:"brit_029", topic:"brit_military",
  text:"哪个city suffered第一个V-1 flying bomb attack?",
  answers:["London","Southampton","Manchester"],
  correct:0 },

{ id:"brit_030", topic:"brit_military",
  text:"哪个conflict resulted在formation的IRA's Provisional wing?",
  answers:["The Troubles","Irish War of Independence","Easter Rising"],
  correct:0 },

{ id:"brit_031", topic:"brit_military",
  text:"哪个machine gun became standard在British Army during WWII?",
  answers:["Bren gun","Lewis gun","Vickers gun"],
  correct:0 },

{ id:"brit_032", topic:"brit_military",
  text:"哪个British general earned nickname '沙漠Fox'?",
  answers:["Rommel","Montgomery","Auchinleck"],
  correct:0 },

{ id:"brit_033", topic:"brit_military",
  text:"哪个naval battle是最大的的WWI?",
  answers:["Battle of Jutland","Battle of Heligoland Bight","Battle of Coronel"],
  correct:0 },

{ id:"brit_034", topic:"brit_military",
  text:"哪个British regiment recruits heavily来自Nepal?",
  answers:["Royal Gurkha Rifles","Black Watch","Royal Fusiliers"],
  correct:0 },

{ id:"brit_035", topic:"brit_military",
  text:"谁发明了British WWII code-breaking machine 'Bombe'?",
  answers:["Alan Turing","Frank Whittle","Barnes Wallis"],
  correct:0 },

{ id:"brit_036", topic:"brit_military",
  text:"哪个British bomber delivered 'Dam Busters' raid?",
  answers:["Avro Lancaster","Handley Page Halifax","Short Stirling"],
  correct:0 },

{ id:"brit_037", topic:"brit_military",
  text:"哪个war结束与Treaty的Amiens?",
  answers:["French Revolutionary Wars","Seven Years’ War","Napoleonic Wars"],
  correct:0 },

{ id:"brit_038", topic:"brit_military",
  text:"哪个British regiment是famous为wearing tam o' shanter?",
  answers:["Royal Scots","Irish Guards","Welsh Guards"],
  correct:0 },

{ id:"brit_039", topic:"brit_military",
  text:"哪个British fighter aircraft introduced revolutionary Rolls-Royce Merlin engine?",
  answers:["Hawker Hurricane","Gloster Meteor","Hawker Fury"],
  correct:0 },

{ id:"brit_040", topic:"brit_military",
  text:"哪个battle结束Jacobite日出的1745?",
  answers:["Battle of Culloden","Battle of Prestonpans","Battle of Falkirk"],
  correct:0 },

{ id:"brit_041", topic:"brit_military",
  text:"哪个submarine sank Argentine cruiser General Belgrano?",
  answers:["HMS Conqueror","HMS Courageous","HMS Renown"],
  correct:0 },

{ id:"brit_042", topic:"brit_military",
  text:"哪个British regiment guards monarch在Buckingham Palace?",
  answers:["Grenadier Guards","Scots Guards","Irish Guards"],
  correct:0 },

{ id:"brit_043", topic:"brit_military",
  text:"哪个treaty结束British rule在美洲?",
  answers:["Treaty of Paris (1783)","Treaty of Utrecht","Treaty of Ghent"],
  correct:0 },

{ id:"brit_044", topic:"brit_military",
  text:"哪个British bomber是used在第一个jet-powered bombing missions?",
  answers:["English Electric Canberra","Avro Vulcan","Handley Page Victor"],
  correct:0 },

{ id:"brit_045", topic:"brit_military",
  text:"哪个battle marked final defeat的Spanish Armada?",
  answers:["Battle of Gravelines","Battle of San Juan","Battle of Lepanto"],
  correct:0 },

{ id:"brit_046", topic:"brit_military",
  text:"哪个British officer led Arab Revolt during WWI?",
  answers:["T.E. Lawrence","General Allenby","Herbert Kitchener"],
  correct:0 },

{ id:"brit_047", topic:"brit_military",
  text:"什么是Britain's主要battle tank during Cold War?",
  answers:["Chieftain","Centurion","Challenger 1"],
  correct:0 },

{ id:"brit_048", topic:"brit_military",
  text:"哪个British naval hero said 'England expects that every man will his duty'?",
  answers:["Nelson","Drake","Rodney"],
  correct:0 },

{ id:"brit_049", topic:"brit_military",
  text:"哪个castle是besieged during Jacobite日出的1715?",
  answers:["Stirling Castle","Edinburgh Castle","Windsor Castle"],
  correct:0 },

{ id:"brit_050", topic:"brit_military",
  text:"哪个RAF bomber carried Britain's第一个operational nuclear weapons?",
  answers:["Avro Vulcan","English Electric Canberra","Short Sperrin"],
  correct:0 },

{ id:"brit_051", topic:"brit_military",
  text:"哪个unit performed famous Iranian Embassy siege rescue在1980?",
  answers:["SAS","SBS","Royal Marines"],
  correct:0 },

{ id:"brit_052", topic:"brit_military",
  text:"哪个British Army regiment是known为 ' Green Jackets'?",
  answers:["Rifles","Royal Anglians","King’s Own Scottish Borderers"],
  correct:0 },

{ id:"brit_053", topic:"brit_military",
  text:"哪个conflict featured British用途的'Thin红色Line' tactic?",
  answers:["Crimean War","Boer War","Napoleonic Wars"],
  correct:0 },

{ id:"brit_054", topic:"brit_military",
  text:"哪个war involved British defeat的Tipu Sultan?",
  answers:["Fourth Anglo-Mysore War","First Anglo-Burmese War","Second Maratha War"],
  correct:0 },

{ id:"brit_055", topic:"brit_military",
  text:"哪个naval vessel是world's第一个operational aircraft carrier?",
  answers:["HMS Argus","HMS Ark Royal","HMS Illustrious"],
  correct:0 },

{ id:"brit_056", topic:"brit_military",
  text:"哪个British military unit uses motto '谁Dares Wins'?",
  answers:["SAS","SBS","Parachute Regiment"],
  correct:0 },

{ id:"brit_057", topic:"brit_military",
  text:"哪个battle featured last major cavalry charge按British Army?",
  answers:["Battle of Omdurman","Battle of Tel el Kebir","Battle of Spion Kop"],
  correct:0 },

{ id:"brit_058", topic:"brit_military",
  text:"谁commanded British forces during Operation沙漠Storm?",
  answers:["General Peter de la Billière","Michael Rose","Rupert Smith"],
  correct:0 },

{ id:"brit_059", topic:"brit_military",
  text:"哪个British field marshal commanded BEF在1914?",
  answers:["Sir John French","Douglas Haig","Edmund Allenby"],
  correct:0 },

{ id:"brit_060", topic:"brit_military",
  text:"哪个conflict saw用途的Britain's第一个modern commandos?",
  answers:["WWII (Norway Campaign)","WWI (Gallipoli)","Boer War"],
  correct:0 },
  // --------- SCIENCE ----------
{ id:"sci_001", topic:"science",
  text:"什么particle是responsible为giving other particles mass according到Standard Model?",
  answers:["Higgs boson","Gluon","Muon"],
  correct:0 },

{ id:"sci_002", topic:"science",
  text:"哪个scientist第一个proposed concept的天然的selection?",
  answers:["Charles Darwin","Gregor Mendel","Jean-Baptiste Lamarck"],
  correct:0 },

{ id:"sci_003", topic:"science",
  text:"什么是仅metal that是liquid在standard temperature and pressure?",
  answers:["Mercury","Gallium","Cesium"],
  correct:0 },

{ id:"sci_004", topic:"science",
  text:"哪个law describes inverse-square relationship between force and distance为electricity?",
  answers:["Coulomb’s Law","Faraday’s Law","Gauss’s Law"],
  correct:0 },

{ id:"sci_005", topic:"science",
  text:"什么branch的physics studies very low temperatures approaching absolute zero?",
  answers:["Cryogenics","Thermodynamics","Condensed matter physics"],
  correct:0 },

{ id:"sci_006", topic:"science",
  text:"什么structure在cell是responsible为ATP production?",
  answers:["Mitochondria","Ribosomes","Golgi apparatus"],
  correct:0 },

{ id:"sci_007", topic:"science",
  text:"什么是most abundant气体在Earth's atmosphere?",
  answers:["Nitrogen","Oxygen","Argon"],
  correct:0 },

{ id:"sci_008", topic:"science",
  text:"什么器官在human body contains hippocampus?",
  answers:["Brain","Liver","Heart"],
  correct:0 },

{ id:"sci_009", topic:"science",
  text:"哪个行星有strongest winds在太阳系?",
  answers:["Neptune","Jupiter","Saturn"],
  correct:0 },

{ id:"sci_010", topic:"science",
  text:"什么是heaviest naturally occurring element?",
  answers:["Uranium","Plutonium","Thorium"],
  correct:0 },

{ id:"sci_011", topic:"science",
  text:"哪个scientist开发了three laws的motion?",
  answers:["Isaac Newton","Johannes Kepler","Galileo Galilei"],
  correct:0 },

{ id:"sci_012", topic:"science",
  text:"什么type的bond involves sharing的electron pairs between atoms?",
  answers:["Covalent","Ionic","Metallic"],
  correct:0 },

{ id:"sci_013", topic:"science",
  text:"哪个organelle contains chlorophyll?",
  answers:["Chloroplast","Mitochondria","Lysosome"],
  correct:0 },

{ id:"sci_014", topic:"science",
  text:"什么scale measures earthquake magnitude?",
  answers:["Richter scale","Beaufort scale","Saffir–Simpson scale"],
  correct:0 },

{ id:"sci_015", topic:"science",
  text:"谁发现了penicillin?",
  answers:["Alexander Fleming","Louis Pasteur","Robert Koch"],
  correct:0 },

{ id:"sci_016", topic:"science",
  text:"哪个subatomic particle有no electric charge?",
  answers:["Neutron","Proton","Electron"],
  correct:0 },

{ id:"sci_017", topic:"science",
  text:"什么law states that energy cannot be created or destroyed?",
  answers:["First Law of Thermodynamics","Law of Entropy","Hooke’s Law"],
  correct:0 },

{ id:"sci_018", topic:"science",
  text:"哪个vitamin deficiency causes scurvy?",
  answers:["Vitamin C","Vitamin D","Vitamin B12"],
  correct:0 },

{ id:"sci_019", topic:"science",
  text:"什么是主要气体responsible为greenhouse effect?",
  answers:["Carbon dioxide","Methane","Nitrous oxide"],
  correct:0 },

{ id:"sci_020", topic:"science",
  text:"哪个scientist proposed uncertainty principle?",
  answers:["Werner Heisenberg","Max Planck","Erwin Schrödinger"],
  correct:0 },

{ id:"sci_021", topic:"science",
  text:"什么器官filters blood在human body?",
  answers:["Kidney","Liver","Pancreas"],
  correct:0 },

{ id:"sci_022", topic:"science",
  text:"哪个行星有最大的volcano在太阳系?",
  answers:["Mars","Earth","Venus"],
  correct:0 },

{ id:"sci_023", topic:"science",
  text:"什么术语describes organism与two identical alleles?",
  answers:["Homozygous","Heterozygous","Polyploid"],
  correct:0 },

{ id:"sci_024", topic:"science",
  text:"什么是chemical formula为食盐?",
  answers:["NaCl","KCl","Na2SO4"],
  correct:0 },

{ id:"sci_025", topic:"science",
  text:"哪个blood vessels携带blood away来自心脏?",
  answers:["Arteries","Veins","Capillaries"],
  correct:0 },

{ id:"sci_026", topic:"science",
  text:"什么element有原子序数1?",
  answers:["Hydrogen","Helium","Lithium"],
  correct:0 },

{ id:"sci_027", topic:"science",
  text:"哪个scientist发现了radioactivity?",
  answers:["Henri Becquerel","Marie Curie","Lise Meitner"],
  correct:0 },

{ id:"sci_028", topic:"science",
  text:"什么phenomenon causes bending的light around objects?",
  answers:["Diffraction","Refraction","Dispersion"],
  correct:0 },

{ id:"sci_029", topic:"science",
  text:"什么是powerhouse的植物cell?",
  answers:["Mitochondria","Chloroplast","Vacuole"],
  correct:0 },

{ id:"sci_030", topic:"science",
  text:"哪个气体是essential为photosynthesis?",
  answers:["Carbon dioxide","Nitrogen","Oxygen"],
  correct:0 },

{ id:"sci_031", topic:"science",
  text:"什么force keeps行星数量在orbit around太阳?",
  answers:["Gravity","Centripetal force","Electromagnetism"],
  correct:0 },

{ id:"sci_032", topic:"science",
  text:"哪个part的brain regulates vital functions such为心脏rate?",
  answers:["Medulla oblongata","Cerebellum","Hippocampus"],
  correct:0 },

{ id:"sci_033", topic:"science",
  text:"什么是most abundant element在universe?",
  answers:["Hydrogen","Helium","Oxygen"],
  correct:0 },

{ id:"sci_034", topic:"science",
  text:"哪个scientist开发了periodic table?",
  answers:["Dmitri Mendeleev","Niels Bohr","Jacobus van ’t Hoff"],
  correct:0 },

{ id:"sci_035", topic:"science",
  text:"哪个器官produces insulin?",
  answers:["Pancreas","Liver","Gallbladder"],
  correct:0 },

{ id:"sci_036", topic:"science",
  text:"什么type的wave requires medium到travel?",
  answers:["Mechanical wave","Electromagnetic wave","Gamma radiation"],
  correct:0 },

{ id:"sci_037", topic:"science",
  text:"什么是pH的pure水?",
  answers:["7","5","9"],
  correct:0 },

{ id:"sci_038", topic:"science",
  text:"哪个law relates pressure and volume为gases在constant temperature?",
  answers:["Boyle’s Law","Charles’ Law","Gay-Lussac’s Law"],
  correct:0 },

{ id:"sci_039", topic:"science",
  text:"哪个layer的地球contains tectonic plates?",
  answers:["Lithosphere","Mantle","Core"],
  correct:0 },

{ id:"sci_040", topic:"science",
  text:"什么part的cell contains genetic material?",
  answers:["Nucleus","Cytoplasm","Endoplasmic reticulum"],
  correct:0 },

{ id:"sci_041", topic:"science",
  text:"哪个scientist formulated theory的general relativity?",
  answers:["Albert Einstein","Max Planck","Henri Poincaré"],
  correct:0 },

{ id:"sci_042", topic:"science",
  text:"什么气体mammals exhale为waste product?",
  answers:["Carbon dioxide","Oxygen","Nitrogen"],
  correct:0 },

{ id:"sci_043", topic:"science",
  text:"什么术语describes ability的material到return到its original shape after deformation?",
  answers:["Elasticity","Plasticity","Ductility"],
  correct:0 },

{ id:"sci_044", topic:"science",
  text:"哪个branch的biology studies fossils?",
  answers:["Paleontology","Archaeology","Geology"],
  correct:0 },

{ id:"sci_045", topic:"science",
  text:"哪个particle mediates electromagnetic force?",
  answers:["Photon","Gluon","W boson"],
  correct:0 },

{ id:"sci_046", topic:"science",
  text:"哪个器官在body stores bile?",
  answers:["Gallbladder","Liver","Pancreas"],
  correct:0 },

{ id:"sci_047", topic:"science",
  text:"什么是center的atom被称为?",
  answers:["Nucleus","Electron cloud","Neutron core"],
  correct:0 },

{ id:"sci_048", topic:"science",
  text:"哪个process converts sugar into alcohol在brewing?",
  answers:["Fermentation","Sublimation","Oxidation"],
  correct:0 },

{ id:"sci_049", topic:"science",
  text:"什么type的star是太阳?",
  answers:["G-type main-sequence star","Red giant","White dwarf"],
  correct:0 },

{ id:"sci_050", topic:"science",
  text:"什么force opposes motion between two surfaces在contact?",
  answers:["Friction","Inertia","Pressure"],
  correct:0 },

{ id:"sci_051", topic:"science",
  text:"哪个气体是responsible为smell after lightning?",
  answers:["Ozone","Methane","Sulfur dioxide"],
  correct:0 },

{ id:"sci_052", topic:"science",
  text:"哪个unit measures electrical resistance?",
  answers:["Ohm","Watt","Volt"],
  correct:0 },

{ id:"sci_053", topic:"science",
  text:"什么是最大的part的human brain?",
  answers:["Cerebrum","Cerebellum","Brainstem"],
  correct:0 },

{ id:"sci_054", topic:"science",
  text:"什么是speed的light在vacuum?",
  answers:["299,792 km/s","150,000 km/s","500,000 km/s"],
  correct:0 },

{ id:"sci_055", topic:"science",
  text:"哪个scientist发现了law的planetary motion?",
  answers:["Johannes Kepler","Tycho Brahe","Galileo Galilei"],
  correct:0 },

{ id:"sci_056", topic:"science",
  text:"什么type的energy是stored在chemical bonds?",
  answers:["Potential energy","Thermal energy","Kinetic energy"],
  correct:0 },

{ id:"sci_057", topic:"science",
  text:"哪个blood type是considered universal donor?",
  answers:["O negative","AB positive","A negative"],
  correct:0 },

{ id:"sci_058", topic:"science",
  text:"什么branch的physics studies behavior的light?",
  answers:["Optics","Acoustics","Kinematics"],
  correct:0 },

{ id:"sci_059", topic:"science",
  text:"哪个molecule carries genetic information?",
  answers:["DNA","RNA","ATP"],
  correct:0 },

{ id:"sci_060", topic:"science",
  text:"什么是术语为substance that speeds up chemical reaction without being consumed?",
  answers:["Catalyst","Solvent","Buffer"],
  correct:0 },

  // words -----

  { id:"word_001", topic:"words", text:"什么术语是什么意思single-use word occurring仅once在corpus or作者?", answers:["Hapax legomenon","Nonce word","Haplology"], correct:0 },
  { id:"word_002", topic:"words", text:"word that是its own antonym (e.g., ‘cleave')是被称为?", answers:["Contronym","Capitonym","Paronym"], correct:0 },
  { id:"word_003", topic:"words", text:"哪个是heteronym (same spelling, different pronunciations/meanings)?", answers:["Lead (metal) / lead (guide)","Plain / plane","Pair / pear"], correct:0 },
  { id:"word_004", topic:"words", text:"word formed按blending parts的two words (e.g., ‘smog')是?", answers:["Portmanteau","Back-formation","Clipping"], correct:0 },
  { id:"word_005", topic:"words", text:"‘Edit' derived historically来自 ‘editor'是example的?", answers:["Back-formation","Conversion","Affixation"], correct:0 },
  { id:"word_006", topic:"words", text:"word created intentionally为single occasion (context-bound)是?", answers:["Nonce word","Loanblend","Retronym"], correct:0 },
  { id:"word_007", topic:"words", text:"哪个device juxtaposes two meanings的word在one structure (e.g., ‘caught train and cold')?", answers:["Zeugma","Chiasmus","Anaphora"], correct:0 },
  { id:"word_008", topic:"words", text:"‘Brunch' and ‘motel'是examples的?", answers:["Blends","Compounds","Acronyms"], correct:0 },
  { id:"word_009", topic:"words", text:"什么是术语为new name given到existing thing到distinguish it来自newer form?", answers:["Retronym","Autonym","Toponym"], correct:0 },
  { id:"word_010", topic:"words", text:"‘Uncopyrightable'是notable为being long English word that是:?", answers:["Isogram (no repeated letters)","Tautogram","Lipogram"], correct:0 },
  { id:"word_011", topic:"words", text:"text deliberately avoiding one or more letters是?", answers:["Lipogram","Isogram","Acrostic"], correct:0 },
  { id:"word_012", topic:"words", text:"‘Buffalo buffalo Buffalo buffalo buffalo buffalo Buffalo buffalo' relies主要在哪个phenomenon?", answers:["Homonymy","Polysemy","Anagram"], correct:0 },
  { id:"word_013", topic:"words", text:"word formed按reversing another (e.g., ‘diaper' → ‘repaid')是被称为?", answers:["Anadrome","Ambigram","Isogloss"], correct:0 },
  { id:"word_014", topic:"words", text:"哪个术语names word derived来自person's name (e.g., ‘sandwich')?", answers:["Eponym","Patronym","Aptronym"], correct:0 },
  { id:"word_015", topic:"words", text:"‘ order的I-A-O在reduplicative pairs例如 ‘flip-flop' follows什么pattern?", answers:["Ablaut reduplication","Exact reduplication","Initial rhyming"], correct:0 },
  { id:"word_016", topic:"words", text:"name aptly suited到its owner's profession (e.g., ‘Mr. Baker' baker)是?", answers:["Aptronym","Autonym","Hyponym"], correct:0 },
  { id:"word_017", topic:"words", text:"哪个是proper definition的‘mondegreen'?", answers:["Misheard phrase producing a new meaning","Humorous misuse of a word","Blend of two idioms"], correct:0 },
  { id:"word_018", topic:"words", text:"humorous misuse的similar-sounding word (来自Mrs. Malaprop)是?", answers:["Malapropism","Eggcorn","Spoonerism"], correct:0 },
  { id:"word_019", topic:"words", text:"mistakenly ‘folk-corrected' phrase例如 ‘escape goat' 为 ‘scapegoat'是?", answers:["Eggcorn","Mondegreen","Malapropism"], correct:0 },
  { id:"word_020", topic:"words", text:"Swapping initial sounds的two words (‘lighting fire' → ‘fighting liar')是?", answers:["Spoonerism","Metathesis","Anadiplosis"], correct:0 },
  { id:"word_021", topic:"words", text:"哪个术语denotes word spelled same but与different capitalization and meaning (e.g., ‘Polish'/‘polish')?", answers:["Capitonym","Heterograph","Homonyn"], correct:0 },
  { id:"word_022", topic:"words", text:"word that reads same backward为forward是?", answers:["Palindrome","Heteronym","Ambigram"], correct:0 },
  { id:"word_023", topic:"words", text:"哪个sentence type uses every letter的alphabet在least once?", answers:["Pangram","Isogram","Lipogram"], correct:0 },
  { id:"word_024", topic:"words", text:"‘Dermatoglyphics'是notable because it是long English:?", answers:["Isogram","Palindrome","Heterograph"], correct:0 },
  { id:"word_025", topic:"words", text:"Words例如 ‘sing/sang/sung' exemplify vowel change被称为?", answers:["Ablaut","Umlaut","Epenthesis"], correct:0 },
  { id:"word_026", topic:"words", text:"change例如 ‘man' → ‘men' 通过fronting的vowel是known为?", answers:["Umlaut","Vowel harmony","Apocope"], correct:0 },
  { id:"word_027", topic:"words", text:"‘Go/went' illustrates什么morphological phenomenon?", answers:["Suppletion","Back-formation","Clipping"], correct:0 },
  { id:"word_028", topic:"words", text:"study的word origins是被称为?", answers:["Etymology","Morphology","Semantics"], correct:0 },
  { id:"word_029", topic:"words", text:"哪个prefix是什么意思 ‘all' or ‘every'?", answers:["Pan-","Para-","Peri-"], correct:0 },
  { id:"word_030", topic:"words", text:"哪个suffix denotes ‘ study of'?", answers:["-logy","-graphy","-nomy"], correct:0 },
  { id:"word_031", topic:"words", text:"word borrowed directly来自another语言与little change是?", answers:["Loanword","Calque","Coinage"], correct:0 },
  { id:"word_032", topic:"words", text:"literal, component-by-component translation的foreign术语是?", answers:["Calque","Loanblend","Acronym"], correct:0 },
  { id:"word_033", topic:"words", text:"‘Salary' traces到Latin ‘salarium', connected historically到哪个commodity?", answers:["Salt","Silk","Sand"], correct:0 },
  { id:"word_034", topic:"words", text:"‘Quarantine' derives来自Italian ‘quaranta'. 什么number是referenced?", answers:["40","15","100"], correct:0 },
  { id:"word_035", topic:"words", text:"word whose meaning有broadened over time (e.g., ‘holiday') underwent?", answers:["Semantic widening","Semantic narrowing","Amelioration"], correct:0 },
  { id:"word_036", topic:"words", text:"word whose meaning became more specific (e.g., ‘meat' → 动物flesh) underwent?", answers:["Semantic narrowing","Pejoration","Shift"], correct:0 },
  { id:"word_037", topic:"words", text:"‘Nice' shifting historically来自 ‘ignorant' 到 ‘pleasant'是example的?", answers:["Amelioration","Pejoration","Widening"], correct:0 },
  { id:"word_038", topic:"words", text:"‘Silly' shifting来自 ‘blessed' 到 ‘foolish'是example的?", answers:["Pejoration","Amelioration","Narrowing"], correct:0 },
  { id:"word_039", topic:"words", text:"哪个是most frequent vowel sound在unstressed English syllables?", answers:["Schwa","Long e","Short i"], correct:0 },
  { id:"word_040", topic:"words", text:"word spelled与diacritic到mark vowel quality, 为在‘naïve', uses?", answers:["Diaeresis","Cedilla","Breve"], correct:0 },
  { id:"word_041", topic:"words", text:"什么we call two words related按inclusion (e.g., ‘rose'是___的‘flower')?", answers:["Hyponym","Holonym","Meronym"], correct:0 },
  { id:"word_042", topic:"words", text:"哪个术语names relationship哪里 ‘wheel'是part的‘car'?", answers:["Meronymy","Holonymy","Hypernymy"], correct:0 },
  { id:"word_043", topic:"words", text:"letter added within word (e.g., ‘ath-a-lete')是instance的?", answers:["Epenthesis","Syncope","Apheresis"], correct:0 },
  { id:"word_044", topic:"words", text:"letter or sound omitted来自middle的word (e.g., ‘chocolate' → ‘choc'late')是?", answers:["Syncope","Elision","Apocope"], correct:0 },
  { id:"word_045", topic:"words", text:"Dropping initial segment (e.g., ‘squire' 来自 ‘esquire') exemplifies?", answers:["Apheresis","Apocope","Prothesis"], correct:0 },
  { id:"word_046", topic:"words", text:"Dropping final segment (e.g., ‘photo' 来自 ‘photograph')是?", answers:["Apocope","Clipping","Syncope"], correct:0 },
  { id:"word_047", topic:"words", text:"‘Radar' and ‘scuba'是examples的什么formation?", answers:["Acronyms","Initialisms","Clippings"], correct:0 },
  { id:"word_048", topic:"words", text:"‘BBC' and ‘FBI' pronounced为letters是?", answers:["Initialisms","Acronyms","Abbreviations only"], correct:0 },
  { id:"word_049", topic:"words", text:"word whose letters can all be rotated 180° 到form letters again (typography)是被称为?", answers:["Ambigram","Isogram","Anagram"], correct:0 },
  { id:"word_050", topic:"words", text:"哪个术语denotes pair的words sounding alike but spelled differently (e.g., ‘pair'/‘pear')?", answers:["Homophones","Homographs","Heteronyms"], correct:0 },
  { id:"word_051", topic:"words", text:"哪个术语denotes words spelled same but possibly pronounced differently (e.g., ‘tear'/‘tear')?", answers:["Homographs","Homophones","Capitonyms"], correct:0 },
  { id:"word_052", topic:"words", text:"哪个figure repeats word在end的one clause and start的next?", answers:["Anadiplosis","Epistrophe","Epizeuxis"], correct:0 },
  { id:"word_053", topic:"words", text:"哪个figure repeats initial words or phrases across successive clauses?", answers:["Anaphora","Chiasmus","Polysyndeton"], correct:0 },
  { id:"word_054", topic:"words", text:"Crisscross structure ‘ABBA'在phrasing是known为?", answers:["Chiasmus","Polyptoton","Antimetabole"], correct:0 },
  { id:"word_055", topic:"words", text:"word与letters在strictly alphabetical order (e.g., ‘almost')是?", answers:["Abecedarian word","Isogram","Acrostic"], correct:0 },
  { id:"word_056", topic:"words", text:"哪个是correct name为word that names sound (e.g., ‘buzz')?", answers:["Onomatopoeia","Ideophone","Euphony"], correct:0 },
  { id:"word_057", topic:"words", text:"什么是术语为exact word repetition为emphasis (e.g., ‘Never, never, never')?", answers:["Epizeuxis","Epanalepsis","Polyptoton"], correct:0 },
  { id:"word_058", topic:"words", text:"‘Book' → ‘bookish' illustrates哪个process?", answers:["Derivational suffixation","Inflection","Conversion"], correct:0 },
  { id:"word_059", topic:"words", text:"‘Google' used为verb represents哪个process?", answers:["Conversion (zero-derivation)","Back-formation","Compounding"], correct:0 },
  { id:"word_060", topic:"words", text:"word whose letters can be rearranged到form another word是?", answers:["Anagram","Ambigram","Acronym"], correct:0 },
  { id:"word_061", topic:"words", text:"哪个术语refers到redundancy按adding unnecessary synonym (‘free gift')?", answers:["Pleonasm","Tautology (logical)","Hendiadys"], correct:0 },
  { id:"word_062", topic:"words", text:"Two nouns joined按 ‘and' 到express single complex idea (‘nice and warm')是?", answers:["Hendiadys","Hysteron proteron","Litotes"], correct:0 },
  { id:"word_063", topic:"words", text:"Understatement按negating opposite (‘not bad')是被称为?", answers:["Litotes","Meiosis","Euphemism"], correct:0 },
  { id:"word_064", topic:"words", text:"deliberately paradoxical or self-contradictory phrase (‘deafening silence')是?", answers:["Oxymoron","Paradox","Antithesis"], correct:0 },
  { id:"word_065", topic:"words", text:"‘Bromance'是best归类为为?", answers:["Blend (portmanteau)","Clipping","Compound"], correct:0 },
  { id:"word_066", topic:"words", text:"哪个是术语为word created来自initials but pronounced为word?", answers:["Acronym","Initialism","Backronym"], correct:0 },
  { id:"word_067", topic:"words", text:"‘Backronym'是什么意思?", answers:["A phrase retrofitted to match an existing word","Any acronym with vowels","A reversed acronym"], correct:0 },
  { id:"word_068", topic:"words", text:"‘Kleptomaniac' shares root与‘encyclopedia'在哪个element?", answers:["-klept- does not; ‘encyclo-’ is different","Both share ‘-mania’","Both share ‘-pedia’"], correct:0 },
  { id:"word_069", topic:"words", text:"哪个prefix是什么意思 ‘different' or ‘abnormal'?", answers:["Dys-","Iso-","Holo-"], correct:0 },
  { id:"word_070", topic:"words", text:"哪个prefix是什么意思 ‘equal' or ‘same'?", answers:["Iso-","Hetero-","Holo-"], correct:0 },
  { id:"word_071", topic:"words", text:"name为place (e.g., ‘Everest')是?", answers:["Toponym","Eponym","Troponym"], correct:0 },
  { id:"word_072", topic:"words", text:"word meaning derived来自another's brand name (e.g., ‘hoover')是?", answers:["Genericized trademark","Aptronym","Autonym"], correct:0 },
  { id:"word_073", topic:"words", text:"‘Pneumonoultramicroscopicsilicovolcanoconiosis'是best described为?", answers:["Coined long medical term","Natural ancient Greek term","Back-formation"], correct:0 },
  { id:"word_074", topic:"words", text:"哪个是example的capitonym pair?", answers:["March/march","Read/read","Bow/bow"], correct:0 },
  { id:"word_075", topic:"words", text:"什么是‘tautogram'?", answers:["Text where all words start with same letter","Text with no repeated letters","Text using all letters once"], correct:0 },
  { id:"word_076", topic:"words", text:"哪个pair illustrates metathesis (sound transposition)?", answers:["Bird ↔ brid (historical)","Bread ↔ broad","Color ↔ colour"], correct:0 },
  { id:"word_077", topic:"words", text:"Adding sound在word's beginning (e.g., ‘asparagus' → ‘sparrowgrass')是?", answers:["Prothesis (folk)","Epenthesis","Apheresis"], correct:0 },
  { id:"word_078", topic:"words", text:"‘Ghoti' jokingly pronounced为 ‘fish' demonstrates什么?", answers:["Irregular orthography mapping","True phonetic spelling","Etymological spelling"], correct:0 },
  { id:"word_079", topic:"words", text:"word manufactured到imitate brand class (e.g., ‘Kleenex' 为tissue)是?", answers:["Proprietary eponym","Toponym","Hypocorism"], correct:0 },
  { id:"word_080", topic:"words", text:"哪个是pure是ogram (no letter repeats)?", answers:["Subdermatoglyphic","Assessment","Successes"], correct:0 },
  { id:"word_081", topic:"words", text:"diminutive or pet form的name (e.g., ‘Liz' 为 ‘Elizabeth')是?", answers:["Hypocorism","Aptronym","Capitonym"], correct:0 },
  { id:"word_082", topic:"words", text:"术语为words例如 ‘cuckoo' imitating sounds是?", answers:["Onomatopoeia","Euphony","Cacophony"], correct:0 },
  { id:"word_083", topic:"words", text:"‘Smog' came来自哪个exact sources?", answers:["Smoke + fog","Smoke + smut","Smog + fog"], correct:0 },
  { id:"word_084", topic:"words", text:"figure that purposely ends successive clauses与same word?", answers:["Epistrophe","Epanalepsis","Anaphora"], correct:0 },
  { id:"word_085", topic:"words", text:"Repetition的word在both beginning and end的same clause是?", answers:["Epanalepsis","Epizeuxis","Anadiplosis"], correct:0 },
  { id:"word_086", topic:"words", text:"‘Hurricane' and ‘cacique' entered English通过哪个语言family?", answers:["Arawakan/Cariban via Spanish","Finnic via Russian","Sino-Tibetan via Portuguese"], correct:0 },
  { id:"word_087", topic:"words", text:"哪个是correct术语为regional boundary的linguistic feature distribution?", answers:["Isogloss","Idiolect","Ecotone"], correct:0 },
  { id:"word_088", topic:"words", text:"newly coined word or expression是?", answers:["Neologism","Archaism","Neograph"], correct:0 },
  { id:"word_089", topic:"words", text:"deliberately old-fashioned word or style是?", answers:["Archaism","Archaization","Archetype"], correct:0 },
  { id:"word_090", topic:"words", text:"哪个pair best shows polysemy (related senses)?", answers:["Mouth (river/human)","Bat (animal/club)","Pen (animal enclosure/writing tool)"], correct:0 },
  { id:"word_091", topic:"words", text:"哪个pair best shows true homonymy (unrelated etymologies)?", answers:["Bat (animal) / bat (club)","Mouth (river/human)","Foot (poetry/body)"], correct:0 },
  { id:"word_092", topic:"words", text:"哪个word是contronym?", answers:["Sanction","Avoid","Assert"], correct:0 },
  { id:"word_093", topic:"words", text:"process的making verb来自noun without affixes (‘到chair meeting')是?", answers:["Conversion","Back-formation","Derivation"], correct:0 },
  { id:"word_094", topic:"words", text:"哪个是proper example的reduplication?", answers:["Hodge-podge","Holograph","Homograph"], correct:0 },
  { id:"word_095", topic:"words", text:"word borrowed and then reshaped到look原产于 (e.g., ‘catercorner' 来自French) underwent?", answers:["Folk etymology","Calquing","Metanalysis"], correct:0 },
  { id:"word_096", topic:"words", text:"哪个术语names expression combining parts来自two idioms (e.g., ‘we'll burn that bridge何时we get到it')?", answers:["Eggcorn-like blend (malaphor)","Mondegreen","Spoonerism"], correct:0 },
  { id:"word_097", topic:"words", text:"哪个是generic术语为word formation按shortening (‘exam' 来自 ‘examination')?", answers:["Clipping","Elision","Apocope only"], correct:0 },
  { id:"word_098", topic:"words", text:"哪个label fits ‘onomastics'?", answers:["Study of names","Study of sounds","Study of scripts"], correct:0 },
  { id:"word_099", topic:"words", text:"word that names itself (e.g., ‘noun'是noun)是best被称为?", answers:["Autological word","Heterological word","Auto-antonym"], correct:0 },
  { id:"word_100", topic:"words", text:"‘Color' vs ‘colour' illustrates哪个phenomenon?", answers:["Orthographic variation","Capitonymy","Homophony only"], correct:0 },

  // space

  { id:"space_001", topic:"space", text:"什么是most common type的star在Milky Way?", answers:["Red dwarfs (M-type)","Sun-like G stars","Blue O/B stars"], correct:0 },
  { id:"space_002", topic:"space", text:"哪个element dominates interstellar medium按number?", answers:["Hydrogen","Helium","Oxygen"], correct:0 },
  { id:"space_003", topic:"space", text:"Approximate blackbody temperature的cosmic microwave background?", answers:["2.725 K","10 K","0.73 K"], correct:0 },
  { id:"space_004", topic:"space", text:"在哪个太阳–地球point JWST operate?", answers:["L2","L1","L4"], correct:0 },
  { id:"space_005", topic:"space", text:"Primary mirror diameter的JWST?", answers:["6.5 m","3.5 m","10 m"], correct:0 },
  { id:"space_006", topic:"space", text:"Discovery method的51 Pegasi b (第一个热Jupiter around Sun-like star)?", answers:["Radial velocity","Transit photometry","Direct imaging"], correct:0 },
  { id:"space_007", topic:"space", text:"Kirkwood gaps在asteroid belt是caused按resonances与哪个行星?", answers:["Jupiter","Mars","Saturn"], correct:0 },
  { id:"space_008", topic:"space", text:"Millisecond pulsars是spun up主要按?", answers:["Accretion from a companion","Magnetic braking reversal","Core helium flashes"], correct:0 },
  { id:"space_009", topic:"space", text:"Type Ia supernovae arise来自?", answers:["Thermonuclear runaway of a white dwarf","Core-collapse of a massive star","Pair-instability in very massive stars"], correct:0 },
  { id:"space_010", topic:"space", text:"Chandrasekhar mass limit是about?", answers:["1.4 solar masses","2.6 solar masses","0.9 solar masses"], correct:0 },
  { id:"space_011", topic:"space", text:"Schwarzschild radius为mass M是proportional到?", answers:["2GM/c²","GM²/c","c²/GM"], correct:0 },
  { id:"space_012", topic:"space", text:"Jupiter's excess heat是主要due到?", answers:["Gravitational (Kelvin–Helmholtz) contraction","Ongoing nuclear fusion","Tidal heating by Io"], correct:0 },
  { id:"space_013", topic:"space", text:"Saturn's additional internal heat source是strongly linked到?", answers:["Helium rain","Radioactive decay","Core crystallization"], correct:0 },
  { id:"space_014", topic:"space", text:"Roche limit describes distance在哪个body will?", answers:["Be tidally disrupted by a primary","Become tidally locked","Capture smaller bodies efficiently"], correct:0 },
  { id:"space_015", topic:"space", text:"为什么是Venus's surface hotter than Mercury's在average?", answers:["Runaway greenhouse effect","Closer average distance to Sun","Higher albedo"], correct:0 },
  { id:"space_016", topic:"space", text:"哪个月球有dense nitrogen atmosphere and hydrocarbon lakes?", answers:["Titan","Ganymede","Europa"], correct:0 },
  { id:"space_017", topic:"space", text:"活动cryovolcanic plumes有been observed在?", answers:["Enceladus","Europa","Ganymede"], correct:0 },
  { id:"space_018", topic:"space", text:"哪个是最大的volcano在太阳系?", answers:["Olympus Mons","Mauna Kea","Arsia Mons"], correct:0 },
  { id:"space_019", topic:"space", text:"哪个行星有sidereal day longer than its year?", answers:["Venus","Mercury","Uranus"], correct:0 },
  { id:"space_020", topic:"space", text:"第一个spacecraft到provide close flyby images的Pluto (2015)?", answers:["New Horizons","Voyager 2","Pioneer 11"], correct:0 },
  { id:"space_021", topic:"space", text:"Primary source的long-period comets?", answers:["Oort Cloud","Kuiper Belt","Main asteroid belt"], correct:0 },
  { id:"space_022", topic:"space", text:"Aurorae是driven主要按?", answers:["Solar wind particles guided by magnetic fields","Cosmic ray showers","Lunar tidal currents in the ionosphere"], correct:0 },
  { id:"space_023", topic:"space", text:"Synchrotron radiation是emitted按?", answers:["Charged particles spiraling in magnetic fields","Thermal dust grains","Neutral atoms colliding"], correct:0 },
  { id:"space_024", topic:"space", text:"Typical composition的most white dwarfs?", answers:["Carbon–oxygen","Iron–nickel","Pure helium"], correct:0 },
  { id:"space_025", topic:"space", text:"Neutron stars是supported against gravity chiefly按?", answers:["Degeneracy pressure and nuclear forces","Radiation pressure","Thermal pressure"], correct:0 },
  { id:"space_026", topic:"space", text:"event horizon是region哪里?", answers:["Escape speed exceeds light speed","Magnetic fields dominate","Orbital velocities are Keplerian"], correct:0 },
  { id:"space_027", topic:"space", text:"Hubble–Lemaître law relates galaxy's recessional velocity到its?", answers:["Distance","Mass","Inclination"], correct:0 },
  { id:"space_028", topic:"space", text:"near-perfect ring image来自gravitational lensing是被称为?", answers:["Einstein ring","Airy ring","Poisson spot"], correct:0 },
  { id:"space_029", topic:"space", text:"Space mission that measures stellar parallaxes与microarcsecond precision?", answers:["Gaia","Hipparcos","Kepler"], correct:0 },
  { id:"space_030", topic:"space", text:"21-cm line used到map Galaxy arises来自?", answers:["Spin-flip transition of neutral hydrogen","Rotational lines of CO","Free–free emission from H II regions"], correct:0 },
  { id:"space_031", topic:"space", text:"Dominant fusion pathway powering Sun's core?", answers:["Proton–proton chain","CNO cycle","Triple-alpha cycle"], correct:0 },
  { id:"space_032", topic:"space", text:"Sunspots是features的solar?", answers:["Photosphere","Chromosphere","Corona"], correct:0 },
  { id:"space_033", topic:"space", text:"coronal mass ejection (CME)是best described为?", answers:["A large ejection of magnetized plasma from the corona","A shock at the bow of the heliosphere","A flare limited to X-rays only"], correct:0 },
  { id:"space_034", topic:"space", text:"为什么comet tails point away来自太阳?", answers:["Solar radiation pressure and solar wind","Comet’s orbital velocity vector","Tidal forces"], correct:0 },
  { id:"space_035", topic:"space", text:"幼崽pre-main-sequence stars与strong winds and disks是?", answers:["T Tauri stars","Blue stragglers","Horizontal branch stars"], correct:0 },
  { id:"space_036", topic:"space", text:"Planetary nebulae form何时?", answers:["Low/intermediate-mass stars shed outer layers near AGB end","Massive stars collapse","White dwarfs accrete to instability"], correct:0 },
  { id:"space_037", topic:"space", text:"Globular clusters主要inhabit Galaxy's?", answers:["Halo","Thin disk","Bar"], correct:0 },
  { id:"space_038", topic:"space", text:"哪个major galaxy是在collision course与Milky Way?", answers:["Andromeda (M31)","Triangulum (M33)","Large Magellanic Cloud"], correct:0 },
  { id:"space_039", topic:"space", text:"Cepheid variables是used主要到determine?", answers:["Distances to nearby galaxies","Stellar metallicities","Galaxy rotation curves"], correct:0 },
  { id:"space_040", topic:"space", text:"RR Lyrae stars是especially useful为distances到?", answers:["Globular clusters","Type Ia hosts","Quasars"], correct:0 },
  { id:"space_041", topic:"space", text:"Primary cause的Earth's seasons?", answers:["Axial tilt","Eccentric orbit","Solar cycle"], correct:0 },
  { id:"space_042", topic:"space", text:"Earth's axial precession cycle是最近的到?", answers:["~26,000 years","~2,600 years","~260,000 years"], correct:0 },
  { id:"space_043", topic:"space", text:"Tidal locking results在哪?", answers:["Same hemisphere always facing the primary","Resonant orbital exchanges","Spin axis perpendicular to orbit"], correct:0 },
  { id:"space_044", topic:"space", text:"body's Hill sphere defines region哪里it can?", answers:["Gravitationally retain satellites","Undergo Roche disruption","Capture solar wind"], correct:0 },
  { id:"space_045", topic:"space", text:"哪个spectral class是最热的?", answers:["O-type","A-type","G-type"], correct:0 },
  { id:"space_046", topic:"space", text:"在astronomy ‘metals' refers到?", answers:["All elements heavier than helium","Iron-peak elements only","Elements with atomic number > 26"], correct:0 },
  { id:"space_047", topic:"space", text:"Main-sequence relation between luminosity and mass是roughly?", answers:["L ∝ M^3.5","L ∝ M","L ∝ M^0.5"], correct:0 },
  { id:"space_048", topic:"space", text:"Stefan–Boltzmann law implies stellar luminosity鳞片为?", answers:["L ∝ R²T⁴","L ∝ RT²","L ∝ R³T"], correct:0 },
  { id:"space_049", topic:"space", text:"Primary greenhouse气体在Venus?", answers:["Carbon dioxide","Methane","Water vapor"], correct:0 },
  { id:"space_050", topic:"space", text:"哪个planet's spin axis tilt是~98°?", answers:["Uranus","Neptune","Saturn"], correct:0 },
  { id:"space_051", topic:"space", text:"Jupiter's Great红色Spot是?", answers:["Long-lived anticyclonic storm","Transient cyclone","Thermal inversion feature"], correct:0 },
  { id:"space_052", topic:"space", text:"Jupiter and Saturn atmospheres是主要?", answers:["Hydrogen and helium","Nitrogen and oxygen","CO₂ and N₂"], correct:0 },
  { id:"space_053", topic:"space", text:"Rings persist more easily inside Roche limit because?", answers:["Tidal forces prevent accretion into moons","Radiation pressure sorts particles","Yarkovsky drift dominates"], correct:0 },
  { id:"space_054", topic:"space", text:"Trojan asteroids occupy哪个stable sites relative到Jupiter?", answers:["L4 and L5 Lagrange points","L1 only","Polar co-orbits"], correct:0 },
  { id:"space_055", topic:"space", text:"Albedo measures object's?", answers:["Reflectivity","Emissivity","Conductivity"], correct:0 },
  { id:"space_056", topic:"space", text:"Transit depth allows direct measurement的planet's?", answers:["Radius","Mass","Albedo"], correct:0 },
  { id:"space_057", topic:"space", text:"Radial-velocity detections yield planet's?", answers:["Minimum mass (m·sin i)","True radius","Geometric albedo"], correct:0 },
  { id:"space_058", topic:"space", text:"Transit timing variations (TTVs) can indicate?", answers:["Additional planets in the system","Stellar flares","High stellar metallicity"], correct:0 },
  { id:"space_059", topic:"space", text:"热Jupiters most likely arrived close到their stars通过?", answers:["Orbital migration","In-situ formation","Tidal circularization from comets"], correct:0 },
  { id:"space_060", topic:"space", text:"Habitable zone distance主要depends在star's?", answers:["Luminosity","Rotation rate","Magnetic field strength"], correct:0 },
  { id:"space_061", topic:"space", text:"最近的individual star到太阳?", answers:["Proxima Centauri","Alpha Centauri A","Barnard’s Star"], correct:0 },
  { id:"space_062", topic:"space", text:"We see different constellations over year主要because的Earth's?", answers:["Orbital motion","Axial precession","Changing obliquity"], correct:0 },
  { id:"space_063", topic:"space", text:"magnetar是neutron star与extremely strong?", answers:["Magnetic fields (~10^14–10^15 G)","Neutrino flux","Wind-driven jets only"], correct:0 },
  { id:"space_064", topic:"space", text:"Short gamma-ray bursts是linked到?", answers:["Compact binary mergers","Massive star collapses","White dwarf novae"], correct:0 },
  { id:"space_065", topic:"space", text:"Quasars是powered按?", answers:["Accretion onto supermassive black holes","Intense star formation alone","Rotating neutron star beams"], correct:0 },
  { id:"space_066", topic:"space", text:"Eddington limit是balance between gravity and?", answers:["Radiation pressure on ionized gas","Magnetic pressure","Dynamic ram pressure"], correct:0 },
  { id:"space_067", topic:"space", text:"Radius的observable universe是about?", answers:["~46 billion light-years","~13.8 billion light-years","~4.6 billion light-years"], correct:0 },
  { id:"space_068", topic:"space", text:"Cosmic inflation是proposed chiefly到solve?", answers:["Horizon and flatness problems","Dark matter problem","Lithium abundance problem"], correct:0 },
  { id:"space_069", topic:"space", text:"star becomes红色大主要after?", answers:["Core hydrogen exhaustion","Helium flash completion","Onset of carbon burning"], correct:0 },
  { id:"space_070", topic:"space", text:"White dwarfs shine主要due到?", answers:["Residual thermal energy cooling","Active fusion shells","Accretion shocks"], correct:0 },
  { id:"space_071", topic:"space", text:"Pulsar ‘lighthouse' effect arises来自?", answers:["Misaligned rotation and magnetic axes","Precession of the crust","Orbiting hot spots"], correct:0 },
  { id:"space_072", topic:"space", text:"A-type stars show strongest哪个spectral lines?", answers:["Hydrogen Balmer lines","Helium ion lines","Molecular bands"], correct:0 },
  { id:"space_073", topic:"space", text:"Massive stars (>~8 M☉) end their lives most经常为?", answers:["Core-collapse supernovae","Type Ia supernovae","Planetary nebulae"], correct:0 },
  { id:"space_074", topic:"space", text:"哪个是最大的canyon system在太阳系?", answers:["Valles Marineris (Mars)","Verona Rupes (Miranda)","Ithaca Chasma (Tethys)"], correct:0 },
  { id:"space_075", topic:"space", text:"Liquid hydrocarbon lakes and seas是发现于在?", answers:["Titan","Triton","Callisto"], correct:0 },
  { id:"space_076", topic:"space", text:"Boundary哪里solar wind meets interstellar medium是?", answers:["Heliopause","Termination shock","Magnetopause"], correct:0 },
  { id:"space_077", topic:"space", text:"第一个spacecraft到cross into interstellar space?", answers:["Voyager 1","Pioneer 10","Voyager 2"], correct:0 },
  { id:"space_078", topic:"space", text:"Approximate period的solar sunspot cycle?", answers:["~11 years","~5.5 years","~22 days"], correct:0 },
  { id:"space_079", topic:"space", text:"Retrograde loops的outer planets arise主要来自?", answers:["Earth overtaking them in its orbit","Planetary axial tilts","Solar wind drag"], correct:0 },
  { id:"space_080", topic:"space", text:"Saros cycle为eclipse recurrence是roughly?", answers:["~18 years 11 days","~8 years 1 month","~36 years"], correct:0 },
  { id:"space_081", topic:"space", text:"annular solar eclipse occurs何时Moon's?", answers:["Apparent size is smaller than the Sun’s","Shadow entirely covers the Sun","Orbit is inclined by >10° at node"], correct:0 },
  { id:"space_082", topic:"space", text:"Technique combining light来自multiple telescopes到boost resolution?", answers:["Interferometry","Adaptive optics","Coronagraphy"], correct:0 },
  { id:"space_083", topic:"space", text:"Celestial coordinate analogous到terrestrial latitude?", answers:["Declination","Right ascension","Ecliptic longitude"], correct:0 },
  { id:"space_084", topic:"space", text:"sidereal day在地球是approximately?", answers:["23h 56m","24h 00m","24h 04m"], correct:0 },
  { id:"space_085", topic:"space", text:"Adaptive optics主要compensates为?", answers:["Atmospheric turbulence","Instrumental thermal drift","Chromatic aberration in lenses"], correct:0 },
  { id:"space_086", topic:"space", text:"Mercury's extreme day–夜间temperature swings是due到?", answers:["Thin atmosphere and slow rotation","High orbital eccentricity only","High albedo"], correct:0 },
  { id:"space_087", topic:"space", text:"Zeeman splitting的spectral lines是caused按?", answers:["Magnetic fields","High rotation speeds","Pressure broadening by collisions"], correct:0 },
  { id:"space_088", topic:"space", text:"主要constituent的Mars's atmosphere?", answers:["CO₂","N₂","O₂"], correct:0 },
  { id:"space_089", topic:"space", text:"Region的small icy身体beyond Neptune's orbit是?", answers:["Kuiper Belt","Gould Belt","Phoebe ring"], correct:0 },
  { id:"space_090", topic:"space", text:"Neptune's strongest winds and dark spot是第一个seen按?", answers:["Voyager 2","Cassini","New Horizons"], correct:0 },
  { id:"space_091", topic:"space", text:"Solar neutrinos是produced主要在Sun's?", answers:["Core","Radiative zone","Convective zone"], correct:0 },
  { id:"space_092", topic:"space", text:"Primary reason铁halts stellar fusion energy production?", answers:["Fusion of Fe is endothermic","Iron decays too quickly","Iron ionizes too easily"], correct:0 },
  { id:"space_093", topic:"space", text:"galaxy与central bar structure是归类为为?", answers:["SB (barred spiral)","E (elliptical)","Irr (irregular)"], correct:0 },
  { id:"space_094", topic:"space", text:"Tully–Fisher relation connects spiral galaxy luminosity到?", answers:["Rotation speed","Color index","Bar length"], correct:0 },
  { id:"space_095", topic:"space", text:"Baryonic acoustic oscillations是imprinted在哪?", answers:["Large-scale galaxy distribution","Planetary ring gaps","Sunspot latitudes"], correct:0 },
  { id:"space_096", topic:"space", text:"Lyman-alpha forest在quasar spectra主要traces?", answers:["Intergalactic neutral hydrogen clouds","Molecular clouds in the host galaxy","Stellar winds near the quasar"], correct:0 },
  { id:"space_097", topic:"space", text:"‘红色clump' stars是core-helium-burning stars在?", answers:["Horizontal branch","Asymptotic giant branch","Pre-main sequence"], correct:0 },
  { id:"space_098", topic:"space", text:"Dust causes distant stars到appear?", answers:["Redder and dimmer (extinction)","Bluer and brighter","Unchanged in color but dimmer"], correct:0 },
  { id:"space_099", topic:"space", text:"哪个process best explains existence的blue stragglers在clusters?", answers:["Stellar mergers or mass transfer","Enhanced helium diffusion","Magnetic braking collapse"], correct:0 },
  { id:"space_100", topic:"space", text:"Sun's differential rotation是最快的在?", answers:["Equator","Mid-latitudes","Poles"], correct:0 },

  { id:"books_001", topic:"books", text:"在Herman Melville's *Moby-Dick*, 什么是Captain Ahab's ship被称为?", answers:["Pequod","Rachel","Hispaniola"], correct:0 },
  { id:"books_002", topic:"books", text:"在James Joyce's *Ulysses*, 主要action takes place在哪个date?", answers:["16 June 1904","1 May 1916","4 July 1776"], correct:0 },
  { id:"books_003", topic:"books", text:"在*One Hundred Years的Solitude*, 什么family surname anchors novel's generations?", answers:["Buendia","Iguaran","Aureliano"], correct:0 },
  { id:"books_004", topic:"books", text:"在Dostoevsky's *Crime and Punishment*, story是set主要在哪个city?", answers:["St. Petersburg","Moscow","Kiev"], correct:0 },
  { id:"books_005", topic:"books", text:"在Umberto Eco's * Name的Rose*, 谁narrates story为older man?", answers:["Adso of Melk","William of Baskerville","Jorge of Burgos"], correct:0 },
  { id:"books_006", topic:"books", text:"在*War and Peace*, 哪个1812 battle是depicted为pivotal turning point?", answers:["Borodino","Waterloo","Gettysburg"], correct:0 },
  { id:"books_007", topic:"books", text:"在*Les Miserables*, 什么是Jean Valjean's prisoner number?", answers:["24601","221B","451"], correct:0 },
  { id:"books_008", topic:"books", text:"在*Don Quixote*, 什么是name的Don Quixote's horse?", answers:["Rocinante","Bucephalus","Pegasus"], correct:0 },
  { id:"books_009", topic:"books", text:"在Homer's *Odyssey*, 什么是name的Odysseus's dog谁recognizes him?", answers:["Argos","Cerberus","Laertes"], correct:0 },
  { id:"books_010", topic:"books", text:"在Dante's *Divine Comedy*, 谁guides Dante through Hell and most的Purgatory?", answers:["Virgil","Beatrice","St. Bernard"], correct:0 },

  { id:"books_011", topic:"books", text:"在Dickens's *Great Expectations*, 谁是revealed为Pip's secret benefactor?", answers:["Abel Magwitch","Miss Havisham","Joe Gargery"], correct:0 },
  { id:"books_012", topic:"books", text:"在*Wuthering Heights*, 谁provides most的story为principal storyteller?", answers:["Nelly Dean","Mr. Lockwood","Catherine Earnshaw"], correct:0 },
  { id:"books_013", topic:"books", text:"在*Jane Eyre*,在什么estate Jane work为governess?", answers:["Thornfield Hall","Gateshead Hall","Pemberley"], correct:0 },
  { id:"books_014", topic:"books", text:"在Austen's *Emma*, 谁是secretly engaged到Jane Fairfax?", answers:["Frank Churchill","Mr. Knightley","Robert Martin"], correct:0 },
  { id:"books_015", topic:"books", text:"在George Eliot's *Middlemarch*, 什么是surname的ambitious doctor Tertius?", answers:["Lydgate","Casaubon","Bulstrode"], correct:0 },
  { id:"books_016", topic:"books", text:"在Bram Stoker's *Dracula*, 什么ship carries Dracula到England?", answers:["Demeter","Nautilus","Beagle"], correct:0 },
  { id:"books_017", topic:"books", text:"在*Frankenstein*, 谁frames narrative through letters来自北极?", answers:["Robert Walton","Henry Clerval","Alphonse Frankenstein"], correct:0 },
  { id:"books_018", topic:"books", text:"在* Picture的Dorian Gray*, 谁paints Dorian's portrait?", answers:["Basil Hallward","Lord Henry Wotton","Alan Campbell"], correct:0 },
  { id:"books_019", topic:"books", text:"在Kafka's * Trial*, protagonist是known为什么?", answers:["Josef K.","Gregor S.","Karl R."], correct:0 },
  { id:"books_020", topic:"books", text:"在Conrad's *心脏的Darkness*, 什么是riverboat captain/narrator's name?", answers:["Marlow","Kurtz","Verloc"], correct:0 },

  { id:"books_021", topic:"books", text:"在Nabokov's *Lolita*, 谁narrates novel?", answers:["Humbert Humbert","John Ray","Clare Quilty"], correct:0 },
  { id:"books_022", topic:"books", text:"在Woolf's *Mrs Dalloway*, 哪个character returns来自India and unsettles Clarissa's memories?", answers:["Peter Walsh","Richard Dalloway","Hugh Whitbread"], correct:0 },
  { id:"books_023", topic:"books", text:"在Morrison's *Beloved*, 什么是house number that becomes motif?", answers:["124","13","221"], correct:0 },
  { id:"books_024", topic:"books", text:"在Faulkner's * Sound and Fury*, 谁narrates第一个section?", answers:["Benjy","Quentin","Jason"], correct:0 },
  { id:"books_025", topic:"books", text:"在* Count的Monte Cristo*, Edmond Dantes是imprisoned在哪个fortress?", answers:["Chateau d'If","Bastille","Tower of London"], correct:0 },
  { id:"books_026", topic:"books", text:"在*Pride and Prejudice*, 什么是Mr. Darcy's estate被称为?", answers:["Pemberley","Netherfield","Longbourn"], correct:0 },
  { id:"books_027", topic:"books", text:"在* Brothers Karamazov*, 谁是murdered father?", answers:["Fyodor Pavlovich Karamazov","Ivan Karamazov","Dmitri Karamazov"], correct:0 },
  { id:"books_028", topic:"books", text:"在Camus's * Stranger*, 什么是protagonist's name?", answers:["Meursault","Rieux","Clamence"], correct:0 },
  { id:"books_029", topic:"books", text:"在Camus's * Plague*, 哪个city是struck and quarantined?", answers:["Oran","Algiers","Marseille"], correct:0 },
  { id:"books_030", topic:"books", text:"在Kafka's * 变态发育*, Gregor Samsa awakens为什么?", answers:["A giant insect","A wolf","A machine"], correct:0 },

  { id:"books_031", topic:"books", text:"在*Iliad*, 谁delivers fatal blow到Patroclus?", answers:["Hector","Paris","Aeneas"], correct:0 },
  { id:"books_032", topic:"books", text:"在Shakespeare's *Hamlet*, 什么是play-within-the-play被称为?", answers:["The Murder of Gonzago","The Mousetrap","The Spanish Tragedy"], correct:0 },
  { id:"books_033", topic:"books", text:"在*Odyssey*, 什么是name的Calypso's岛?", answers:["Ogygia","Ithaca","Delos"], correct:0 },
  { id:"books_034", topic:"books", text:"在Virgil's *Aeneid*, 谁是Aeneas's doomed lover在Carthage?", answers:["Dido","Andromache","Cassandra"], correct:0 },
  { id:"books_035", topic:"books", text:"在H.G. Wells's * Time Machine*, 什么是subterranean cannibalistic beings被称为?", answers:["Morlocks","Eloi","Selenites"], correct:0 },
  { id:"books_036", topic:"books", text:"在Stevenson's *Treasure是陆地*, 什么是name的ship used到reach岛?", answers:["Hispaniola","Pequod","Nellie"], correct:0 },
  { id:"books_037", topic:"books", text:"在Defoe's *Robinson Crusoe*, 什么name Crusoe give his rescued companion?", answers:["Friday","Man Friday","Sextus"], correct:0 },
  { id:"books_038", topic:"books", text:"在* Count的Monte Cristo*, 什么alias是Edmond Dantes known按为English benefactor?", answers:["Lord Wilmore","Abbe Busoni","Sinbad the Sailor"], correct:0 },
  { id:"books_039", topic:"books", text:"在Hawthorne's * Scarlet Letter*, 什么是Reverend Dimmesdale's第一个name?", answers:["Arthur","Jonathan","Samuel"], correct:0 },
  { id:"books_040", topic:"books", text:"在Dickens's * Tale的Two Cities*, 什么是surname的Paris wine-shop couple?", answers:["Defarge","Manette","Carton"], correct:0 },

  { id:"books_041", topic:"books", text:"在Orwell's *1984*, 什么是name的engineered语言designed到limit thought?", answers:["Newspeak","Oldspeak","Doublespeak"], correct:0 },
  { id:"books_042", topic:"books", text:"在Huxley's *Brave New World*, 什么drug是used到keep citizens docile?", answers:["Soma","Spice","Nectar"], correct:0 },
  { id:"books_043", topic:"books", text:"在Heller's *Catch-22*, 谁runs syndicate that profits来自both sides的war?", answers:["Milo Minderbinder","Doc Daneeka","Major Major"], correct:0 },
  { id:"books_044", topic:"books", text:"在Vonnegut's *Slaughterhouse-Five*, 什么是name的alien species that abducts Billy Pilgrim?", answers:["Tralfamadorians","Vogons","Martians"], correct:0 },
  { id:"books_045", topic:"books", text:"在*One Flew Over Cuckoo's Nest*, 谁narrates novel?", answers:["Chief Bromden","Randle McMurphy","Nurse Ratched"], correct:0 },
  { id:"books_046", topic:"books", text:"在Golding's *Lord的Flies*, 哪个character是closely associated与finding conch?", answers:["Piggy","Jack","Simon"], correct:0 },
  { id:"books_047", topic:"books", text:"在*到Kill Mockingbird*, 什么是Boo Radley's第一个name?", answers:["Arthur","Thomas","Caleb"], correct:0 },
  { id:"books_048", topic:"books", text:"在* Catcher在Rye*, 哪个school有Holden just been expelled来自?", answers:["Pencey Prep","Phillips Exeter","St. Oswald's"], correct:0 },
  { id:"books_049", topic:"books", text:"在Atwood's * Handmaid's Tale*, 什么greeting Handmaids commonly用途?", answers:["Blessed be the fruit","May the odds be ever in your favor","Winter is coming"], correct:0 },
  { id:"books_050", topic:"books", text:"在McCarthy's * Road*, 如何是two主要characters通常identified?", answers:["The man and the boy","The father and the son (named)","The hunter and the child"], correct:0 },

  { id:"books_051", topic:"books", text:"在是higuro's *Never Let Me Go*, 什么是name的students' school?", answers:["Hailsham","Blythewood","Greystone"], correct:0 },
  { id:"books_052", topic:"books", text:"在是higuro's * Remains的Day*, 什么是narrator's surname?", answers:["Stevens","Farraday","Kent"], correct:0 },
  { id:"books_053", topic:"books", text:"在Rushdie's *Midnight's Children*, 谁narrates story?", answers:["Saleem Sinai","Shiva","Aadam Aziz"], correct:0 },
  { id:"books_054", topic:"books", text:"在Mandel's *Station Eleven*, 什么是name的in-world graphic novel?", answers:["Dr. Eleven","The Glass Planet","Sea of Tranquility"], correct:0 },
  { id:"books_055", topic:"books", text:"在Donna Tartt's * Secret History*, 什么是name的fictional college?", answers:["Hampden College","Camden College","Hawthorne College"], correct:0 },
  { id:"books_056", topic:"books", text:"在Roy's * God的Small Things*, story是set主要在哪个Indian state?", answers:["Kerala","Goa","Punjab"], correct:0 },
  { id:"books_057", topic:"books", text:"在Kingsolver's * Poisonwood Bible*, 什么是missionary family's surname?", answers:["Price","Pryce","Parker"], correct:0 },
  { id:"books_058", topic:"books", text:"在Diaz's * Brief Wondrous Life的Oscar Wao*, 谁是primary narrator?", answers:["Yunior","Oscar","Beli"], correct:0 },
  { id:"books_059", topic:"books", text:"在Murakami's * Wind-Up鸟类Chronicle*, 什么是protagonist's name?", answers:["Toru Okada","Noboru Wataya","Hajime Aomame"], correct:0 },
  { id:"books_060", topic:"books", text:"在Kundera's * Unbearable Lightness的Being*, 什么是surgeon protagonist's第一个name?", answers:["Tomas","Franz","Milan"], correct:0 },

  { id:"books_061", topic:"books", text:"在Suskind's *Perfume*, 什么是protagonist's full name?", answers:["Jean-Baptiste Grenouille","Jean Valjean","Jean Tarrou"], correct:0 },
  { id:"books_062", topic:"books", text:"在Zafon's * Shadow的Wind*, 什么是secret library被称为?", answers:["The Cemetery of Forgotten Books","The Archive of Lost Tales","The Library of Ashes"], correct:0 },
  { id:"books_063", topic:"books", text:"在Hosseini's * Kite Runner*, 什么是narrator's name?", answers:["Amir","Hassan","Rahim"], correct:0 },
  { id:"books_064", topic:"books", text:"在Gaiman's *American Gods*, 什么是protagonist's name?", answers:["Shadow Moon","Loki Laufeyson","Jack Gladney"], correct:0 },
  { id:"books_065", topic:"books", text:"在Walker's * Color Purple*, 谁writes letters that structure novel?", answers:["Celie","Nettie","Shug"], correct:0 },
  { id:"books_066", topic:"books", text:"在Herbert's *Dune*, 什么是Paul Atreides' public Fremen name?", answers:["Muad'Dib","Usul","Shai-Hulud"], correct:0 },
  { id:"books_067", topic:"books", text:"在Asimov's *Foundation*, 什么是Hari Seldon's predictive science被称为?", answers:["Psychohistory","Psychometry","Chronostatics"], correct:0 },
  { id:"books_068", topic:"books", text:"在Gibson's *Neuromancer*, 什么是hacker protagonist's name?", answers:["Case","Molly","Wintermute"], correct:0 },
  { id:"books_069", topic:"books", text:"在Stephenson's *Snow Crash*, 什么是protagonist's name?", answers:["Hiro Protagonist","Y.T.","Ng Security"], correct:0 },
  { id:"books_070", topic:"books", text:"在Adams's * Hitchhiker's Guide到Galaxy*, 什么是name的Zaphod's starship?", answers:["Heart of Gold","Event Horizon","Serenity"], correct:0 },

  { id:"books_071", topic:"books", text:"在Le Guin's * Left Hand的Darkness*, 谁是Ekumen envoy protagonist?", answers:["Genly Ai","Estraven","Harth rem ir Estraven"], correct:0 },
  { id:"books_072", topic:"books", text:"在Le Guin's * Dispossessed*, 什么是anarchist月球被称为?", answers:["Anarres","Urras","Gethen"], correct:0 },
  { id:"books_073", topic:"books", text:"在Card's *Ender's Game*,?'Ender' is a nickname for 哪个 第一个 name?", answers:["Andrew","Arthur","Edmund"], correct:0 },
  { id:"books_074", topic:"books", text:"在Simmons's *Hyperion*, 什么是feared time-warping creature被称为?", answers:["The Shrike","The Leviathan","The Watchmaker"], correct:0 },
  { id:"books_075", topic:"books", text:"在Philip K. Dick's * Androids Dream的Electric Sheep?*, 什么是bounty hunter's name?", answers:["Rick Deckard","John Anderton","Douglas Quaid"], correct:0 },
  { id:"books_076", topic:"books", text:"在Weir's * Martian*, 什么是stranded astronaut's name?", answers:["Mark Watney","Jim Holden","Dave Bowman"], correct:0 },
  { id:"books_077", topic:"books", text:"在Tolkien's * Hobbit*, 什么是name的Bilbo's sword?", answers:["Sting","Glamdring","Anduril"], correct:0 },
  { id:"books_078", topic:"books", text:"在Le Guin's * Wizard的Earthsea*, 什么是Sparrowhawk's true name?", answers:["Ged","Arren","Ogion"], correct:0 },
  { id:"books_079", topic:"books", text:"在Rothfuss's * Name的Wind*, 什么name Kvothe用途while hiding为innkeeper?", answers:["Kote","Denna","Simmon"], correct:0 },
  { id:"books_080", topic:"books", text:"在Martin's * Game的Thrones*, 什么是name的Arya Stark's sword?", answers:["Needle","Oathkeeper","Heartsbane"], correct:0 },

  { id:"books_081", topic:"books", text:"在Tolkien's * Fellowship的Ring*, 哪个山pass Fellowship attempt before Moria?", answers:["Caradhras","Cirith Ungol","High Pass"], correct:0 },
  { id:"books_082", topic:"books", text:"在Lynch's * Lies的Locke Lamora*, 什么是主要city被称为?", answers:["Camorr","Ankh-Morpork","Luthadel"], correct:0 },
  { id:"books_083", topic:"books", text:"在Pullman's *His Dark Materials*, 什么是name的Lyra's daemon?", answers:["Pantalaimon","Iorek","Stelmaria"], correct:0 },
  { id:"books_084", topic:"books", text:"谁写了 * Once and Future King*?", answers:["T. H. White","C. S. Lewis","E. M. Forster"], correct:0 },
  { id:"books_085", topic:"books", text:"在Lewis's * 狮子, Witch and Wardrobe*, 什么是professor's surname?", answers:["Kirke","Tumnus","MacPhee"], correct:0 },
  { id:"books_086", topic:"books", text:"在Sanderson's *Mistborn* (Era 1), 什么是name的rare metal linked到future-sight在Final Empire's lore?", answers:["Atium","Electrum","Tin"], correct:0 },
  { id:"books_087", topic:"books", text:"在Chandler's * Big Sleep*, 什么是detective's name?", answers:["Philip Marlowe","Hercule Poirot","Sam Spade"], correct:0 },
  { id:"books_088", topic:"books", text:"在Hammett's * Maltese Falcon*, 什么是detective's name?", answers:["Sam Spade","Philip Marlowe","Lew Archer"], correct:0 },
  { id:"books_089", topic:"books", text:"在Christie's * Murder的Roger Ackroyd*, 谁narrates story?", answers:["Dr. Sheppard","Captain Hastings","Inspector Japp"], correct:0 },
  { id:"books_090", topic:"books", text:"在Doyle's * Hound的Baskervilles*, family curse是linked到哪个ancestor?", answers:["Hugo Baskerville","Henry Baskerville","James Baskerville"], correct:0 },

  { id:"books_091", topic:"books", text:"在Highsmith's * Talented Mr. Ripley*, 什么是protagonist's第一个name?", answers:["Tom","Dickie","Freddie"], correct:0 },
  { id:"books_092", topic:"books", text:"在Larsson's * Girl与Dragon Tattoo*, 什么是journalist's name?", answers:["Mikael Blomkvist","Henrik Vanger","Martin Vanger"], correct:0 },
  { id:"books_093", topic:"books", text:"在Darwin's *在Origin的Species*, 什么mechanism是central到explaining adaptation?", answers:["Natural selection","Lamarkian inheritance","Spontaneous generation"], correct:0 },
  { id:"books_094", topic:"books", text:"谁写了 * Prince*?", answers:["Niccolo Machiavelli","Thomas Hobbes","John Locke"], correct:0 },
  { id:"books_095", topic:"books", text:"谁写了 * Wealth的Nations*?", answers:["Adam Smith","David Ricardo","John Maynard Keynes"], correct:0 },
  { id:"books_096", topic:"books", text:"谁写了 * Structure的Scientific Revolutions*?", answers:["Thomas Kuhn","Karl Popper","Francis Bacon"], correct:0 },
  { id:"books_097", topic:"books", text:"谁写了 *Silent Spring*?", answers:["Rachel Carson","Jane Goodall","E. O. Wilson"], correct:0 },
  { id:"books_098", topic:"books", text:"* Diary的幼崽Girl*是best known按whose name?", answers:["Anne Frank","Zlata Filipovic","Malala Yousafzai"], correct:0 },
  { id:"books_099", topic:"books", text:"谁写了 * Gulag Archipelago*?", answers:["Aleksandr Solzhenitsyn","Varlam Shalamov","Mikhail Bulgakov"], correct:0 },
  { id:"books_100", topic:"books", text:"在Orwell's *动物Farm*, 什么是original revolutionary slogan before it是altered?", answers:["All animals are equal","Four legs good, two legs bad","Beasts of England"], correct:0 },

  { id:"epl_001", topic:"epl",
  text:"Premier League began在哪个season?",
  answers:["1992–93","1989–90","1995–96"],
  correct:0 },

{ id:"epl_002", topic:"epl",
  text:"多少teams是在Premier League season?",
  answers:["20","18","22"],
  correct:0 },

{ id:"epl_003", topic:"epl",
  text:"多少league matches each team play per season?",
  answers:["38","34","42"],
  correct:0 },

{ id:"epl_004", topic:"epl",
  text:"多少points是win worth在Premier League?",
  answers:["3","2","1"],
  correct:0 },

{ id:"epl_005", topic:"epl",
  text:"多少clubs是relegated来自Premier League each season?",
  answers:["3","2","4"],
  correct:0 },

{ id:"epl_006", topic:"epl",
  text:"season与20 teams contains多少total matches?",
  answers:["380","400","360"],
  correct:0 },

{ id:"epl_007", topic:"epl",
  text:"Premier League clubs是主要based在哪?",
  answers:["England","Scotland","Wales"],
  correct:0 },

{ id:"epl_008", topic:"epl",
  text:"哪个competition是England's主要domestic knockout cup?",
  answers:["FA Cup","EFL Trophy","Community Shield"],
  correct:0 },

{ id:"epl_009", topic:"epl",
  text:"哪个cup是经常referred到为League Cup?",
  answers:["EFL Cup","FA Cup","UEFA Super Cup"],
  correct:0 },

{ id:"epl_010", topic:"epl",
  text:"什么是traditional name为matches played在Dec 26?",
  answers:["Boxing Day fixtures","New Year derbies","Spring classics"],
  correct:0 },

{ id:"epl_011", topic:"epl",
  text:"在Football 'clean sheet'是什么意思?",
  answers:["Conceding 0 goals","Scoring 3 goals","Winning away from home"],
  correct:0 },

{ id:"epl_012", topic:"epl",
  text:"在Football 'hat-trick'是?",
  answers:["3 goals by one player in a match","3 assists by one player","3 shots on target in a half"],
  correct:0 },

{ id:"epl_013", topic:"epl",
  text:"在Football 'own goal'是scored何时?",
  answers:["A player puts the ball into their own team’s net","A goalkeeper scores from a kick","A defender scores from a corner"],
  correct:0 },

{ id:"epl_014", topic:"epl",
  text:"在Football什么VAR stand为?",
  answers:["Video Assistant Referee","Variable Action Review","Verified Attacking Result"],
  correct:0 },

{ id:"epl_015", topic:"epl",
  text:"在EPL什么decides league position if points是equal (第一个tiebreaker)?",
  answers:["Goal difference","Head-to-head points","Fewest yellow cards"],
  correct:0 },

{ id:"epl_016", topic:"epl",
  text:"在EPL什么decides league position if goal difference是also equal?",
  answers:["Goals scored","Coin toss","Away goals only"],
  correct:0 },

{ id:"epl_017", topic:"epl",
  text:"在Football 'derby' 通常refers到?",
  answers:["A match between local rivals","A match played in rain","A match decided by penalties"],
  correct:0 },

{ id:"epl_018", topic:"epl",
  text:"在Football North London derby是traditionally?",
  answers:["Arsenal vs Tottenham","Chelsea vs Arsenal","West Ham vs Tottenham"],
  correct:0 },

{ id:"epl_019", topic:"epl",
  text:"在Football Merseyside derby是traditionally?",
  answers:["Everton vs Liverpool","Liverpool vs Man City","Everton vs Man United"],
  correct:0 },

{ id:"epl_020", topic:"epl",
  text:"在Football Manchester derby是traditionally?",
  answers:["Man United vs Man City","Man United vs Liverpool","Man City vs Everton"],
  correct:0 },

{ id:"epl_021", topic:"epl",
  text:"哪个football club是known为 ' Gunners'?",
  answers:["Arsenal","Aston Villa","Newcastle"],
  correct:0 },

{ id:"epl_022", topic:"epl",
  text:"哪个football club是known为 '红色Devils'?",
  answers:["Manchester United","Liverpool","Nottingham Forest"],
  correct:0 },

{ id:"epl_023", topic:"epl",
  text:"哪个Football club是known为 ' Blues'?",
  answers:["Chelsea","Tottenham","Wolves"],
  correct:0 },

{ id:"epl_024", topic:"epl",
  text:"哪个Football club是known为 ' Toffees'?",
  answers:["Everton","Leicester City","Crystal Palace"],
  correct:0 },

{ id:"epl_025", topic:"epl",
  text:"哪个Football club是known为 ' Hammers'?",
  answers:["West Ham United","Fulham","Brentford"],
  correct:0 },

{ id:"epl_026", topic:"epl",
  text:"哪个Football club是known为 ' Magpies'?",
  answers:["Newcastle United","Brighton","Burnley"],
  correct:0 },

{ id:"epl_027", topic:"epl",
  text:"哪个Football club是known为 ' Foxes'?",
  answers:["Leicester City","Southampton","Bournemouth"],
  correct:0 },

{ id:"epl_028", topic:"epl",
  text:"哪个Football club是known为 ' Saints'?",
  answers:["Southampton","Tottenham","Sheffield United"],
  correct:0 },

{ id:"epl_029", topic:"epl",
  text:"哪个Football club是known为 ' Cherries'?",
  answers:["AFC Bournemouth","Brentford","Watford"],
  correct:0 },

{ id:"epl_030", topic:"epl",
  text:"哪个Football club是known为 ' Bees'?",
  answers:["Brentford","Brighton","Burnley"],
  correct:0 },

{ id:"epl_031", topic:"epl",
  text:"哪个Football club是known为 ' Seagulls'?",
  answers:["Brighton & Hove Albion","Newcastle","Fulham"],
  correct:0 },

{ id:"epl_032", topic:"epl",
  text:"哪个Football club是known为 ' Villans'?",
  answers:["Aston Villa","West Ham","Wolves"],
  correct:0 },

{ id:"epl_033", topic:"epl",
  text:"Tottenham Hotspur是commonly nicknamed?",
  answers:["Spurs","The Saints","The Hornets"],
  correct:0 },

{ id:"epl_034", topic:"epl",
  text:"Liverpool's home stadium是?",
  answers:["Anfield","Old Trafford","St James’ Park"],
  correct:0 },

{ id:"epl_035", topic:"epl",
  text:"Manchester United's home stadium是?",
  answers:["Old Trafford","Etihad Stadium","Stamford Bridge"],
  correct:0 },

{ id:"epl_036", topic:"epl",
  text:"Arsenal's home stadium是?",
  answers:["Emirates Stadium","Selhurst Park","Villa Park"],
  correct:0 },

{ id:"epl_037", topic:"epl",
  text:"Chelsea's home stadium是?",
  answers:["Stamford Bridge","Craven Cottage","Goodison Park"],
  correct:0 },

{ id:"epl_038", topic:"epl",
  text:"Newcastle United's home stadium是?",
  answers:["St James’ Park","King Power Stadium","The Amex"],
  correct:0 },

{ id:"epl_039", topic:"epl",
  text:"West Ham United's current home stadium是?",
  answers:["London Stadium","Upton Park","Wembley Stadium"],
  correct:0 },

{ id:"epl_040", topic:"epl",
  text:"Everton's traditional long-time home stadium是?",
  answers:["Goodison Park","Anfield","Elland Road"],
  correct:0 },

{ id:"epl_041", topic:"epl",
  text:"在Football 'penalty kick'是awarded为foul committed?",
  answers:["Inside the penalty area by defenders","At the halfway line","Only for handball anywhere"],
  correct:0 },

{ id:"epl_042", topic:"epl",
  text:"在Football direct free kick allows goal到be scored?",
  answers:["Directly without a touch from another player","Only after two touches","Only from inside the box"],
  correct:0 },

{ id:"epl_043", topic:"epl",
  text:"在Football indirect free kick requires?",
  answers:["A touch by another player before a goal","The ball to be chipped","The keeper to leave the line"],
  correct:0 },

{ id:"epl_044", topic:"epl",
  text:"在Football Offside是judged使用哪个part的body?",
  answers:["Any part you can legally score with","Only the feet","Only the head"],
  correct:0 },

{ id:"epl_045", topic:"epl",
  text:"在Football goalkeeper may handle ball哪里?",
  answers:["Inside their own penalty area","Anywhere in their half","Only inside the 6-yard box"],
  correct:0 },

{ id:"epl_046", topic:"epl",
  text:"在Football 'yellow card' indicates?",
  answers:["A caution","A sending-off","A free substitution"],
  correct:0 },

{ id:"epl_047", topic:"epl",
  text:"在Football '红色card' results在哪?",
  answers:["The player being sent off","A penalty automatically","The match being abandoned"],
  correct:0 },

{ id:"epl_048", topic:"epl",
  text:"在Football Two yellow cards在one match lead到?",
  answers:["A red card","A warning only","A time penalty"],
  correct:0 },

{ id:"epl_049", topic:"epl",
  text:"在Football goalkeeper's smaller box是被称为?",
  answers:["Six-yard box (goal area)","Center circle","Technical area"],
  correct:0 },

{ id:"epl_050", topic:"epl",
  text:"在Football larger box around goal是被称为?",
  answers:["Penalty area","Goal area","D-zone"],
  correct:0 },

{ id:"epl_051", topic:"epl",
  text:"在Football 'set piece'是best described为?",
  answers:["A restart like a corner/free kick/throw-in","A pass sequence of 10+ passes","A shot from open play only"],
  correct:0 },

{ id:"epl_055", topic:"epl",
  text:"在Football什么是'added time'?",
  answers:["Extra minutes for stoppages at end of a half","A full extra 30 minutes","A replay of the match"],
  correct:0 },

{ id:"epl_056", topic:"epl",
  text:"在league football, 'extra time'是通常used在哪?",
  answers:["Cup matches, not league matches","All Premier League matches","Only friendlies"],
  correct:0 },

{ id:"epl_057", topic:"epl",
  text:"在Football 'brace'是什么意思player scored?",
  answers:["2 goals","3 goals","4 goals"],
  correct:0 },

{ id:"epl_058", topic:"epl",
  text:"在Football 'clean sheet'是credited主要到?",
  answers:["Team/goalkeeper (no goals conceded)","Striker only","Referee"],
  correct:0 },

{ id:"epl_059", topic:"epl",
  text:"在Football 'Golden Boot'是awarded到league's?",
  answers:["Top scorer","Most assists","Best goalkeeper"],
  correct:0 },

{ id:"epl_060", topic:"epl",
  text:"在Football 'Golden Glove' 通常recognizes goalkeeper与most?",
  answers:["Clean sheets","Saves","Penalties taken"],
  correct:0 },

{ id:"epl_061", topic:"epl",
  text:"在Football 'playmaker'是most associated与?",
  answers:["Creating chances/assists","Winning headers only","Taking throw-ins"],
  correct:0 },

{ id:"epl_062", topic:"epl",
  text:"在Football 'box-to-box' midfielder是expected到?",
  answers:["Contribute in attack and defense across the pitch","Stay only in the penalty area","Never cross halfway"],
  correct:0 },

{ id:"epl_063", topic:"epl",
  text:"在Football 'target man' striker通常?",
  answers:["Holds up the ball and wins aerial duels","Only scores from free kicks","Plays as a goalkeeper in possession"],
  correct:0 },

{ id:"epl_064", topic:"epl",
  text:"在Football 'false nine'是forward谁?",
  answers:["Drops into midfield to link play","Never touches the ball","Only plays on the wing"],
  correct:0 },

{ id:"epl_065", topic:"epl",
  text:"'在Football Pressing' refers到?",
  answers:["Applying aggressive pressure to win the ball back","A defensive wall at free kicks","Time-wasting at corners"],
  correct:0 },

{ id:"epl_066", topic:"epl",
  text:"在Football 'high line'是什么意思defense是positioned?",
  answers:["Closer to midfield","Inside the six-yard box","Behind the goalkeeper"],
  correct:0 },

{ id:"epl_067", topic:"epl",
  text:"在Football 'counterattack'是best defined为?",
  answers:["Fast attack immediately after regaining possession","Slow buildup with many passes","An attack only from corners"],
  correct:0 },

{ id:"epl_068", topic:"epl",
  text:"在Football 'through ball'是intended到?",
  answers:["Split the defense for a runner","Switch play to the other wing","Pass back to the goalkeeper"],
  correct:0 },

{ id:"epl_069", topic:"epl",
  text:"在Football 'switch的play' usually是什么意思?",
  answers:["Moving the ball quickly from one side to the other","Changing the goalkeeper","Stopping the match for injury"],
  correct:0 },

{ id:"epl_072", topic:"epl",
  text:"在Football 'nutmeg'是何时player?",
  answers:["Plays the ball through an opponent’s legs","Scores with a header","Wins a penalty"],
  correct:0 },

{ id:"epl_073", topic:"epl",
  text:"在Football 'panenka' refers到?",
  answers:["Chipped penalty down the middle","Driven free kick","Volley from a cross"],
  correct:0 },

{ id:"epl_074", topic:"epl",
  text:"在Football 'scorpion kick'是type的?",
  answers:["Back-heeled flick/finish","Sliding tackle","Goalkeeper throw"],
  correct:0 },

{ id:"epl_075", topic:"epl",
  text:"在Football 'clean tackle'是什么意思winning ball?",
  answers:["Without committing a foul","Only in the air","Only inside the box"],
  correct:0 },

{ id:"epl_077", topic:"epl",
  text:"在Football 'wall'在football是associated与?",
  answers:["Defending a free kick","Blocking a throw-in","Stopping the clock"],
  correct:0 },


{ id:"epl_079", topic:"epl",
  text:"在Football 'drop ball' restart是used何时play stops为?",
  answers:["A reason not covered by a foul (e.g., injury)","A goal celebration","A substitution"],
  correct:0 },

{ id:"epl_080", topic:"epl",
  text:"Premier League trophy features crown atop?",
  answers:["Lion","Eagle","Dragon"],
  correct:0 },

{ id:"epl_081", topic:"epl",
  text:"Premier League是organized under哪个national association?",
  answers:["The FA","UEFA","FIFA"],
  correct:0 },

{ id:"epl_082", topic:"epl",
  text:"Promotion到Premier League comes来自哪个division directly below?",
  answers:["EFL Championship","EFL League One","National League"],
  correct:0 },

{ id:"epl_083", topic:"epl",
  text:"在Championship, 多少clubs是promoted到Premier League each season?",
  answers:["3","2","4"],
  correct:0 },

{ id:"epl_084", topic:"epl",
  text:"'playoff'在English football usually decides?",
  answers:["The final promotion place","The league champion","Relegation automatically"],
  correct:0 },

{ id:"epl_095", topic:"epl",
  text:"2003–04 'Invincibles' season是associated与?",
  answers:["Arsenal","Chelsea","Man United"],
  correct:0 },

{ id:"epl_096", topic:"epl",
  text:"Leicester City's famous title win happened在哪个season?",
  answers:["2015–16","2016–73","2014–15"],
  correct:0 },

{ id:"epl_097", topic:"epl",
  text:"dramatic 2011–12 title decider是strongly linked与哪个club?",
  answers:["Manchester City","Liverpool","Chelsea"],
  correct:0 },

{ id:"epl_098", topic:"epl",
  text:"在Football 'treble' usually是什么意思winning?",
  answers:["Three major trophies in one season","Three league games in a row","Three goals from corners"],
  correct:0 },
  
  { id:"winners_001", topic:"football",
  text:"Premier League: 谁won在1992/93?",
  answers:["Liverpool", "Manchester United", "Chelsea"],
  correct:1 },
  { id:"winners_002", topic:"football",
  text:"Premier League: 谁won在1993/94?",
  answers:["Manchester United", "Chelsea", "Arsenal"],
  correct:0 },
  { id:"winners_003", topic:"football",
  text:"Premier League: 谁won在1994/95?",
  answers:["Manchester United", "Chelsea", "Blackburn Rovers"],
  correct:2 },
  { id:"winners_004", topic:"football",
  text:"Premier League: 谁won在1995/96?",
  answers:["Manchester United", "Liverpool", "Blackburn Rovers"],
  correct:0 },
  { id:"winners_005", topic:"football",
  text:"Premier League: 谁won在1996/97?",
  answers:["Manchester United", "Liverpool", "Blackburn Rovers"],
  correct:0 },
  { id:"winners_006", topic:"football",
  text:"Premier League: 谁won在1997/98?",
  answers:["Arsenal", "Manchester United", "Manchester City"],
  correct:0 },
  { id:"winners_007", topic:"football",
  text:"Premier League: 谁won在1998/99?",
  answers:["Manchester United", "Blackburn Rovers", "Manchester City"],
  correct:0 },
  { id:"winners_008", topic:"football",
  text:"Premier League: 谁won在1999/00?",
  answers:["Manchester United", "Chelsea", "Manchester City"],
  correct:0 },
  { id:"winners_009", topic:"football",
  text:"Premier League: 谁won在2000/01?",
  answers:["Chelsea", "Manchester United", "Liverpool"],
  correct:1 },
  { id:"winners_010", topic:"football",
  text:"Premier League: 谁won在2001/02?",
  answers:["Arsenal", "Chelsea", "Liverpool"],
  correct:0 },
  { id:"winners_011", topic:"football",
  text:"Premier League: 谁won在2002/03?",
  answers:["Manchester City", "Manchester United", "Arsenal"],
  correct:1 },
  { id:"winners_012", topic:"football",
  text:"Premier League: 谁won在2003/04?",
  answers:["Arsenal", "Manchester City", "Chelsea"],
  correct:0 },
  { id:"winners_013", topic:"football",
  text:"Premier League: 谁won在2004/05?",
  answers:["Chelsea", "Liverpool", "Manchester City"],
  correct:0 },
  { id:"winners_014", topic:"football",
  text:"Premier League: 谁won在2005/06?",
  answers:["Manchester United", "Chelsea", "Manchester City"],
  correct:1 },
  { id:"winners_015", topic:"football",
  text:"Premier League: 谁won在2006/07?",
  answers:["Manchester City", "Manchester United", "Chelsea"],
  correct:1 },
  { id:"winners_016", topic:"football",
  text:"Premier League: 谁won在2007/08?",
  answers:["Manchester City", "Manchester United", "Chelsea"],
  correct:1 },
  { id:"winners_017", topic:"football",
  text:"Premier League: 谁won在2008/09?",
  answers:["Manchester United", "Chelsea", "Leicester City"],
  correct:0 },
  { id:"winners_018", topic:"football",
  text:"Premier League: 谁won在2009/10?",
  answers:["Manchester City", "Chelsea", "Manchester United"],
  correct:1 },
  { id:"winners_019", topic:"football",
  text:"Premier League: 谁won在2010/11?",
  answers:["Manchester United", "Manchester City", "Blackburn Rovers"],
  correct:0 },
  { id:"winners_020", topic:"football",
  text:"Premier League: 谁won在2011/12?",
  answers:["Manchester City", "Chelsea", "Blackburn Rovers"],
  correct:0 },
  { id:"winners_021", topic:"football",
  text:"Premier League: 谁won在2012/13?",
  answers:["Manchester City", "Manchester United", "Arsenal"],
  correct:1 },
  { id:"winners_022", topic:"football",
  text:"Premier League: 谁won在2013/14?",
  answers:["Manchester City", "Arsenal", "Manchester United"],
  correct:0 },
  { id:"winners_023", topic:"football",
  text:"Premier League: 谁won在2014/15?",
  answers:["Chelsea", "Manchester United", "Liverpool"],
  correct:0 },
  { id:"winners_024", topic:"football",
  text:"Premier League: 谁won在2015/16?",
  answers:["Chelsea", "Manchester United", "Leicester City"],
  correct:2 },
  { id:"winners_025", topic:"football",
  text:"Premier League: 谁won在2016/17?",
  answers:["Chelsea", "Arsenal", "Liverpool"],
  correct:0 },
  { id:"winners_026", topic:"football",
  text:"Premier League: 谁won在2017/18?",
  answers:["Manchester City", "Chelsea", "Liverpool"],
  correct:0 },
  { id:"winners_027", topic:"football",
  text:"Premier League: 谁won在2018/19?",
  answers:["Manchester City", "Blackburn Rovers", "Chelsea"],
  correct:0 },
  { id:"winners_028", topic:"football",
  text:"Premier League: 谁won在2019/20?",
  answers:["Liverpool", "Chelsea", "Arsenal"],
  correct:0 },
  { id:"winners_029", topic:"football",
  text:"Premier League: 谁won在2020/21?",
  answers:["Chelsea", "Manchester City", "Liverpool"],
  correct:1 },
  { id:"winners_030", topic:"football",
  text:"Premier League: 谁won在2021/22?",
  answers:["Manchester City", "Chelsea", "Arsenal"],
  correct:0 },
  { id:"winners_031", topic:"football",
  text:"Premier League: 谁won在2022/23?",
  answers:["Chelsea", "Manchester City", "Manchester United"],
  correct:1 },
  { id:"winners_032", topic:"football",
  text:"Premier League: 谁won在2023/24?",
  answers:["Manchester City", "Chelsea", "Liverpool"],
  correct:0 },
  { id:"winners_033", topic:"football",
  text:"Premier League: 谁won在2024/25?",
  answers:["Liverpool", "Manchester United", "Manchester City"],
  correct:0 },

  { id:"winners_034", topic:"football",
  text:"FA Cup: 谁won在1991/92?",
  answers:["Chelsea", "Arsenal", "Liverpool"],
  correct:2 },
  { id:"winners_035", topic:"football",
  text:"FA Cup: 谁won在1992/93?",
  answers:["Liverpool", "Arsenal", "Chelsea"],
  correct:1 },
  { id:"winners_036", topic:"football",
  text:"FA Cup: 谁won在1993/94?",
  answers:["Manchester City", "Manchester United", "Arsenal"],
  correct:1 },
  { id:"winners_037", topic:"football",
  text:"FA Cup: 谁won在1994/95?",
  answers:["Everton", "Manchester United", "Chelsea"],
  correct:0 },
  { id:"winners_038", topic:"football",
  text:"FA Cup: 谁won在1995/96?",
  answers:["Manchester United", "Chelsea", "Liverpool"],
  correct:0 },
  { id:"winners_039", topic:"football",
  text:"FA Cup: 谁won在1996/97?",
  answers:["Arsenal", "Chelsea", "Manchester City"],
  correct:1 },
  { id:"winners_040", topic:"football",
  text:"FA Cup: 谁won在1997/98?",
  answers:["Arsenal", "Chelsea", "Manchester City"],
  correct:0 },
  { id:"winners_041", topic:"football",
  text:"FA Cup: 谁won在1998/99?",
  answers:["Manchester United", "Chelsea", "Arsenal"],
  correct:0 },
  { id:"winners_042", topic:"football",
  text:"FA Cup: 谁won在1999/00?",
  answers:["Manchester United", "Chelsea", "Arsenal"],
  correct:1 },
  { id:"winners_043", topic:"football",
  text:"FA Cup: 谁won在2000/01?",
  answers:["Liverpool", "Chelsea", "Manchester United"],
  correct:0 },
  { id:"winners_044", topic:"football",
  text:"FA Cup: 谁won在2001/02?",
  answers:["Chelsea", "Arsenal", "Manchester United"],
  correct:1 },
  { id:"winners_045", topic:"football",
  text:"FA Cup: 谁won在2002/03?",
  answers:["Arsenal", "Chelsea", "Manchester City"],
  correct:0 },
  { id:"winners_046", topic:"football",
  text:"FA Cup: 谁won在2003/04?",
  answers:["Manchester City", "Manchester United", "Chelsea"],
  correct:1 },
  { id:"winners_047", topic:"football",
  text:"FA Cup: 谁won在2004/05?",
  answers:["Arsenal", "Chelsea", "Everton"],
  correct:0 },
  { id:"winners_048", topic:"football",
  text:"FA Cup: 谁won在2005/06?",
  answers:["Manchester United", "Liverpool", "Arsenal"],
  correct:1 },
  { id:"winners_049", topic:"football",
  text:"FA Cup: 谁won在2006/07?",
  answers:["Chelsea", "Liverpool", "Manchester City"],
  correct:0 },
  { id:"winners_050", topic:"football",
  text:"FA Cup: 谁won在2007/08?",
  answers:["Portsmouth", "Manchester United", "Liverpool"],
  correct:0 },
  { id:"winners_051", topic:"football",
  text:"FA Cup: 谁won在2008/09?",
  answers:["Chelsea", "Arsenal", "Manchester United"],
  correct:0 },
  { id:"winners_052", topic:"football",
  text:"FA Cup: 谁won在2009/10?",
  answers:["Manchester United", "Chelsea", "Arsenal"],
  correct:1 },
  { id:"winners_053", topic:"football",
  text:"FA Cup: 谁won在2010/11?",
  answers:["Manchester City", "Chelsea", "Manchester United"],
  correct:0 },
  { id:"winners_054", topic:"football",
  text:"FA Cup: 谁won在2011/12?",
  answers:["Chelsea", "Manchester United", "Liverpool"],
  correct:0 },
  { id:"winners_055", topic:"football",
  text:"FA Cup: 谁won在2012/13?",
  answers:["Crystal Palace", "Wigan Athletic", "Everton"],
  correct:1 },
  { id:"winners_056", topic:"football",
  text:"FA Cup: 谁won在2013/14?",
  answers:["Liverpool", "Arsenal", "Chelsea"],
  correct:1 },
  { id:"winners_057", topic:"football",
  text:"FA Cup: 谁won在2014/15?",
  answers:["Arsenal", "Manchester United", "Manchester City"],
  correct:0 },
  { id:"winners_058", topic:"football",
  text:"FA Cup: 谁won在2015/16?",
  answers:["Manchester United", "Liverpool", "Manchester City"],
  correct:0 },
  { id:"winners_059", topic:"football",
  text:"FA Cup: 谁won在2016/17?",
  answers:["Arsenal", "Chelsea", "Manchester United"],
  correct:0 },
  { id:"winners_060", topic:"football",
  text:"FA Cup: 谁won在2017/18?",
  answers:["Liverpool", "Manchester United", "Chelsea"],
  correct:2 },
  { id:"winners_061", topic:"football",
  text:"FA Cup: 谁won在2018/19?",
  answers:["Manchester City", "Chelsea", "Arsenal"],
  correct:0 },
  { id:"winners_062", topic:"football",
  text:"FA Cup: 谁won在2019/20?",
  answers:["Liverpool", "Manchester United", "Arsenal"],
  correct:2 },
  { id:"winners_063", topic:"football",
  text:"FA Cup: 谁won在2020/21?",
  answers:["Leicester City", "Manchester City", "Liverpool"],
  correct:0 },
  { id:"winners_064", topic:"football",
  text:"FA Cup: 谁won在2021/22?",
  answers:["Liverpool", "Manchester City", "Chelsea"],
  correct:0 },
  { id:"winners_065", topic:"football",
  text:"FA Cup: 谁won在2022/23?",
  answers:["Manchester City", "Manchester United", "Chelsea"],
  correct:0 },
  { id:"winners_066", topic:"football",
  text:"FA Cup: 谁won在2023/24?",
  answers:["Manchester United", "Manchester City", "Arsenal"],
  correct:0 },
  { id:"winners_067", topic:"football",
  text:"FA Cup: 谁won在2024/25?",
  answers:["Crystal Palace", "Manchester City", "Chelsea"],
  correct:0 },

  { id:"winners_068", topic:"football",
  text:"UEFA Champions League: 谁won在1992/93?",
  answers:["Marseille", "Inter Milan", "Borussia Dortmund"],
  correct:0 },
  { id:"winners_069", topic:"football",
  text:"UEFA Champions League: 谁won在1993/94?",
  answers:["AC Milan", "Bayern Munich", "Barcelona"],
  correct:0 },
  { id:"winners_070", topic:"football",
  text:"UEFA Champions League: 谁won在1994/95?",
  answers:["Ajax", "AC Milan", "Bayern Munich"],
  correct:0 },
  { id:"winners_071", topic:"football",
  text:"UEFA Champions League: 谁won在1995/96?",
  answers:["Juventus", "Marseille", "Manchester United"],
  correct:0 },
  { id:"winners_072", topic:"football",
  text:"UEFA Champions League: 谁won在1996/97?",
  answers:["Manchester United", "Borussia Dortmund", "Real Madrid"],
  correct:1 },
  { id:"winners_073", topic:"football",
  text:"UEFA Champions League: 谁won在1997/98?",
  answers:["Real Madrid", "Liverpool", "AC Milan"],
  correct:0 },
  { id:"winners_074", topic:"football",
  text:"UEFA Champions League: 谁won在1998/99?",
  answers:["Manchester United", "Juventus", "Real Madrid"],
  correct:0 },
  { id:"winners_075", topic:"football",
  text:"UEFA Champions League: 谁won在1999/00?",
  answers:["Real Madrid", "Juventus", "Chelsea"],
  correct:0 },
  { id:"winners_076", topic:"football",
  text:"UEFA Champions League: 谁won在2000/01?",
  answers:["Bayern Munich", "Manchester United", "Juventus"],
  correct:0 },
  { id:"winners_077", topic:"football",
  text:"UEFA Champions League: 谁won在2001/02?",
  answers:["Real Madrid", "Juventus", "Chelsea"],
  correct:0 },
  { id:"winners_078", topic:"football",
  text:"UEFA Champions League: 谁won在2002/03?",
  answers:["AC Milan", "Barcelona", "Liverpool"],
  correct:0 },
  { id:"winners_079", topic:"football",
  text:"UEFA Champions League: 谁won在2003/04?",
  answers:["Porto", "Barcelona", "Manchester United"],
  correct:0 },
  { id:"winners_080", topic:"football",
  text:"UEFA Champions League: 谁won在2004/05?",
  answers:["Bayern Munich", "Liverpool", "AC Milan"],
  correct:1 },
  { id:"winners_081", topic:"football",
  text:"UEFA Champions League: 谁won在2005/06?",
  answers:["Barcelona", "Chelsea", "Bayern Munich"],
  correct:0 },
  { id:"winners_082", topic:"football",
  text:"UEFA Champions League: 谁won在2006/07?",
  answers:["AC Milan", "Chelsea", "Bayern Munich"],
  correct:0 },
  { id:"winners_083", topic:"football",
  text:"UEFA Champions League: 谁won在2007/08?",
  answers:["Manchester United", "Inter Milan", "Juventus"],
  correct:0 },
  { id:"winners_084", topic:"football",
  text:"UEFA Champions League: 谁won在2008/09?",
  answers:["Barcelona", "Inter Milan", "Manchester United"],
  correct:0 },
  { id:"winners_085", topic:"football",
  text:"UEFA Champions League: 谁won在2009/10?",
  answers:["Inter Milan", "Juventus", "AC Milan"],
  correct:0 },
  { id:"winners_086", topic:"football",
  text:"UEFA Champions League: 谁won在2010/11?",
  answers:["Barcelona", "Real Madrid", "Manchester United"],
  correct:0 },
  { id:"winners_087", topic:"football",
  text:"UEFA Champions League: 谁won在2011/12?",
  answers:["Chelsea", "Borussia Dortmund", "Bayern Munich"],
  correct:0 },
  { id:"winners_088", topic:"football",
  text:"UEFA Champions League: 谁won在2012/13?",
  answers:["Bayern Munich", "Barcelona", "Real Madrid"],
  correct:0 },
  { id:"winners_089", topic:"football",
  text:"UEFA Champions League: 谁won在2013/14?",
  answers:["Real Madrid", "Paris Saint-Germain", "Liverpool"],
  correct:0 },
  { id:"winners_090", topic:"football",
  text:"UEFA Champions League: 谁won在2014/15?",
  answers:["Barcelona", "Chelsea", "Inter Milan"],
  correct:0 },
  { id:"winners_091", topic:"football",
  text:"UEFA Champions League: 谁won在2015/16?",
  answers:["Juventus", "Real Madrid", "AC Milan"],
  correct:1 },
  { id:"winners_092", topic:"football",
  text:"UEFA Champions League: 谁won在2016/17?",
  answers:["Real Madrid", "Barcelona", "Bayern Munich"],
  correct:0 },
  { id:"winners_093", topic:"football",
  text:"UEFA Champions League: 谁won在2017/18?",
  answers:["Real Madrid", "Chelsea", "Bayern Munich"],
  correct:0 },
  { id:"winners_094", topic:"football",
  text:"UEFA Champions League: 谁won在2018/19?",
  answers:["Bayern Munich", "Liverpool", "Chelsea"],
  correct:1 },
  { id:"winners_095", topic:"football",
  text:"UEFA Champions League: 谁won在2019/20?",
  answers:["Bayern Munich", "Chelsea", "Barcelona"],
  correct:0 },
  { id:"winners_096", topic:"football",
  text:"UEFA Champions League: 谁won在2020/21?",
  answers:["Chelsea", "AC Milan", "Barcelona"],
  correct:0 },
  { id:"winners_097", topic:"football",
  text:"UEFA Champions League: 谁won在2021/22?",
  answers:["Real Madrid", "Bayern Munich", "Juventus"],
  correct:0 },
  { id:"winners_098", topic:"football",
  text:"UEFA Champions League: 谁won在2022/23?",
  answers:["Manchester City", "Chelsea", "Liverpool"],
  correct:0 },
  { id:"winners_099", topic:"football",
  text:"UEFA Champions League: 谁won在2023/24?",
  answers:["Real Madrid", "Chelsea", "Manchester United"],
  correct:0 },
  { id:"winners_100", topic:"football",
  text:"UEFA Champions League: 谁won在2024/25?",
  answers:["Paris Saint-Germain", "Real Madrid", "Manchester United"],
  correct:0 },

{ id:"inventions_001", topic:"inventions",
  text:"谁是(通常被认为)与inventing telephone?",
  answers:["Alexander Graham Bell", "Thomas Edison", "Nikola Tesla"],
  correct:0 },
{ id:"inventions_002", topic:"inventions",
  text:"谁是(通常被认为)与inventing light bulb为实用用途?",
  answers:["Thomas Edison", "Alexander Graham Bell", "James Watt"],
  correct:0 },
{ id:"inventions_003", topic:"inventions",
  text:"谁发明了World Wide Web?",
  answers:["Tim Berners-Lee", "Bill Gates", "Steve Jobs"],
  correct:0 },
{ id:"inventions_004", topic:"inventions",
  text:"谁是credited与inventing airplane?",
  answers:["The Wright brothers", "The Montgolfier brothers", "Henry Ford"],
  correct:0 },
{ id:"inventions_005", topic:"inventions",
  text:"谁是credited与inventing printing press?",
  answers:["Johannes Gutenberg", "Leonardo da Vinci", "Galileo Galilei"],
  correct:0 },
{ id:"inventions_006", topic:"inventions",
  text:"谁发明了steam engine improvements that helped power Industrial Revolution?",
  answers:["James Watt", "Isaac Newton", "Michael Faraday"],
  correct:0 },
{ id:"inventions_007", topic:"inventions",
  text:"谁发明了telephone's predecessor, telegraph,在widely taught history?",
  answers:["Samuel Morse", "Guglielmo Marconi", "Alexander Fleming"],
  correct:0 },
{ id:"inventions_008", topic:"inventions",
  text:"谁是(通常被认为)与inventing radio?",
  answers:["Guglielmo Marconi", "Alexander Graham Bell", "Wright brothers"],
  correct:0 },
{ id:"inventions_009", topic:"inventions",
  text:"谁发明了phonograph?",
  answers:["Thomas Edison", "Nikola Tesla", "Benjamin Franklin"],
  correct:0 },
{ id:"inventions_010", topic:"inventions",
  text:"谁发明了diesel engine?",
  answers:["Rudolf Diesel", "Karl Benz", "Henry Ford"],
  correct:0 },

{ id:"inventions_011", topic:"inventions",
  text:"谁是credited与inventing第一个实用automobile powered按internal combustion engine?",
  answers:["Karl Benz", "Rudolf Diesel", "Henry Ford"],
  correct:0 },
{ id:"inventions_012", topic:"inventions",
  text:"谁popularized mass car production与assembly line?",
  answers:["Henry Ford", "Karl Benz", "Enzo Ferrari"],
  correct:0 },
{ id:"inventions_013", topic:"inventions",
  text:"谁发明了第一个successful vaccine为smallpox?",
  answers:["Edward Jenner", "Louis Pasteur", "Alexander Fleming"],
  correct:0 },
{ id:"inventions_014", topic:"inventions",
  text:"谁发现了penicillin?",
  answers:["Alexander Fleming", "Louis Pasteur", "Joseph Lister"],
  correct:0 },
{ id:"inventions_015", topic:"inventions",
  text:"谁发明了pasteurization process?",
  answers:["Louis Pasteur", "Edward Jenner", "Robert Koch"],
  correct:0 },
{ id:"inventions_016", topic:"inventions",
  text:"谁发明了第一个mechanical television system?",
  answers:["John Logie Baird", "Tim Berners-Lee", "Nikola Tesla"],
  correct:0 },
{ id:"inventions_017", topic:"inventions",
  text:"谁发明了electric battery?",
  answers:["Alessandro Volta", "Michael Faraday", "James Clerk Maxwell"],
  correct:0 },
{ id:"inventions_018", topic:"inventions",
  text:"volt是named after哪个发明者?",
  answers:["Alessandro Volta", "Andre-Marie Ampere", "Nikola Tesla"],
  correct:0 },
{ id:"inventions_019", topic:"inventions",
  text:"谁发明了第一个实用alternating current motor system?",
  answers:["Nikola Tesla", "Thomas Edison", "James Watt"],
  correct:0 },
{ id:"inventions_020", topic:"inventions",
  text:"谁是(通常被认为)与inventing lightning rod?",
  answers:["Benjamin Franklin", "Thomas Edison", "Galileo Galilei"],
  correct:0 },

{ id:"inventions_021", topic:"inventions",
  text:"谁发明了safety elevator brake system?",
  answers:["Elisha Otis", "James Watt", "George Stephenson"],
  correct:0 },
{ id:"inventions_022", topic:"inventions",
  text:"谁发明了sewing machine (以常见形式) most (通常被认为)在history quizzes?",
  answers:["Elias Howe", "Isaac Singer", "Thomas Edison"],
  correct:0 },
{ id:"inventions_023", topic:"inventions",
  text:"谁是(强相关于) improving and commercializing sewing machine?",
  answers:["Isaac Singer", "Elias Howe", "Henry Ford"],
  correct:0 },
{ id:"inventions_024", topic:"inventions",
  text:"谁发明了cotton gin?",
  answers:["Eli Whitney", "Samuel Colt", "James Watt"],
  correct:0 },
{ id:"inventions_025", topic:"inventions",
  text:"谁发明了revolver commonly known为Colt revolver?",
  answers:["Samuel Colt", "Eli Whitney", "Hiram Maxim"],
  correct:0 },
{ id:"inventions_026", topic:"inventions",
  text:"谁发明了Maxim machine gun?",
  answers:["Hiram Maxim", "Samuel Colt", "Alfred Nobel"],
  correct:0 },
{ id:"inventions_027", topic:"inventions",
  text:"谁发明了dynamite?",
  answers:["Alfred Nobel", "Hiram Maxim", "Rudolf Diesel"],
  correct:0 },
{ id:"inventions_028", topic:"inventions",
  text:"谁发明了第一个successful steam locomotive?",
  answers:["George Stephenson", "James Watt", "Isambard Kingdom Brunel"],
  correct:0 },
{ id:"inventions_029", topic:"inventions",
  text:"谁发明了jet engine在widely taught British history?",
  answers:["Frank Whittle", "Wright brothers", "John Logie Baird"],
  correct:0 },
{ id:"inventions_030", topic:"inventions",
  text:"谁发明了helicopter (以常见形式) most associated与第一个实用model?",
  answers:["Igor Sikorsky", "Wright brothers", "Guglielmo Marconi"],
  correct:0 },

{ id:"inventions_031", topic:"inventions",
  text:"谁发明了第一个实用parachute design经常credited在Renaissance history?",
  answers:["Leonardo da Vinci", "Galileo Galilei", "Johannes Gutenberg"],
  correct:0 },
{ id:"inventions_032", topic:"inventions",
  text:"谁发明了ballpoint pen most (通常被认为)在modern history?",
  answers:["Laszlo Biro", "Johannes Gutenberg", "Samuel Morse"],
  correct:0 },
{ id:"inventions_033", topic:"inventions",
  text:"谁发明了fountain pen (以常见形式) (通常被认为) 为实用version?",
  answers:["Lewis Waterman", "Laszlo Biro", "Elias Howe"],
  correct:0 },
{ id:"inventions_034", topic:"inventions",
  text:"谁发明了can opener?",
  answers:["Ezra Warner", "Samuel Morse", "Karl Benz"],
  correct:0 },
{ id:"inventions_035", topic:"inventions",
  text:"谁发明了zipper?",
  answers:["Whitcomb Judson", "Elias Howe", "Laszlo Biro"],
  correct:0 },
{ id:"inventions_036", topic:"inventions",
  text:"谁发明了safety razor?",
  answers:["King C. Gillette", "Samuel Colt", "Isaac Singer"],
  correct:0 },
{ id:"inventions_037", topic:"inventions",
  text:"谁发明了vacuum flask, also known为Thermos?",
  answers:["James Dewar", "Alexander Fleming", "Louis Pasteur"],
  correct:0 },
{ id:"inventions_038", topic:"inventions",
  text:"谁发明了Bunsen burner与哪个he是commonly associated?",
  answers:["Robert Bunsen", "Michael Faraday", "James Dewar"],
  correct:0 },
{ id:"inventions_039", topic:"inventions",
  text:"谁发明了实用safety lamp used按miners?",
  answers:["Humphry Davy", "Robert Bunsen", "Alessandro Volta"],
  correct:0 },
{ id:"inventions_040", topic:"inventions",
  text:"谁发明了stethoscope?",
  answers:["Rene Laennec", "Louis Pasteur", "Edward Jenner"],
  correct:0 },

{ id:"inventions_041", topic:"inventions",
  text:"谁发明了第一个successful blood bank concept (通常被认为)在medicine history?",
  answers:["Charles Drew", "Alexander Fleming", "Edward Jenner"],
  correct:0 },
{ id:"inventions_042", topic:"inventions",
  text:"谁发明了第一个实用contact lenses在early form (通常被认为)?",
  answers:["Adolf Fick", "Rene Laennec", "Louis Pasteur"],
  correct:0 },
{ id:"inventions_043", topic:"inventions",
  text:"谁发明了hearing aid在its early electric form (通常被认为)?",
  answers:["Miller Reese Hutchison", "Thomas Edison", "Alexander Graham Bell"],
  correct:0 },
{ id:"inventions_044", topic:"inventions",
  text:"谁发明了第一个实用microwave oven?",
  answers:["Percy Spencer", "Thomas Edison", "Alexander Fleming"],
  correct:0 },
{ id:"inventions_045", topic:"inventions",
  text:"谁发明了第一个dishwasher (通常被认为)在history?",
  answers:["Josephine Cochrane", "Marie Curie", "Ada Lovelace"],
  correct:0 },
{ id:"inventions_046", topic:"inventions",
  text:"谁发明了第一个electric washing machine (通常被认为)?",
  answers:["Alva J. Fisher", "Thomas Edison", "Henry Ford"],
  correct:0 },
{ id:"inventions_047", topic:"inventions",
  text:"谁发明了refrigerator (以常见形式)的第一个实用vapor-compression model (通常被认为)?",
  answers:["Jacob Perkins", "James Watt", "Rudolf Diesel"],
  correct:0 },
{ id:"inventions_048", topic:"inventions",
  text:"谁发明了air conditioner?",
  answers:["Willis Carrier", "James Watt", "Alfred Nobel"],
  correct:0 },
{ id:"inventions_049", topic:"inventions",
  text:"谁发明了electric铁 (通常被认为)在appliance history?",
  answers:["Henry W. Seely", "Thomas Edison", "George Stephenson"],
  correct:0 },
{ id:"inventions_050", topic:"inventions",
  text:"谁发明了toaster (以常见形式)的第一个successful electric model (通常被认为)?",
  answers:["Alan MacMasters", "Percy Spencer", "Willis Carrier"],
  correct:0 },

{ id:"inventions_051", topic:"inventions",
  text:"谁发明了game-changing paper clip design known为Gem-type style (通常与之相关) office用途?",
  answers:["It has no single confirmed inventor", "Thomas Edison", "Alexander Graham Bell"],
  correct:0 },
{ id:"inventions_052", topic:"inventions",
  text:"谁发明了stapler's early实用form most经常credited?",
  answers:["George McGill", "Elias Howe", "Isaac Singer"],
  correct:0 },
{ id:"inventions_053", topic:"inventions",
  text:"谁发明了Scotch tape, (通常与之相关) transparent pressure-sensitive tape?",
  answers:["Richard Drew", "King C. Gillette", "Laszlo Biro"],
  correct:0 },
{ id:"inventions_054", topic:"inventions",
  text:"谁发明了Post-it Note adhesive central到product?",
  answers:["Spencer Silver", "Richard Drew", "Arthur Fry"],
  correct:0 },
{ id:"inventions_055", topic:"inventions",
  text:"谁是most associated与turning Post-it Note into实用office product?",
  answers:["Arthur Fry", "Spencer Silver", "Thomas Edison"],
  correct:0 },
{ id:"inventions_056", topic:"inventions",
  text:"谁发明了calculator (以常见形式)的Pascaline?",
  answers:["Blaise Pascal", "Charles Babbage", "Ada Lovelace"],
  correct:0 },
{ id:"inventions_057", topic:"inventions",
  text:"谁designed Analytical Engine, early concept为general-purpose computer?",
  answers:["Charles Babbage", "Alan Turing", "John von Neumann"],
  correct:0 },
{ id:"inventions_058", topic:"inventions",
  text:"谁是经常被称为world's第一个computer programmer为work在Babbage's machine?",
  answers:["Ada Lovelace", "Grace Hopper", "Hedy Lamarr"],
  correct:0 },
{ id:"inventions_059", topic:"inventions",
  text:"谁开发了concept的Turing machine?",
  answers:["Alan Turing", "Charles Babbage", "Tim Berners-Lee"],
  correct:0 },
{ id:"inventions_060", topic:"inventions",
  text:"谁共同发明了transistor along与John Bardeen and Walter Brattain?",
  answers:["William Shockley", "Alan Turing", "Nikola Tesla"],
  correct:0 },

{ id:"inventions_061", topic:"inventions",
  text:"谁发明了integrated circuit在one的its earliest credited forms?",
  answers:["Jack Kilby", "Bill Gates", "Steve Jobs"],
  correct:0 },
{ id:"inventions_062", topic:"inventions",
  text:"谁是also credited与independently creating integrated circuit在Fairchild?",
  answers:["Robert Noyce", "Jack Kilby", "Alan Turing"],
  correct:0 },
{ id:"inventions_063", topic:"inventions",
  text:"谁发明了computer mouse?",
  answers:["Douglas Engelbart", "Steve Jobs", "Tim Berners-Lee"],
  correct:0 },
{ id:"inventions_064", topic:"inventions",
  text:"谁发明了第一个handheld mobile phone?",
  answers:["Martin Cooper", "Tim Berners-Lee", "Alexander Graham Bell"],
  correct:0 },
{ id:"inventions_065", topic:"inventions",
  text:"谁发明了第一个digital camera prototype?",
  answers:["Steven Sasson", "Douglas Engelbart", "George Eastman"],
  correct:0 },
{ id:"inventions_066", topic:"inventions",
  text:"谁发明了roll film that helped make photography widely accessible?",
  answers:["George Eastman", "Louis Daguerre", "Thomas Edison"],
  correct:0 },
{ id:"inventions_067", topic:"inventions",
  text:"谁是(通常被认为)与inventing daguerreotype photographic process?",
  answers:["Louis Daguerre", "George Eastman", "Tim Berners-Lee"],
  correct:0 },
{ id:"inventions_068", topic:"inventions",
  text:"谁发明了cinema camera and projector system known为Cinematographe?",
  answers:["The Lumiere brothers", "Thomas Edison", "John Logie Baird"],
  correct:0 },
{ id:"inventions_069", topic:"inventions",
  text:"谁发明了实用motion picture camera technology associated与Kinetograph?",
  answers:["Thomas Edison", "The Lumiere brothers", "Tim Berners-Lee"],
  correct:0 },
{ id:"inventions_070", topic:"inventions",
  text:"谁发明了compact disc jointly associated与its development?",
  answers:["Philips and Sony", "Apple and Microsoft", "IBM and Intel"],
  correct:0 },

{ id:"inventions_071", topic:"inventions",
  text:"谁发明了floppy disk (以常见形式) (通常被认为) 按IBM history?",
  answers:["Alan Shugart", "Bill Gates", "Jack Kilby"],
  correct:0 },
{ id:"inventions_072", topic:"inventions",
  text:"谁发明了USB flash drive在attribution most commonly cited在quizzes?",
  answers:["Dov Moran", "Tim Berners-Lee", "Douglas Engelbart"],
  correct:0 },
{ id:"inventions_073", topic:"inventions",
  text:"谁发明了ATM (以常见形式) most (通常被认为)在UK history?",
  answers:["John Shepherd-Barron", "Martin Cooper", "Tim Berners-Lee"],
  correct:0 },
{ id:"inventions_074", topic:"inventions",
  text:"谁发明了barcode在its earliest patented form?",
  answers:["Norman Woodland", "George Eastman", "Alan Shugart"],
  correct:0 },
{ id:"inventions_075", topic:"inventions",
  text:"谁共同发明了QR code为Denso Wave?",
  answers:["Masahiro Hara", "Norman Woodland", "Dov Moran"],
  correct:0 },
{ id:"inventions_076", topic:"inventions",
  text:"谁发明了pacemaker (以常见形式)的第一个implantable实用version (通常被认为)?",
  answers:["Wilson Greatbatch", "Charles Drew", "Rene Laennec"],
  correct:0 },
{ id:"inventions_077", topic:"inventions",
  text:"谁发明了MRI scanner在work (通常与之相关) its development?",
  answers:["Raymond Damadian", "Rene Laennec", "Alexander Fleming"],
  correct:0 },
{ id:"inventions_078", topic:"inventions",
  text:"谁普遍认为其discovering X-rays?",
  answers:["Wilhelm Roentgen", "Louis Pasteur", "Edward Jenner"],
  correct:0 },
{ id:"inventions_079", topic:"inventions",
  text:"谁发明了CAT scan (以常见形式) most (通常被认为)?",
  answers:["Godfrey Hounsfield", "Wilhelm Roentgen", "Raymond Damadian"],
  correct:0 },
{ id:"inventions_080", topic:"inventions",
  text:"谁发明了modern hypodermic syringe (以常见形式) (通常被认为)?",
  answers:["Alexander Wood", "Rene Laennec", "Charles Drew"],
  correct:0 },

{ id:"inventions_081", topic:"inventions",
  text:"谁发明了Braille?",
  answers:["Louis Braille", "Helen Keller", "Samuel Morse"],
  correct:0 },
{ id:"inventions_082", topic:"inventions",
  text:"谁发明了第一个实用typewriter (通常被认为)?",
  answers:["Christopher Latham Sholes", "Johannes Gutenberg", "Blaise Pascal"],
  correct:0 },
{ id:"inventions_083", topic:"inventions",
  text:"谁发明了Linotype machine?",
  answers:["Ottmar Mergenthaler", "Johannes Gutenberg", "Christopher Latham Sholes"],
  correct:0 },
{ id:"inventions_084", topic:"inventions",
  text:"谁发明了escalator (以常见形式) most (通常被认为)?",
  answers:["Jesse W. Reno", "Elisha Otis", "George Stephenson"],
  correct:0 },
{ id:"inventions_085", topic:"inventions",
  text:"谁发明了shopping cart?",
  answers:["Sylvan Goldman", "Henry Ford", "Whitcomb Judson"],
  correct:0 },
{ id:"inventions_086", topic:"inventions",
  text:"谁发明了supermarket barcode scanner system concept most (强相关于) retail adoption?",
  answers:["It was developed by multiple engineers and companies", "Thomas Edison", "Alexander Graham Bell"],
  correct:0 },
{ id:"inventions_087", topic:"inventions",
  text:"谁发明了第一个实用traffic light?",
  answers:["J. P. Knight", "Karl Benz", "George Stephenson"],
  correct:0 },
{ id:"inventions_088", topic:"inventions",
  text:"谁发明了windshield wiper?",
  answers:["Mary Anderson", "Josephine Cochrane", "Ada Lovelace"],
  correct:0 },
{ id:"inventions_089", topic:"inventions",
  text:"谁发明了Kevlar?",
  answers:["Stephanie Kwolek", "Marie Curie", "Josephine Cochrane"],
  correct:0 },
{ id:"inventions_090", topic:"inventions",
  text:"谁共同发明了frequency-hopping technology that contributed到modern wireless communication?",
  answers:["Hedy Lamarr", "Ada Lovelace", "Grace Hopper"],
  correct:0 },

{ id:"inventions_091", topic:"inventions",
  text:"谁开发了COBOL and是经常associated与early software innovation?",
  answers:["Grace Hopper", "Ada Lovelace", "Hedy Lamarr"],
  correct:0 },
{ id:"inventions_092", topic:"inventions",
  text:"谁发明了第一个实用mechanical calculator known为Step Reckoner?",
  answers:["Gottfried Wilhelm Leibniz", "Blaise Pascal", "Charles Babbage"],
  correct:0 },
{ id:"inventions_093", topic:"inventions",
  text:"谁发明了Gregorian calendar reform (广泛与之相关) its adoption?",
  answers:["Pope Gregory XIII", "Julius Caesar", "Johannes Gutenberg"],
  correct:0 },
{ id:"inventions_094", topic:"inventions",
  text:"谁发明了第一个实用submarine (以常见形式) most (通常被认为)在early engineering history?",
  answers:["Cornelis Drebbel", "Igor Sikorsky", "Frank Whittle"],
  correct:0 },
{ id:"inventions_095", topic:"inventions",
  text:"谁发明了第一个successful repeating mechanical clock escapement (通常与之相关) medieval欧洲?",
  answers:["It emerged through gradual development by multiple inventors", "Galileo Galilei", "Isaac Newton"],
  correct:0 },
{ id:"inventions_096", topic:"inventions",
  text:"谁发明了vulcanized rubber?",
  answers:["Charles Goodyear", "King C. Gillette", "Eli Whitney"],
  correct:0 },
{ id:"inventions_097", topic:"inventions",
  text:"谁发明了第一个实用plastic known为Bakelite?",
  answers:["Leo Baekeland", "Charles Goodyear", "Alfred Nobel"],
  correct:0 },
{ id:"inventions_098", topic:"inventions",
  text:"谁发明了第一个successful mechanical reaper?",
  answers:["Cyrus McCormick", "Eli Whitney", "Henry Ford"],
  correct:0 },
{ id:"inventions_099", topic:"inventions",
  text:"谁发明了combine harvester在its earliest forms through gradual development most (通常与之相关) 哪个type的origin?",
  answers:["It was developed over time by multiple inventors", "Henry Ford alone", "Thomas Edison alone"],
  correct:0 },
{ id:"inventions_100", topic:"inventions",
  text:"谁发明了chainsaw's earliest medical predecessor concept?",
  answers:["John Aitken and James Jeffray", "Samuel Colt and Eli Whitney", "The Wright brothers"],
  correct:0 }

];




let quizActive = false;


/** @type {{ id:string, topic:string, text:string, answers:string[], correct:number }[]} */
let currentRound = [];


let qIndex = -1;


let questionDeadline = 0;


let nextQuestionAt = 0;


let questionStartTime = 0;


let answersOpen = false;


/** @type {Map<number,{choice:number,t:number}>[]} */
let answersPerQuestion = [];


let humanScore  = 0;  
let zombieScore = 0;  

let pendingMvpAnnounce = false;
let mvpAnnounceAt = 0;

let announceAt = 0;
let pendingAnnounce = false;



function now() { return Instance.GetGameTime(); }

function say(text) {
  try { Instance.ServerCommand(`say ${text}`); } catch {}
}

function incMap(map, k, n = 1) {
  map.set(k, (map.get(k) || 0) + n);
}

function resetMvpMaps() {
  mvpCorrect_CT.clear();
  mvpCorrect_T.clear();
}

function abortQuiz(reason = "Round ended") {
  quizActive = false;
  answersOpen = false;
  questionDeadline = 0;
  nextQuestionAt = 0;
  questionStartTime = 0;
  qIndex = -1;
  currentRound = [];
  answersPerQuestion = [];

  
  setWT(WT_Q, "");
  setWT(WT_A, "");
  setWT(WT_B, "");
  setWT(WT_C, "");
}

function ctlFromAny(ent) {
  try {
    if (!ent) return undefined;
    if (ent.GetPlayerSlot && ent.GetPlayerName && ent.GetPlayerPawn) return ent;
    if (ent.GetOriginalPlayerController || ent.GetPlayerController) {
      const c = ent.GetOriginalPlayerController?.() ?? ent.GetPlayerController?.();
      if (c && c.GetPlayerSlot) return c;
    }
    if (ent.GetOwner) {
      const own = ent.GetOwner();
      if (own) return ctlFromAny(own);
    }
  } catch {}
  return undefined;
}

function slotOfCtl(ctl) {
  try { return ctl?.GetPlayerSlot?.() ?? -1; } catch { return -1; }
}

function teamOfCtl(ctl) {
  try { return ctl?.GetTeamNumber?.() ?? -1; } catch { return -1; }
}

function nameOfCtl(ctl) {
  try { return ctl?.GetPlayerName?.() ?? "player"; } catch { return "player"; }
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function eByName(name) {
  const e = Instance.FindEntityByName(name);
  return e && e.IsValid && e.IsValid() ? e : undefined;
}

function setWT(name, msg) {
  const e = eByName(name);
  if (!e) return false;
  Instance.EntFireAtTarget({ target: e, input: "SetMessage", value: msg });
  Instance.EntFireAtTarget({ target: e, input: "TurnOn" });
  return true;
}

function hash3(s) {
  
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
  h = Math.abs(h);
  return h % 3;
}

function rotate3(arr, k) {
  
  return [arr[k % 3], arr[(k + 1) % 3], arr[(k + 2) % 3]];
}


function diversifyABC(round) {
  for (const q of round) {
    const id = String(q.id || q.text || "");
    const k = hash3(id); 
    if (!Array.isArray(q.answers) || q.answers.length !== 3) continue;
    if (typeof q.correct !== "number" || q.correct < 0 || q.correct > 2) q.correct = 0;

    
    const oldAnswers = q.answers;
    const oldCorrect = q.correct;
    q.answers = rotate3(oldAnswers, k);

    
    q.correct = (oldCorrect - k + 3) % 3;
  }
}




function resetQuizState() {
  quizActive       = false;
  currentRound     = [];
  qIndex           = -1;
  questionDeadline = 0;
  nextQuestionAt   = 0;
  questionStartTime = 0;
  answersOpen      = false;
  answersPerQuestion = [];
  humanScore       = 0;
  zombieScore      = 0;
  pendingMvpAnnounce = false;
  mvpAnnounceAt = 0;
  pendingAnnounce = false;
  announceAt = 0;
  STATS.forEach((s) => {
    s.sd_answered = 0;
    s.sd_correct = 0;
    s.sd_wrong = 0;
    s.sd_correctTimeSum = 0;
    s.sd_correctTimeN = 0;
  });
  
  setWT(WT_Q, "");
  setWT(WT_A, "");
  setWT(WT_B, "");
  setWT(WT_C, "");
  setWT(WT_HSCORE, "H:0");
  setWT(WT_ZSCORE, "Z:0");
  setWT(WT_STATUS, "");
}

function startQuizRound() {
  if (QUESTION_BANK.length < QUIZ_QUESTIONS_PER_ROUND) {
    say("[QUIZ] Not enough questions in bank.");
    return;
  }

  resetQuizState();
  quizActive = true;
  phase = PHASE_SHOWDOWN;

  resetMvpMaps();

  
  const all = QUESTION_BANK.slice();
  shuffleInPlace(all);
  currentRound = all.slice(0, QUIZ_QUESTIONS_PER_ROUND);

  diversifyABC(currentRound);

  answersPerQuestion = [];
  for (let i = 0; i < currentRound.length; i++) {
    answersPerQuestion[i] = new Map();
  }

  say("Showdown starting...");
  kickThink();
  startNextQuestion();
}

function startNextQuestion() {
  qIndex++;

  if (qIndex >= currentRound.length) {
    endQuiz();
    return;
  }

  const q = currentRound[qIndex];

  
  setWT(WT_Q, `Q${qIndex+1}/${currentRound.length}: ${q.text}`);
  setWT(WT_A, `A) ${q.answers[0] || ""}`);
  setWT(WT_B, `B) ${q.answers[1] || ""}`);
  setWT(WT_C, `C) ${q.answers[2] || ""}`);

  
  setWT(WT_STATUS, `Question ${qIndex+1}/${currentRound.length}`);

  
  answersPerQuestion[qIndex].clear();

  answersOpen = true;
  questionStartTime = now();
  questionDeadline = questionStartTime + QUIZ_ANSWER_TIME;
  nextQuestionAt = 0;

  say(`[SHOWDOWN] Question ${qIndex+1} started.`);
}

function closeCurrentQuestion() {
  if (!quizActive || !answersOpen || qIndex < 0 || qIndex >= currentRound.length) return;
  answersOpen = false;
  const q = currentRound[qIndex];
  const answersMap = answersPerQuestion[qIndex];

  let ctCorrectCount = 0;
  let tCorrectCount  = 0;

  
  answersMap.forEach((entry, slot) => {
    const choice = (typeof entry === "object" && entry !== null) ? entry.choice : entry;
    const answeredAt = (typeof entry === "object" && entry !== null && typeof entry.t === "number")
      ? entry.t
      : Math.max(0, now() - questionStartTime);

    const ctl = Instance.GetPlayerController(slot);
    if (!ctl || !ctl.IsValid || !ctl.IsValid()) return;

    const team = teamOfCtl(ctl);
    const stats = S(slot);
    stats.sd_answered++;

    if (choice === q.correct) {
      stats.sd_correct++;
      stats.sd_correctTimeSum += answeredAt;
      stats.sd_correctTimeN += 1;

      if (team === TEAM_CT) {
        ctCorrectCount++;
        incMap(mvpCorrect_CT, slot, 1);
      } else if (team === TEAM_T) {
        tCorrectCount++;
        incMap(mvpCorrect_T, slot, 1);
      }
    } else {
      stats.sd_wrong++;
    }
  });

  const humanGain  = ctCorrectCount * HUMAN_POINTS_PER_PLAYER;
  const zombieGain = tCorrectCount  * ZOMBIE_POINTS_PER_PLAYER;

  humanScore  += humanGain;
  zombieScore += zombieGain;

  setWT(WT_HSCORE, `H:${humanScore}`);
  setWT(WT_ZSCORE, `Z:${zombieScore}`);

  
  const letters = ["A", "B", "C"];
  const correctLetter = letters[q.correct] || "?";
  say(`[SHOWDOWN] Correct answer: ${correctLetter}. Humans +${humanGain}, Zombies +${zombieGain}.`);

  if (qIndex >= currentRound.length - 1) {
  endQuiz();
} else {

  
  nextQuestionAt = now() + QUIZ_GAP_BETWEEN;
}
}

function endQuiz() {
  quizActive       = false;
  answersOpen      = false;
  questionDeadline = 0;
  nextQuestionAt   = 0;

  
  let resultText;
  if (humanScore > zombieScore) {
    resultText = `Humans win! H:${humanScore} Z:${zombieScore}`;
  } else if (zombieScore > humanScore) {
    resultText = `Zombies win! H:${humanScore} Z:${zombieScore}`;
  } else {
    resultText = `Draw! H:${humanScore} Z:${zombieScore}`;
  }

  setWT(WT_STATUS, resultText);
  say(`[SHOWDOWN] ${resultText}`);

  
  if (humanScore > zombieScore) {
    Instance.EntFireAtName({ name: "rl_humans_win", input: "Trigger" });
  } else if (zombieScore > humanScore) {
    Instance.EntFireAtName({ name: "rl_zombies_win", input: "Trigger" });
  } else {
    Instance.EntFireAtName({ name: "rl_quiz_tie", input: "Trigger" });
  }

  phase = PHASE_FINISHED;
  mvpAnnounceAt = now() + 4.0;
  pendingMvpAnnounce = true;

}

function getMvpFromMap(map) {
  let bestSlot = -1;
  let bestScore = -1;

  map.forEach((score, slot) => {
    if (score > bestScore) {
      bestScore = score;
      bestSlot = slot;
    }
  });

  if (bestSlot < 0) return null;

  const ctl = Instance.GetPlayerController(bestSlot);
  const name = ctl?.GetPlayerName?.() || "Unknown";
  return { slot: bestSlot, name, score: bestScore };
}

function announceMvps() {
  pendingMvpAnnounce = false;

  const mvpH = getMvpFromMap(mvpCorrect_CT);
  const mvpZ = getMvpFromMap(mvpCorrect_T);
  lastShowdownMvps = { human: mvpH, zombie: mvpZ };

  if (mvpH) {
    say(`[SHOWDOWN][MVP] Humans MVP: ${mvpH.name} - ${mvpH.score} correct`);
  } else {
    say("[SHOWDOWN][MVP] Humans MVP: none");
  }

  if (mvpZ) {
    say(`[SHOWDOWN][MVP] Zombies MVP: ${mvpZ.name} — ${mvpZ.score} correct`);
  } else {
    say("[SHOWDOWN][MVP] Zombies MVP: none");
  }

  announceFinalAwards(mvpH, mvpZ);
}



function registerAnswer(team, choiceIndex, activator) {
  if (phase !== PHASE_SHOWDOWN) return;
  if (!quizActive || !answersOpen) return;
  if (qIndex < 0 || qIndex >= currentRound.length) return;
  if (choiceIndex < 0 || choiceIndex > 2) return;

  const ctl = ctlFromAny(activator);
  if (!ctl) return;

  const slot = slotOfCtl(ctl);
  if (slot < 0) return;

  const t = teamOfCtl(ctl);
  if (t !== team) return; 

  const answersMap = answersPerQuestion[qIndex];
  if (answersMap.has(slot)) return; 

  const answeredAt = Math.max(0, now() - questionStartTime);
  answersMap.set(slot, { choice: choiceIndex, t: answeredAt });

  if (QUIZ_DEBUG_OVERLAY) {
    const pname = nameOfCtl(ctl);
    say(`[QUIZ][debug] ${pname} answered ${["A","B","C"][choiceIndex] || "?"} on Q${qIndex+1}`);
  }
}



tickShowdown = function(tInput) {
  const t = typeof tInput === "number" ? tInput : now();

  if (pendingMvpAnnounce && t >= mvpAnnounceAt) {
    announceMvps();
  }

  if (pendingAnnounce && now() >= announceAt) {
    say("[SHOWDOWN LOADED]");
    pendingAnnounce = false;
  }

  if (quizActive) {
    
    if (answersOpen && t >= questionDeadline) {
      closeCurrentQuestion();
    }

    
    if (!answersOpen && nextQuestionAt > 0 && t >= nextQuestionAt) {
      startNextQuestion();
    }
  }

  
  if (QUIZ_DEBUG_OVERLAY) {
    Instance.DebugScreenText({
      text: `[QUIZ] active:${quizActive} qIdx:${qIndex} open:${answersOpen}`,
      x: 2, y: 80, duration: 0.15,
      color: { r: 150, g: 220, b: 255, a: 255 }
    });
  }
};



Instance.OnScriptInput("QUIZ_Start", () => {
  if (phase === PHASE_FINISHED) return;
  if (quizActive) {
    say("[QUIZ] Already running.");
    return;
  }
  phase = PHASE_SHOWDOWN;
  startQuizRound();
  kickThink();

});

Instance.OnScriptInput("QUIZ_Abort", () => {
  say("[QUIZ] Aborted.");
  resetQuizState();
  phase = PHASE_QUIZROOMS;
});

Instance.OnScriptInput("QUIZ_Reset", () => {
  resetQuizState();
  phase = PHASE_QUIZROOMS;
});

Instance.OnRoundEnd(() => {
  abortQuiz("Round ended");
  phase = PHASE_FINISHED;
});

Instance.OnRoundStart(() => {
  
  abortQuiz("New round");
  phase = PHASE_QUIZROOMS;
});



Instance.OnScriptInput("CT_A", ({ activator }) => {
  registerAnswer(TEAM_CT, 0, activator);
});
Instance.OnScriptInput("CT_B", ({ activator }) => {
  registerAnswer(TEAM_CT, 1, activator);
});
Instance.OnScriptInput("CT_C", ({ activator }) => {
  registerAnswer(TEAM_CT, 2, activator);
});

Instance.OnScriptInput("T_A", ({ activator }) => {
  registerAnswer(TEAM_T, 0, activator);
});
Instance.OnScriptInput("T_B", ({ activator }) => {
  registerAnswer(TEAM_T, 1, activator);
});
Instance.OnScriptInput("T_C", ({ activator }) => {
  registerAnswer(TEAM_T, 2, activator);
});



Instance.OnScriptInput("QUIZ_DebugFakeStart", () => {
  say("[QUIZ] Debug: starting with current bank.");
  startQuizRound();
});

Instance.OnScriptInput("QUIZ_Next", () => {
  
  if (!quizActive) return;
  if (answersOpen) {
    closeCurrentQuestion();
  } else {
    startNextQuestion();
  }
});



Instance.OnActivate(() => {
  resetQuizState();
  announceAt = now() + 3.0;
  pendingAnnounce = true;
});
})();

function buildCombinedAwards() {
  let brainGod = null;
  let liability = null;
  let fastest = null;

  STATS.forEach((s, slot) => {
    const answered = s.qr_answered + s.sd_answered;
    if (answered <= 0) return;

    const correct = s.qr_correct + s.sd_correct;
    const wrong = s.qr_wrong + s.sd_wrong;
    const timeSum = s.qr_correctTimeSum + s.sd_correctTimeSum;
    const timeN = s.qr_correctTimeN + s.sd_correctTimeN;
    const avgTime = timeN > 0 ? (timeSum / timeN) : null;

    if (!brainGod || correct > brainGod.val) brainGod = { slot, val: correct };
    if (answered >= 3 && (!liability || wrong > liability.val)) liability = { slot, val: wrong };
    if (avgTime !== null && (!fastest || avgTime < fastest.val)) fastest = { slot, val: avgTime };
  });

  return { brainGod, liability, fastest };
}

function announceFinalAwards(mvpH, mvpZ) {
  const combined = buildCombinedAwards();
  const quizAwards = typeof getQuizAwards === "function" ? getQuizAwards() : null;

  say("[FINAL] === Combined awards ===");

  if (mvpH) {
    setText("wt_final_mvp_ct", `CT MVP: ${mvpH.name} (${mvpH.score})`);
  } else {
    setText("wt_final_mvp_ct", "");
  }

  if (mvpZ) {
    setText("wt_final_mvp_t", `T MVP: ${mvpZ.name} (${mvpZ.score})`);
  } else {
    setText("wt_final_mvp_t", "");
  }

  if (combined.brainGod) {
    setText("wt_final_brain", `Brain God: ${slotName(combined.brainGod.slot)}`);
  } else {
    setText("wt_final_brain", "");
  }

  if (combined.liability) {
    setText("wt_final_liability", `Liability: ${slotName(combined.liability.slot)}`);
  } else {
    setText("wt_final_liability", "");
  }

  if (combined.fastest) {
    setText("wt_final_fast", `Fastest: ${slotName(combined.fastest.slot)}`);
  } else {
    setText("wt_final_fast", "");
  }

  if (quizAwards && quizAwards.smartest) {
    setText("wt_final_quiz_smartest", `Quiz smartest: ${slotName(quizAwards.smartest.slot)}`);
  }

  phase = PHASE_FINISHED;
}

Instance.SetThink(() => {
  const t = now();
  tickQuizRooms(t);
  tickShowdown(t);
  Instance.SetNextThink(t + 0.05);
});
