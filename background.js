// Service worker: persistenza e orchestrazione. Il fetch vero avviene nella
// pagina (inject.js), che ha l'origine giusta per il proxy sidecar.

const CAP_PREFIX = "cap:";
const PULL_PREFIX = "pull:";
const TOKEN_KEY = "jwt";
let counter = 0;

// --- filtro anti-telemetria -----------------------------------------------
const NOISE_PATH = /(events|analytics|telemetry|metrics|firebase|appsflyer|crashlytics|experiments|feature[-_]?flags|event-map)/i;
const NOISE_FLAGS = ["firebase_analytics", "firebase_crashlytics", "appsflyer"];

function looksLikeEventConfig(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const values = Object.values(node);
  if (values.length === 0) return false;
  const configLike = values.filter(
    (v) => v && typeof v === "object" && !Array.isArray(v) && NOISE_FLAGS.some((f) => f in v),
  );
  return configLike.length >= Math.max(1, values.length * 0.5);
}

function isNoise(record) {
  try {
    if (NOISE_PATH.test(new URL(record.url).pathname)) return true;
  } catch {}
  // il sidecar nasconde il vero path nel base64: guardo anche o_b64
  try {
    const o = new URL(record.url).searchParams.get("o_b64");
    if (o) {
      const decoded = atob(o.replace(/-/g, "+").replace(/_/g, "/"));
      if (NOISE_PATH.test(decoded)) return true;
    }
  } catch {}
  let data;
  try { data = JSON.parse(record.body); } catch { return false; }
  return looksLikeEventConfig(data) || looksLikeEventConfig(data?.events);
}

// --- persistenza -----------------------------------------------------------
function capKey(record) {
  counter = (counter + 1) % 1_000_000;
  return `${CAP_PREFIX}${record.ts}:${counter}`;
}

async function saveCapture(record) {
  // Le catture passive non servono più: il converter usa solo i pull attivi.
  // Salvarle gonfiava lo storage fino a decine di MB, causando crash di Chrome
  // sugli account grandi. Le ignoriamo del tutto.
  return { ok: true, skipped: true };
}

async function saveToken(jwt) {
  await chrome.storage.local.set({ [TOKEN_KEY]: jwt });
  return { ok: true };
}

async function saveUid(uid) {
  if (uid) await chrome.storage.local.set({ uid: String(uid) });
  return { ok: true };
}

async function savePull(msg) {
  await chrome.storage.local.set({
    [`${PULL_PREFIX}${msg.label}`]: {
      label: msg.label,
      target: msg.target,
      status: msg.status,
      ok: msg.ok,
      data: msg.data,
      error: msg.error,
      ts: Date.now(),
    },
  });
  return { ok: true };
}

// Stato del ciclo di pull, letto dal popup per abilitare l'export.
async function pullStart({ total }) {
  await chrome.storage.local.set({
    pullState: { running: true, done: 0, total: total || 0, startedAt: Date.now() },
  });
  return { ok: true };
}

// Aggiorna il totale reale (noto solo dopo il pass 1).
async function pullSetTotal({ total }) {
  const { pullState } = await chrome.storage.local.get("pullState");
  if (pullState) {
    pullState.total = total;
    // clamp: done non deve mai superare total
    if (pullState.done > total) pullState.done = total;
    await chrome.storage.local.set({ pullState });
  }
  return { ok: true };
}

// Imposta done al valore corrente (guidato dall'inject).
async function pullProgress({ done }) {
  const { pullState } = await chrome.storage.local.get("pullState");
  if (pullState && pullState.running) {
    pullState.done = Math.min(done, pullState.total || done);
    await chrome.storage.local.set({ pullState });
  }
  return { ok: true };
}

async function pullSetTotalAdd({ add }) {
  const { pullState } = await chrome.storage.local.get("pullState");
  if (pullState) {
    pullState.total = (pullState.total || 0) + (add || 0);
    await chrome.storage.local.set({ pullState });
  }
  return { ok: true };
}

async function pullProgressAdd({ add }) {
  const { pullState } = await chrome.storage.local.get("pullState");
  if (pullState && pullState.running) {
    pullState.done = Math.min((pullState.done || 0) + (add || 0), pullState.total || 0);
    await chrome.storage.local.set({ pullState });
  }
  return { ok: true };
}

async function pullFinish() {
  const { pullState } = await chrome.storage.local.get("pullState");
  await chrome.storage.local.set({
    pullState: { ...(pullState || {}), running: false, finishedAt: Date.now() },
  });
  return { ok: true };
}

