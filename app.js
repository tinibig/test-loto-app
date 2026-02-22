// Lô tô host

const $ = (id) => document.getElementById(id);
const HISTORY_MAX = 10; // show only latest N calls in the list

const btnStart = $("btnStart");
const btnEnd = $("btnEnd");
const btnNext = $("btnNext");
const btnAuto = $("btnAuto");
const btnPause = $("btnPause");
const btnResume = $("btnResume");
const btnStopVoice = $("btnStopVoice");

const intervalSecEl = $("intervalSec");
const voiceSelect = $("voiceSelect");

const currentNumberEl = $("currentNumber");
const currentChantEl = $("currentChant");
const historyEl = $("history");
const gridEl = $("grid");

const CHANT_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS6oPMYgJg7PnoNsW8WHMw1w_6GntnP-eiNnOrjR6rQOe1YuNps0sAu6XCUhaRUNTp4UMzNvWMgqiYE/pub?gid=0&single=true&output=csv";

// Session state
let remaining = [];
let called = [];
let autoOn = false;
let autoTimer = null;
let speaking = false;

// Chant DB: Map<number, string[]> where array is [opt1..opt5] (may contain empty strings)
let chantDB = new Map();

// --- Utilities ---
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Pick an option for a number (strict: only from sheet).
// Randomize among opt1..opt5; if picked empty, retry until found.
function pickChant(n) {
  const opts = chantDB.get(n);
  if (!opts || !opts.length) return "";

  // Try random picks a few times
  for (let tries = 0; tries < 20; tries++) {
    const idx = Math.floor(Math.random() * 5); // 0..4
    const s = (opts[idx] ?? "").trim();
    if (s) return s;
  }

  // Fallback: return first non-empty if random kept hitting empties
  for (const s of opts) {
    const t = (s ?? "").trim();
    if (t) return t;
  }
  return "";
}

// --- Grid / UI ---
function buildGrid() {
  gridEl.innerHTML = "";
  for (let n = 0; n < 100; n++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.n = String(n);
    cell.textContent = pad2(n);
    gridEl.appendChild(cell);
  }
}

function updateGrid(currentN = null) {
  const calledSet = new Set(called);
  for (const cell of gridEl.children) {
    const n = Number(cell.dataset.n);
    cell.classList.toggle("called", calledSet.has(n));
    cell.classList.toggle("current", currentN === n);
  }
}

function renderHistory() {
  historyEl.innerHTML = "";

  const start = Math.max(0, called.length - HISTORY_MAX);
  for (let i = called.length - 1; i >= start; i--) {
    const n = called[i];
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = pad2(n);
    historyEl.appendChild(pill);
  }
}

function setControls(inSession) {
  btnEnd.disabled = !inSession;
  btnNext.disabled = !inSession;
  btnAuto.disabled = !inSession;
  btnPause.disabled = !inSession;
  btnResume.disabled = !inSession;
  btnStopVoice.disabled = !inSession;
}

// --- Speech (Web Speech API) ---
function populateVoices() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  voiceSelect.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  }

  // Prefer Vietnamese voice if available
  const vi = voices.find((v) => (v.lang || "").toLowerCase().startsWith("vi"));
  if (vi) voiceSelect.value = vi.voiceURI;
}

function getSelectedVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const uri = voiceSelect.value;
  return voices.find((v) => v.voiceURI === uri) || null;
}

function stopSpeech() {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  speaking = false;
}

function speak(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      resolve();
      return;
    }

    stopSpeech(); // avoid overlap
    const u = new SpeechSynthesisUtterance(text);

    const v = getSelectedVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang || "vi-VN";
    } else {
      u.lang = "vi-VN";
    }

    speaking = true;
    u.onend = () => {
      speaking = false;
      resolve();
    };
    u.onerror = () => {
      speaking = false;
      resolve();
    };

    window.speechSynthesis.speak(u);
  });
}

// --- Session logic ---
function startSession() {
  stopAuto();
  stopSpeech();

  remaining = shuffle(Array.from({ length: 100 }, (_, i) => i));
  called = [];

  currentNumberEl.textContent = "—";
  currentChantEl.textContent = "Session started. Click 'Call next number' or turn Auto ON.";
  renderHistory();
  updateGrid(null);

  setControls(true);
  btnAuto.textContent = "Auto: OFF";
  autoOn = false;
}

