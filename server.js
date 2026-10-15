// Offline AI License Server v3
//
// Access model
//   trial        - auto granted on first run, one per machine
//   installment  - customer is paying in instalments, access runs to `expires`
//   owned        - fully paid, perpetual access (never expires)
//   expired      - `expires` date has passed
//   disabled     - YOU flipped it off. Instant kill switch, overrides everything.
//
// You control all of this from /admin: enable/disable, set any expiry date,
// add days, record payments, unlock a machine - no hand-editing data files.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json({ limit: '5mb' }));

// The customer's chat window is a local file, so its Origin arrives as "null".
// Only the public API is opened up; /admin stays same-origin.
app.use('/api', function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Config (env vars override config.json so secrets stay out of git) ----------
const rawConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
const int = (v, d) => (v === undefined || v === '' || isNaN(parseInt(v, 10)) ? d : parseInt(v, 10));

const config = {
  admin_password: process.env.ADMIN_PASSWORD || rawConfig.admin_password,
  trial_days: int(process.env.TRIAL_DAYS, rawConfig.trial_days),
  license_file: rawConfig.license_file || 'licenses.json',
  port: int(process.env.PORT, rawConfig.port || 3000),
  device_lock: bool(process.env.DEVICE_LOCK, rawConfig.device_lock !== false),
  offline_grace_days: int(process.env.OFFLINE_GRACE_DAYS, rawConfig.offline_grace_days || 3),
  check_interval_minutes: int(process.env.CHECK_INTERVAL_MINUTES, rawConfig.check_interval_minutes || 30),
  installment_period_days: int(process.env.INSTALLMENT_PERIOD_DAYS, rawConfig.installment_period_days || 30),
  installment_count: int(process.env.INSTALLMENT_COUNT, rawConfig.installment_count || 12),

  // ---- web search (the "look it up" button) ----
  search_provider: (process.env.SEARCH_PROVIDER || rawConfig.search_provider || 'searxng').toLowerCase(),
  searxng_url: String(process.env.SEARXNG_URL || rawConfig.searxng_url || '').replace(/\/+$/, ''),
  searxng_token: process.env.SEARXNG_TOKEN || rawConfig.searxng_token || '',
  websearch_enabled: bool(process.env.WEBSEARCH_ENABLED, rawConfig.websearch_enabled !== false),
  websearch_trial_enabled: bool(process.env.WEBSEARCH_TRIAL_ENABLED, rawConfig.websearch_trial_enabled !== false),
  websearch_quota_monthly: int(process.env.WEBSEARCH_QUOTA_MONTHLY, rawConfig.websearch_quota_monthly || 300),
  websearch_results: int(process.env.WEBSEARCH_RESULTS, rawConfig.websearch_results || 4),
  websearch_snippet_chars: int(process.env.WEBSEARCH_SNIPPET_CHARS, rawConfig.websearch_snippet_chars || 320),
  websearch_timeout_ms: int(process.env.WEBSEARCH_TIMEOUT_MS, rawConfig.websearch_timeout_ms || 12000),
  websearch_cache_minutes: int(process.env.WEBSEARCH_CACHE_MINUTES, rawConfig.websearch_cache_minutes || 30),
};

const dataDir = process.env.DATA_DIR || __dirname;
const licensesPath = path.join(dataDir, config.license_file);
const machinesPath = path.join(dataDir, 'machines.json');
const activityPath = path.join(dataDir, 'activity.json');
const backupDir = path.join(dataDir, 'backups');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

// ---------- Storage: atomic writes + rolling on-disk snapshots ----------
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function saveJson(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

const EMPTY_OBJ = {};

if (!fs.existsSync(licensesPath)) saveJson(licensesPath, EMPTY_OBJ);
if (!fs.existsSync(machinesPath)) saveJson(machinesPath, EMPTY_OBJ);
if (!fs.existsSync(activityPath)) saveJson(activityPath, []);

// ---------- Helpers ----------
const today = () => new Date().toISOString().split('T')[0];
const nowIso = () => new Date().toISOString();
const addDays = (dateStr, d) => {
  const base = dateStr ? new Date(dateStr + 'T00:00:00Z') : new Date();
  base.setUTCDate(base.getUTCDate() + d);
  return base.toISOString().split('T')[0];
};
const inDays = (d) => addDays(today(), d);

function genKey(prefix) {
  // Grouped XXXX-XXXX-XXXX-XXXX so it is easy to read out over WhatsApp
  const raw = crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('');
  const grouped = raw.slice(0, 16).match(/.{1,4}/g).join('-');
  return (prefix ? prefix + '-' : '') + grouped;
}

let activity = loadJson(activityPath, []);
function logEvent(type, detail) {
  activity.unshift({ time: nowIso(), type, detail });
  if (activity.length > 300) activity = activity.slice(0, 300);
  saveJson(activityPath, activity);
  console.log(`[${type}] ${detail}`);
}

function rollingBackup(tag) {
  try {
    const stamp = nowIso().replace(/[:.]/g, '-');
    const file = path.join(backupDir, `licenses-${tag}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({
      exported: nowIso(),
      licenses: loadJson(licensesPath, EMPTY_OBJ),
      machines: loadJson(machinesPath, EMPTY_OBJ),
    }, null, 2), 'utf8');
    const snaps = fs.readdirSync(backupDir).filter(f => f.startsWith('licenses-')).sort();
    while (snaps.length > 40) fs.unlinkSync(path.join(backupDir, snaps.shift()));
  } catch (e) { console.error('backup failed:', e.message); }
}

function requireAdmin(req, res, next) {
  if (req.headers.authorization !== `Bearer ${config.admin_password}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function isOwned(lic) { return !!lic.perpetual || !!lic.paid; }

function licenseStatus(lic) {
  if (lic.enabled === false || lic.status === 'revoked') return 'disabled';
  if (isOwned(lic)) return 'owned';
  if (!lic.expires) return 'expired';
  if (lic.expires < today()) return 'expired';
  if (lic.plan === 'installment') return 'installment';
  return 'trial';
}

const VALID_STATUSES = ['trial', 'installment', 'owned'];
const STATUS_LABEL = {
  trial: 'Free trial',
  installment: 'Instalment plan',
  owned: 'Owned (permanent)',
  expired: 'Expired',
  disabled: 'Switched off',
};

function publicLicense(lic) {
  const status = licenseStatus(lic);
  return {
    customer: lic.customer || '',
    status,
    statusLabel: STATUS_LABEL[status] || status,
    created: lic.created || null,
    expires: isOwned(lic) ? null : (lic.expires || null),
    perpetual: isOwned(lic),
    plan: lic.plan || 'trial',
    installmentsPaid: (lic.installments || []).length,
  };
}

function touchMachine(machineId, licenseKey, info) {
  if (!machineId) return;
  const machines = loadJson(machinesPath, EMPTY_OBJ);
  machines[machineId] = machines[machineId] || { firstSeen: nowIso(), keys: [] };
  machines[machineId].lastSeen = nowIso();
  if (info) machines[machineId].info = info;
  if (licenseKey && !machines[machineId].keys.includes(licenseKey)) {
    machines[machineId].keys.push(licenseKey);
  }
  saveJson(machinesPath, machines);
}

function licenseResponse(lic) {
  const status = licenseStatus(lic);
  const valid = VALID_STATUSES.indexOf(status) !== -1;
  return {
    valid,
    license: publicLicense(lic),
    status,
    server_time: nowIso(),
    offline_grace_days: config.offline_grace_days,
    check_interval_minutes: config.check_interval_minutes,
    // What this customer's copy is allowed to do. The chat window uses this
    // to decide whether to show the "Search the web" switch at all.
    features: { webSearch: searchConfigured() && webSearchAllowed(lic).ok },
    message: valid ? 'Valid'
      : status === 'disabled' ? 'This copy has been switched off.'
      : status === 'expired' ? 'Your access period has ended.'
      : 'License is not active.',
  };
}
// =====================================================================
//  Public API - called by the customer's launcher
// =====================================================================

// First run: grant a trial. ONE trial per machine, enforced by hardware id.
app.post('/api/register', (req, res) => {
  const body = req.body || {};
  const licenseKey = body.licenseKey;
  const machineId = body.machineId;
  const machineInfo = body.machineInfo;
  if (!licenseKey || !machineId) {
    return res.status(400).json({ registered: false, message: 'licenseKey and machineId required' });
  }

  const licenses = loadJson(licensesPath, EMPTY_OBJ);
  const machines = loadJson(machinesPath, EMPTY_OBJ);

  // This key already exists -> make sure it belongs to this machine
  if (licenses[licenseKey]) {
    const lic = licenses[licenseKey];
    if (config.device_lock) {
      if (!lic.machineId) {
        lic.machineId = machineId;
        lic.activatedAt = nowIso();
        saveJson(licensesPath, licenses);
        logEvent('bind', `Key ${licenseKey} bound to machine ${String(machineId).slice(0, 12)}`);
      } else if (lic.machineId !== machineId) {
        logEvent('deny', `Key ${licenseKey} tried to re-register from a different machine`);
        return res.status(403).json({ registered: false, message: 'This license belongs to another device.' });
      }
    }
    touchMachine(machineId, licenseKey, machineInfo);
    logEvent('register', `Key ${licenseKey} re-registered`);
    return res.json(Object.assign({ registered: true, licenseKey: licenseKey }, licenseResponse(lic)));
  }

  // Brand new key: has this machine already used a trial?
  const machine = machines[machineId];
  if (machine && machine.keys && machine.keys.length > 0) {
    // This machine has history. If any of its keys is still usable, hand it
    // back - that is what makes "delete the folder and try again" pointless.
    // Prefer a paid licence over a trial, so a customer who wipes their folder
    // ends up back on what they actually paid for, not on an old trial.
    let liveKey = null;
    let liveScore = -1;
    let liveWhen = '';
    for (const k of machine.keys) {
      const candidate = licenses[k];
      if (!candidate) continue;
      const status = licenseStatus(candidate);
      if (VALID_STATUSES.indexOf(status) === -1) continue;
      let score = 1;
      if (status === 'installment') score = 2;
      if (status === 'owned') score = 3;
      const when = String(candidate.activatedAt || candidate.updated || candidate.created || '');
      if (score > liveScore || (score === liveScore && when > liveWhen)) {
        liveKey = k; liveScore = score; liveWhen = when;
      }
    }
    if (liveKey) {
      logEvent('blocked', `Trial reset attempt blocked, restored key ${liveKey}`);
      return res.status(409).json(Object.assign({
        registered: false,
        message: 'This device already has a license. We have restored it for you.',
        licenseKey: liveKey,
      }, licenseResponse(licenses[liveKey])));
    }
    logEvent('blocked', `Trial reset attempt blocked (machine ${String(machineId).slice(0, 12)})`);
    return res.status(403).json({
      registered: false,
      message: 'Your free trial has already been used on this device. Please enter your product key to continue.',
    });
  }

  // Brand new machine -> grant the trial
  licenses[licenseKey] = {
    customer: body.customer || 'Self-registered',
    email: body.email || '',
    phone: '',
    status: 'active',
    enabled: true,
    plan: 'trial',
    created: today(),
    expires: inDays(config.trial_days),
    perpetual: false,
    paid: false,
    machineId: machineId,
    activatedAt: nowIso(),
    installments: [],
    notes: `Auto trial (${config.trial_days} days)`,
  };
  saveJson(licensesPath, licenses);
  touchMachine(machineId, licenseKey, machineInfo);
  logEvent('trial', `New trial ${licenseKey} (ends ${inDays(config.trial_days)})`);
  res.json(Object.assign({ registered: true, licenseKey: licenseKey }, licenseResponse(licenses[licenseKey])));
});

// Activating with a product key you sold them.
app.post('/api/activate', (req, res) => {
  const body = req.body || {};
  const machineId = body.machineId;
  const machineInfo = body.machineInfo;
  if (!body.licenseKey || !machineId) {
    return res.status(400).json({ activated: false, message: 'licenseKey and machineId required' });
  }

  const key = String(body.licenseKey).trim().toUpperCase();
  const licenses = loadJson(licensesPath, EMPTY_OBJ);
  const lic = licenses[key];

  if (!lic) {
    logEvent('deny', `Activation attempt with unknown key ${key}`);
    return res.status(404).json({
      activated: false,
      message: 'That product key is not recognised. Please check it and try again.',
    });
  }

  if (config.device_lock) {
    if (!lic.machineId) {
      lic.machineId = machineId;
      lic.activatedAt = nowIso();
      saveJson(licensesPath, licenses);
      logEvent('bind', `Key ${key} activated and locked to this machine`);
    } else if (lic.machineId !== machineId) {
      logEvent('deny', `Key ${key} activation rejected - locked to another device`);
      return res.status(403).json({
        activated: false,
        message: 'This product key is already locked to a different device. Contact support to move it.',
      });
    }
  }

  touchMachine(machineId, key, machineInfo);
  const resp = licenseResponse(lic);
  logEvent(resp.valid ? 'allow' : 'deny', `Activation ${key}: ${resp.status.toUpperCase()}`);
  res.status(resp.valid ? 200 : 403).json(Object.assign({ activated: resp.valid }, resp));
});

// The launcher phones home here on start, and again every check_interval_minutes.
app.post('/api/check', (req, res) => {
  const body = req.body || {};
  const licenseKey = body.licenseKey;
  const machineId = body.machineId;
  const machineInfo = body.machineInfo;
  if (!licenseKey) return res.status(400).json({ valid: false, error: 'licenseKey required' });

  const licenses = loadJson(licensesPath, EMPTY_OBJ);
  const lic = licenses[licenseKey];

  if (!lic) {
    logEvent('deny', `Unknown key ${licenseKey}`);
    return res.json({
      valid: false, status: 'unknown', server_time: nowIso(),
      offline_grace_days: config.offline_grace_days,
      check_interval_minutes: config.check_interval_minutes,
      message: 'License not found. Please re-activate.',
    });
  }

  if (config.device_lock && lic.machineId && machineId && lic.machineId !== machineId) {
    logEvent('deny', `Key ${licenseKey} used from an unexpected machine`);
    return res.json({
      valid: false, status: 'wrong_device', server_time: nowIso(),
      offline_grace_days: config.offline_grace_days,
      check_interval_minutes: config.check_interval_minutes,
      message: 'This license is not valid on this device.',
    });
  }
  if (config.device_lock && !lic.machineId && machineId) {
    lic.machineId = machineId;
    lic.activatedAt = nowIso();
    saveJson(licensesPath, licenses);
  }
  if (!config.device_lock && machineId && lic.machineId !== machineId) {
    // Device lock is off: just follow the customer wherever they install it.
    lic.machineId = machineId;
    saveJson(licensesPath, licenses);
  }

  touchMachine(machineId, licenseKey, machineInfo);
  const resp = licenseResponse(lic);
  logEvent(resp.valid ? 'allow' : 'deny', `Key ${licenseKey}: ${resp.status.toUpperCase()}`);
  res.json(resp);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Offline AI License Server',
    version: 3,
    server_time: nowIso(),
    device_lock: config.device_lock,
    trial_days: config.trial_days,
    offline_grace_days: config.offline_grace_days,
    check_interval_minutes: config.check_interval_minutes,
    licenses: Object.keys(loadJson(licensesPath, EMPTY_OBJ)).length,
    websearch: {
      configured: searchConfigured(),
      enabled: config.websearch_enabled,
      trial_enabled: config.websearch_trial_enabled,
      quota_monthly: config.websearch_quota_monthly,
    },
  });
});
// =====================================================================
//  Web search - the "look it up" button
// =====================================================================
//
// The customer's chat window asks us, we ask SearXNG, and we hand back a
// small, cleaned set of results that a 2B model can actually use.
//
// Two things here matter far more than they look:
//
//  1. The LICENCE decides, not the client. No active licence, no search - and
//     it doubles as the upsell lever: switch it on or off per customer from
//     the dashboard.
//
//  2. A RELEVANCE GUARD. Scraped search engines sometimes return obvious
//     nonsense - asking bing for "the capital of France" once returned a
//     sports betting site. Feeding that to a small model makes it confidently
//     wrong, which is worse than it admitting it does not know. So results
//     that share no words with the question are thrown away, and if nothing
//     usable is left we say so instead of inventing an answer.
//
// WHAT THIS COSTS. Measured A/B on the target laptop (i5-8365U, CPU only, no
// GPU), same question with and without the injected results:
//
//   who is the current president of Nigeria?
//       no results   4.5s to first token, 24s total
//       4 results   15.9s to first token, 25s total   (+1,109 chars)
//   what is the naira to dollar exchange rate today?
//       no results   4.8s to first token, 37s total
//       4 results   19.0s to first token, 55s total   (+1,272 chars)
//
// So four results with 320-character snippets add roughly 11-14 seconds before
// the model starts replying: prompt processing on a CPU is the whole cost, and
// it scales with the length of everything you paste in. Longer results or more
// of them make that worse, not better. Anything much beyond this belongs behind
// a faster machine, not a bigger prompt.
//
// The chat window therefore shows the sources as soon as they arrive, before
// the answer starts, so the wait is visible instead of looking frozen. The two
// dials are websearch_results and websearch_snippet_chars below.

const searchCache = new Map();   // normalised query -> { at, payload }

function searchConfigured() {
  return config.search_provider === 'searxng' && !!config.searxng_url;
}

function monthKey() { return new Date().toISOString().slice(0, 7); }

// Is this customer allowed to search at all?
function webSearchAllowed(lic) {
  if (!lic) return { ok: false, reason: 'no_license' };
  if (lic.webSearch === true) return { ok: true };
  if (lic.webSearch === false) return { ok: false, reason: 'off_for_license' };
  if (!config.websearch_enabled) return { ok: false, reason: 'off_globally' };
  if (lic.plan === 'trial' && !config.websearch_trial_enabled) return { ok: false, reason: 'off_for_trials' };
  return { ok: true };
}

const STOPWORDS = new Set(['the','a','an','of','in','on','for','and','or','to','is','are','was','were',
  'what','who','when','where','why','how','did','does','do','this','that','these','those','it','its',
  'from','with','about','at','by','as','be','been','has','have','had','will','would','can','could',
  'should','latest','current','new','news','tell','me','give','show','please','there','their']);

function keywords(text) {
  const out = [];
  for (let w of String(text || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/)) {
    w = w.replace(/^['-]+|['-]+$/g, '');
    if (w.length > 2 && !STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

// How much of the question actually appears in this result.
function overlapScore(queryWords, text) {
  if (!queryWords.length) return 0;
  const hay = ' ' + String(text || '').toLowerCase() + ' ';
  let hits = 0;
  for (const w of queryWords) if (hay.indexOf(w) !== -1) hits++;
  return hits / queryWords.length;
}

function normaliseResults(rawResults, query) {
  const words = keywords(query);
  const seen = new Set();
  const kept = [];

  for (const r of (rawResults || [])) {
    const url = String(r.url || '').trim();
    if (!url || seen.has(url)) continue;
    const title = String(r.title || '').trim();
    let snippet = String(r.content || r.snippet || r.description || r.text || '').trim();
    // collapse whitespace and strip the "...Read more" tails engines append
    snippet = snippet.replace(/\s+/g, ' ').replace(/\s*(…|\.\.\.)?\s*Read more\.?$/i, '');
    if (!title && !snippet) continue;
    if (snippet.length > config.websearch_snippet_chars) {
      snippet = snippet.slice(0, config.websearch_snippet_chars).replace(/\s+\S*$/, '') + '…';
    }
    seen.add(url);
    kept.push({
      title: title.slice(0, 200),
      url,
      snippet,
      engine: String(r.engine || r.engines || ''),
      score: overlapScore(words, title + ' ' + snippet),
    });
  }

  const relevant = kept.filter(r => r.score > 0).sort((a, b) => b.score - a.score);
  return { relevant, all: kept };
}

function buildSearchUrl(query) {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    language: 'en',
    safesearch: '1',
    categories: 'general',
    pageno: '1',
  });
  return config.searxng_url + '/search?' + params.toString();
}

async function runSearch(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.websearch_timeout_ms);
  try {
    const headers = { 'Accept': 'application/json', 'User-Agent': 'OfflineAI/1.0' };
    if (config.searxng_token) headers['Authorization'] = 'Bearer ' + config.searxng_token;
    const res = await fetch(buildSearchUrl(query), { headers, signal: controller.signal });
    if (!res.ok) throw new Error('search backend returned HTTP ' + res.status);
    const data = await res.json();
    const { relevant, all } = normaliseResults(data.results, query);
    return {
      results: relevant.slice(0, config.websearch_results),
      raw_count: all.length,
      unresponsive: (data.unresponsive_engines || []).map(e => Array.isArray(e) ? e.join(': ') : String(e)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// The customer's chat window calls this before answering a question.
app.post('/api/websearch', async (req, res) => {
  const body = req.body || {};
  const licenseKey = body.licenseKey;
  const machineId = body.machineId;
  const query = String(body.query || '').trim();

  if (!licenseKey) return res.status(400).json({ ok: false, message: 'licenseKey required' });
  if (!query) return res.status(400).json({ ok: false, message: 'query required' });
  if (query.length > 400) return res.status(400).json({ ok: false, message: 'That question is too long to search.' });

  const licenses = loadJson(licensesPath, EMPTY_OBJ);
  const lic = licenses[licenseKey];
  if (!lic) {
    logEvent('deny', `Web search from an unknown key ${licenseKey}`);
    return res.status(403).json({ ok: false, message: 'License not recognised.' });
  }

  if (VALID_STATUSES.indexOf(licenseStatus(lic)) === -1) {
    logEvent('deny', `Web search from an inactive licence ${licenseKey.slice(0, 12)}`);
    return res.status(403).json({ ok: false, message: 'This licence is not active, so web search is unavailable.' });
  }
  if (config.device_lock && lic.machineId && machineId && lic.machineId !== machineId) {
    return res.status(403).json({ ok: false, message: 'This license is not valid on this device.' });
  }

  const allowed = webSearchAllowed(lic);
  if (!allowed.ok) {
    const why = allowed.reason === 'off_for_license' ? 'Web search is switched off for this license.'
      : allowed.reason === 'off_for_trials' ? 'Web search is not included in the free trial.'
      : 'Web search is not available right now.';
    return res.status(403).json({ ok: false, message: why, reason: allowed.reason });
  }

  if (!searchConfigured()) {
    return res.status(503).json({ ok: false, message: 'Web search is not set up on this server yet.' });
  }

  // ---- monthly quota ----
  const month = monthKey();
  if (lic.searchMonth !== month) { lic.searchMonth = month; lic.searchUsed = 0; }
  const used = int(lic.searchUsed, 0);
  const quota = int(lic.searchQuota, config.websearch_quota_monthly);
  if (quota > 0 && used >= quota) {
    return res.status(429).json({
      ok: false,
      message: 'The web search limit for this month has been reached.',
      quota: { used, limit: quota, remaining: 0 },
    });
  }

  // ---- cache (identical questions are free) ----
  const cacheKey = query.toLowerCase().replace(/\s+/g, ' ');
  const cached = searchCache.get(cacheKey);
  let payload;
  let fromCache = false;
  if (cached && (Date.now() - cached.at) < config.websearch_cache_minutes * 60000) {
    payload = cached.payload;
    fromCache = true;
  } else {
    try {
      payload = await runSearch(query);
    } catch (e) {
      logEvent('search_error', `${query.slice(0, 60)}: ${e.message}`);
      return res.status(502).json({ ok: false, message: 'Could not reach the search engine just now.' });
    }
    searchCache.set(cacheKey, { at: Date.now(), payload });
    if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
  }

  const quotaInfo = { used, limit: quota, remaining: Math.max(0, quota - used) };

  if (!payload.results.length) {
    logEvent('search_empty', `No usable results for "${query.slice(0, 60)}"`);
    return res.json({
      ok: false,
      reason: 'no_relevant_results',
      message: 'The search came back with nothing relevant.',
      quota: quotaInfo,
      unresponsive_engines: payload.unresponsive,
    });
  }

  // Only searches that actually hit the backend burn quota.
  if (!fromCache) {
    lic.searchUsed = used + 1;
    lic.searchMonth = month;
    saveJson(licensesPath, licenses);
    quotaInfo.used = lic.searchUsed;
    quotaInfo.remaining = Math.max(0, quota - lic.searchUsed);
  }

  logEvent('search', `${licenseKey.slice(0, 12)}: "${query.slice(0, 50)}" -> ${payload.results.length} relevant${fromCache ? ' (cached)' : ''}`);

  res.json({
    ok: true,
    query,
    results: payload.results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet })),
    cached: fromCache,
    quota: quotaInfo,
    unresponsive_engines: payload.unresponsive,
  });
});

// =====================================================================
//  Admin API - what your dashboard talks to
// =====================================================================

function withLicense(mutator) {
  return function (req, res) {
    const body = req.body || {};
    const licenses = loadJson(licensesPath, EMPTY_OBJ);
    const lic = licenses[body.licenseKey];
    if (!lic) return res.status(404).json({ error: 'License not found' });
    const extra = mutator(lic, body) || {};
    lic.updated = nowIso();
    licenses[body.licenseKey] = lic;
    saveJson(licensesPath, licenses);
    rollingBackup('change');
    res.json(Object.assign({
      success: true,
      licenseKey: body.licenseKey,
      license: Object.assign({}, lic, { status: licenseStatus(lic) }),
    }, extra));
  };
}

// Everything, with computed status, machine info and last-seen
app.get('/admin/licenses', requireAdmin, (req, res) => {
  const licenses = loadJson(licensesPath, EMPTY_OBJ);
  const machines = loadJson(machinesPath, EMPTY_OBJ);
  const out = {};
  for (const key of Object.keys(licenses)) {
    const lic = licenses[key];
    const machine = lic.machineId ? machines[lic.machineId] : null;
    out[key] = Object.assign({}, lic, {
      status: licenseStatus(lic),
      statusLabel: STATUS_LABEL[licenseStatus(lic)],
      lastSeen: machine ? machine.lastSeen : (lic.lastSeen || null),
      machineFirstSeen: machine ? machine.firstSeen : null,
      // Exactly what /api/websearch will actually do. A switched-off or expired
      // customer has no search, and neither has anyone at all while no search
      // backend is configured, so the dashboard must not claim otherwise.
      webSearchAllowed: searchConfigured() && webSearchAllowed(lic).ok &&
                        VALID_STATUSES.indexOf(licenseStatus(lic)) !== -1,
      searchUsed: int(lic.searchUsed, 0),
      searchQuota: int(lic.searchQuota, config.websearch_quota_monthly),
    });
  }
  res.json(out);
});

app.get('/admin/activity', requireAdmin, (req, res) => res.json(activity.slice(0, 60)));

app.get('/admin/config', requireAdmin, (req, res) => {
  res.json({
    device_lock: config.device_lock,
    trial_days: config.trial_days,
    offline_grace_days: config.offline_grace_days,
    check_interval_minutes: config.check_interval_minutes,
    installment_period_days: config.installment_period_days,
    installment_count: config.installment_count,
    data_dir: dataDir,
    using_env_password: !!process.env.ADMIN_PASSWORD,
    persistent_data_dir: !!process.env.DATA_DIR,
    websearch: {
      configured: searchConfigured(),
      provider: config.search_provider,
      backend: config.searxng_url || '(not set)',
      enabled: config.websearch_enabled,
      trial_enabled: config.websearch_trial_enabled,
      quota_monthly: config.websearch_quota_monthly,
      results: config.websearch_results,
    },
  });
});

// Turn web search on/off for one customer, change their quota, or reset usage.
app.post('/admin/websearch', requireAdmin, withLicense(function (lic, body) {
  if (body.enabled === null || body.enabled === 'default') {
    delete lic.webSearch;                       // fall back to the global setting
  } else if (body.enabled !== undefined) {
    lic.webSearch = body.enabled !== false;
  }
  if (body.quota !== undefined && body.quota !== '') {
    lic.searchQuota = int(body.quota, config.websearch_quota_monthly);
  }
  if (body.resetUsage) {
    lic.searchUsed = 0;
    lic.searchMonth = monthKey();
  }
  const state = lic.webSearch === undefined ? 'default' : (lic.webSearch ? 'ON' : 'OFF');
  logEvent('admin', `Web search for ${body.licenseKey} -> ${state}`);
  return { webSearch: lic.webSearch === undefined ? null : lic.webSearch };
}));

// Create a key you can sell or hand out. Does not touch any customer's trial.
app.post('/admin/create', requireAdmin, (req, res) => {
  const body = req.body || {};
  const licenses = loadJson(licensesPath, EMPTY_OBJ);
  const licenseKey = genKey('OA');
  const perpetual = !!body.perpetual;
  const days = int(body.days, config.installment_period_days);
  const plan = perpetual ? 'owned' : (body.plan === 'trial' ? 'trial' : 'installment');
  licenses[licenseKey] = {
    customer: body.customer || 'Unknown',
    email: body.email || '',
    phone: body.phone || '',
    status: 'active',
    enabled: true,
    plan: plan,
    created: today(),
    expires: perpetual ? null : inDays(days),
    perpetual: perpetual,
    paid: perpetual,
    machineId: null,
    installments: [],
    notes: body.notes || (perpetual ? 'Issued as owned (permanent)' : `Issued by admin (${days} days)`),
  };
  if (typeof body.webSearch === 'boolean') licenses[licenseKey].webSearch = body.webSearch;
  saveJson(licensesPath, licenses);
  rollingBackup('create');
  logEvent('admin', `Created ${licenseKey} for ${body.customer || 'Unknown'}`);
  res.json({ success: true, licenseKey: licenseKey, license: licenses[licenseKey] });
});

// THE KILL SWITCH. Off means their copy stops on its next check.
app.post('/admin/enable', requireAdmin, withLicense(function (lic, body) {
  const on = body.enabled !== false;
  lic.enabled = on;
  lic.status = on ? 'active' : 'revoked';
  logEvent('admin', `${on ? 'ENABLED' : 'DISABLED (kill switch)'} ${body.licenseKey}`);
  return {};
}));

// Set any expiry date you like
app.post('/admin/set-expiry', requireAdmin, withLicense(function (lic, body) {
  if (body.perpetual === true) {
    lic.perpetual = true; lic.paid = true; lic.expires = null;
  } else if (body.perpetual === false) {
    lic.perpetual = false; lic.paid = false;
    if (body.expires) lic.expires = body.expires;
  } else if (body.expires) {
    lic.expires = body.expires;
  }
  logEvent('admin', `Expiry for ${body.licenseKey} -> ${lic.perpetual ? 'PERMANENT' : lic.expires}`);
  return {};
}));

// Add (or subtract) days from wherever the customer currently stands
app.post('/admin/add-days', requireAdmin, withLicense(function (lic, body) {
  const days = int(body.days, 30);
  const from = (lic.expires && lic.expires > today()) ? lic.expires : today();
  lic.expires = addDays(from, days);
  lic.perpetual = false;
  lic.paid = false;
  lic.enabled = true;
  if (lic.status === 'revoked') lic.status = 'active';
  logEvent('admin', `Added ${days} days to ${body.licenseKey} -> ${lic.expires}`);
  return {};
}));

// Record an instalment payment and extend access by one period
app.post('/admin/payment', requireAdmin, withLicense(function (lic, body) {
  const amount = (body.amount === undefined || body.amount === '') ? null : Number(body.amount);
  const period = int(body.days, config.installment_period_days);
  lic.installments = lic.installments || [];
  lic.installments.push({ date: today(), amount: amount, note: body.note || '', at: nowIso() });
  const from = (lic.expires && lic.expires > today()) ? lic.expires : today();
  lic.expires = addDays(from, period);
  lic.plan = 'installment';
  lic.enabled = true;
  if (lic.status === 'revoked') lic.status = 'active';
  let total = 0;
  for (const p of lic.installments) total += (p.amount || 0);
  logEvent('admin', `Payment on ${body.licenseKey}: ${amount === null ? '(amount not set)' : amount} -> ${lic.expires}`);
  return { installmentsPaid: lic.installments.length, amountPaid: total };
}));

// Fully paid -> permanent ownership
app.post('/admin/own', requireAdmin, withLicense(function (lic, body) {
  lic.perpetual = true;
  lic.paid = true;
  lic.plan = 'owned';
  lic.status = 'active';
  lic.enabled = true;
  logEvent('admin', `Marked OWNED (permanent): ${body.licenseKey} - ${lic.customer || ''}`);
  return {};
}));

// Unlock the key so it can be activated on a new computer
app.post('/admin/reset-device', requireAdmin, withLicense(function (lic, body) {
  const old = lic.machineId;
  lic.machineId = null;
  lic.activatedAt = null;
  logEvent('admin', `Device lock cleared for ${lic.customer || body.licenseKey} (was ${old ? String(old).slice(0, 12) : 'unbound'})`);
  return {};
}));

app.post('/admin/update', requireAdmin, withLicense(function (lic, body) {
  const updates = body.updates || {};
  for (const k of ['customer', 'email', 'phone', 'notes', 'plan']) {
    if (updates[k] !== undefined) lic[k] = updates[k];
  }
  if (updates.expires !== undefined) lic.expires = updates.expires;
  logEvent('admin', `Updated ${body.licenseKey}: ${JSON.stringify(updates)}`);
  return {};
}));

app.post('/admin/delete', requireAdmin, (req, res) => {
  const body = req.body || {};
  rollingBackup('predelete');
  const licenses = loadJson(licensesPath, EMPTY_OBJ);
  if (!licenses[body.licenseKey]) return res.status(404).json({ error: 'License not found' });
  delete licenses[body.licenseKey];
  saveJson(licensesPath, licenses);
  logEvent('admin', `Deleted ${body.licenseKey}`);
  res.json({ success: true });
});

app.get('/admin/backup', requireAdmin, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="license_backup.json"');
  res.json({
    exported: nowIso(),
    licenses: loadJson(licensesPath, EMPTY_OBJ),
    machines: loadJson(machinesPath, EMPTY_OBJ),
    activity: activity.slice(0, 200),
  });
});

// Upload a backup to recover after the host wipes its disk (free hosts do this).
app.post('/admin/restore', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (!body.licenses || typeof body.licenses !== 'object') {
    return res.status(400).json({ error: 'Body must include a "licenses" object' });
  }
  rollingBackup('prerestore');
  saveJson(licensesPath, body.licenses);
  saveJson(machinesPath, (body.machines && typeof body.machines === 'object') ? body.machines : {});
  logEvent('admin', `Restored backup (${Object.keys(body.licenses).length} licenses)`);
  res.json({ success: true, licenses: Object.keys(body.licenses).length });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.json({ service: 'Offline AI License Server', version: 3, admin: '/admin' }));

// ---------- Start ----------
app.listen(config.port, function () {
  console.log(`Offline AI license server v3 on port ${config.port}`);
  console.log(`  data dir        : ${dataDir}`);
  console.log(`  device lock     : ${config.device_lock ? 'ON' : 'OFF'}`);
  console.log(`  trial           : ${config.trial_days} days`);
  console.log(`  offline grace   : ${config.offline_grace_days} days`);
  console.log(`  check interval  : ${config.check_interval_minutes} min`);
  console.log(`  web search      : ${searchConfigured() ? 'via ' + config.searxng_url + (config.websearch_enabled ? '' : ' (DISABLED)') : 'NOT CONFIGURED'}`);
  console.log(`  admin password  : ${process.env.ADMIN_PASSWORD ? 'from ADMIN_PASSWORD env' : 'from config.json'}`);
  console.log(`  admin dashboard : http://localhost:${config.port}/admin`);
  if (config.admin_password === 'ChangeThisToYourAdminPassword123' || config.admin_password === 'CHANGE-ME-BEFORE-YOU-DEPLOY') {
    console.warn('  !! ADMIN PASSWORD IS STILL THE DEFAULT - change it before you have customers');
  }
});