async function readByPrefix(prefix) {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix))
    .map((k) => all[k])
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

async function clearAll() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CAP_PREFIX) || k.startsWith(PULL_PREFIX));
  await chrome.storage.local.remove(keys);
  return { ok: true };
}

// Reset completo del pull: sblocca lo stato "running" inceppato e svuota i
// risultati parziali. Mantiene token e user id (la sessione resta agganciata).
async function resetPull() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (k) => k.startsWith(CAP_PREFIX) || k.startsWith(PULL_PREFIX) || k === "pullState",
  );
  await chrome.storage.local.remove(keys);
  return { ok: true };
}

// --- JWT -> user id --------------------------------------------------------
function decodeJwt(jwt) {
  try {
    const [, payload] = jwt.split(".");
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function userIdFrom(jwt) {
  const c = decodeJwt(jwt);
  if (!c) return null;
  return c.user_id || c.userId || c.sub || c.id || c.uid || null;
}

// Fallback: se il JWT non espone l'id, lo pesco dalle URL catturate.
async function userIdFromCaptures() {
  const caps = await readByPrefix(CAP_PREFIX);
  for (const r of caps) {
    const m = /\/user\/(\d+)/.exec(decodeURIComponent(r.url));
    if (m) return m[1];
    try {
      const o = new URL(r.url).searchParams.get("o_b64");
      if (o) {
        const dec = atob(o.replace(/-/g, "+").replace(/_/g, "/"));
        const mm = /\/user\/(\d+)/.exec(dec);
        if (mm) return mm[1];
      }
    } catch {}
  }
  return null;
}

async function getAuth() {
  const store = await chrome.storage.local.get([TOKEN_KEY, "uid"]);
  const jwt = store[TOKEN_KEY] || null;
  let uid = (jwt && userIdFrom(jwt)) || store.uid || null;
  if (!uid) uid = await userIdFromCaptures();
  // Sessione valida se abbiamo lo user id: le chiamate sidecar sono
  // same-origin e autenticate dai cookie, il Bearer non è più necessario.
  return { jwt, uid, hasSession: Boolean(uid) };
}

// --- riepilogo / dump ------------------------------------------------------
async function summarise() {
  const [captures, pulls, auth, store] = await Promise.all([
    readByPrefix(CAP_PREFIX),
    readByPrefix(PULL_PREFIX),
    getAuth(),
    chrome.storage.local.get("pullState"),
  ]);

  const byPath = new Map();
  let bytes = 0;
  for (const r of captures) {
    bytes += r.body.length;
    try {
      const path = new URL(r.url).pathname;
      byPath.set(path, (byPath.get(path) || 0) + 1);
    } catch {}
  }

  const countData = (d) =>
    Array.isArray(d) ? d.length
      : Array.isArray(d?.data) ? d.data.length
      : Array.isArray(d?.objects) ? d.objects.length
      : d ? 1 : 0;

  return {
    hasToken: Boolean(auth.jwt),
    hasSession: auth.hasSession,
    uid: auth.uid,
    captured: captures.length,
    bytes,
    endpoints: [...byPath.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count),
    pulls: pulls.map((p) => ({ label: p.label, status: p.status, ok: p.ok, count: countData(p.data) })),
    pullState: store.pullState || { running: false, done: 0, total: 0 },
  };
}

async function dumpEverything() {
  const [captures, pulls] = await Promise.all([readByPrefix(CAP_PREFIX), readByPrefix(PULL_PREFIX)]);
  return { captures, pulls };
}

// --- router ----------------------------------------------------------------
const handlers = {
  capture: ({ record }) => saveCapture(record),
  token: ({ jwt }) => saveToken(jwt),
  uid: ({ uid }) => saveUid(uid),
  pullStart: (msg) => pullStart(msg),
  pullSetTotal: (msg) => pullSetTotal(msg),
  pullSetTotalAdd: (msg) => pullSetTotalAdd(msg),
  pullProgress: (msg) => pullProgress(msg),
  pullProgressAdd: (msg) => pullProgressAdd(msg),
  savePull: (msg) => savePull(msg),
  pullDone: () => pullFinish(),
  auth: () => getAuth(),
  summary: () => summarise(),
  dump: () => dumpEverything(),
  clear: () => clearAll(),
  resetPull: () => resetPull(),
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message).then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
  return true;
});