function endSession() {
  stopAuto();
  stopSpeech();

  remaining = [];
  autoOn = false;
  btnAuto.textContent = "Auto: OFF";

  currentChantEl.textContent = "Session ended.";
  currentNumberEl.textContent = "—";
  updateGrid(null);

  setControls(false);
}

async function callNext() {
  if (speaking) return;
  if (!remaining.length) {
    currentChantEl.textContent = "Hết số rồi! End session.";
    stopAuto();
    return;
  }

  const n = remaining.pop();
  called.push(n);

  const chant = pickChant(n);

  currentNumberEl.textContent = pad2(n);
  renderHistory();
  updateGrid(n);

  if (!chant) {
    // Safety (shouldn't happen if sheet has at least one option per number)
    currentChantEl.textContent = `Missing chant for ${pad2(n)} in Sheet. Auto stopped.`;
    stopAuto();
    return;
  }

  currentChantEl.textContent = chant;
  await speak(chant);

  if (autoOn) scheduleNextAuto();
}

function scheduleNextAuto() {
  stopAutoTimerOnly();
  const sec = Math.max(1, Math.min(60, Number(intervalSecEl.value) || 5));
  autoTimer = setTimeout(() => {
    callNext();
  }, sec * 1000);
}

function stopAutoTimerOnly() {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = null;
}

function stopAuto() {
  stopAutoTimerOnly();
  autoOn = false;
  btnAuto.textContent = "Auto: OFF";
}

function toggleAuto() {
  if (!remaining.length) return;
  autoOn = !autoOn;
  btnAuto.textContent = autoOn ? "Auto: ON" : "Auto: OFF";
  if (autoOn) {
    if (!speaking) callNext();
  } else {
    stopAutoTimerOnly();
  }
}

// Pause/Resume affect both auto scheduling and speech
function pauseAll() {
  stopAutoTimerOnly();
  if (window.speechSynthesis) window.speechSynthesis.pause();
}

function resumeAll() {
  if (window.speechSynthesis) window.speechSynthesis.resume();
  if (autoOn && !speaking) scheduleNextAuto();
}

// --- Google Sheet CSV loading ---
function parseCSVLine(line) {
  // Basic CSV parser for commas + quotes
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];

  const header = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = cols[c] ?? "";
    rows.push(obj);
  }
  return rows;
}

async function loadSheet(url) {
  console.log("Loading sheet...");
  chantDB = new Map();

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const text = await res.text();

  const rows = parseCSV(text);

  let countNums = 0;
  let countNonEmpty = 0;

  for (const r of rows) {
    const n = Number((r.num ?? "").trim());
    if (!Number.isInteger(n) || n < 0 || n > 99) continue;

    // Force opt1..opt5 (some may be empty)
    const opts = [
      (r.opt1 ?? "").trim(),
      (r.opt2 ?? "").trim(),
      (r.opt3 ?? "").trim(),
      (r.opt4 ?? "").trim(),
      (r.opt5 ?? "").trim(),
    ];

    // Keep row only if at least one option exists
    if (opts.some((s) => s.length > 0)) {
      chantDB.set(n, opts);
      countNums++;
      countNonEmpty += opts.filter((s) => s.length > 0).length;
    }
  }

  console.log(`Loaded: ${countNums}/100 numbers, ${countNonEmpty} non-empty options total.`);
}

// --- Event wiring ---
buildGrid();

btnStart.addEventListener("click", startSession);
btnEnd.addEventListener("click", endSession);
btnNext.addEventListener("click", callNext);
btnAuto.addEventListener("click", toggleAuto);
btnPause.addEventListener("click", pauseAll);
btnResume.addEventListener("click", resumeAll);
btnStopVoice.addEventListener("click", stopSpeech);

(async () => {
  try {
    await loadSheet(CHANT_CSV_URL);
  } catch (e) {
    console.warn("Sheet load failed. Chant DB is empty.", e);
    chantDB = new Map();
  }
})();

// Web Speech voices often load async
if (window.speechSynthesis) {
  populateVoices();
  window.speechSynthesis.onvoiceschanged = populateVoices;
}

setControls(false);