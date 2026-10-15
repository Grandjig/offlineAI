// Tests for the web search feature (/api/websearch).
//
// Start the licence server against a throwaway data dir and a real SearXNG,
// then run:  node websearch-test.js
//
//   DATA_DIR=/tmp/ws BASEDIR=/tmp/ws \
//   ADMIN_PASSWORD=testpass123 SEARXNG_URL=http://127.0.0.1:8899 \
//   node server.js
//   BASE=http://localhost:3999 node websearch-test.js
const BASE = process.env.BASE || 'http://localhost:3999';
const PW = process.env.ADMIN_PASSWORD || 'testpass123';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
}
async function post(path, body, admin) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, admin ? { Authorization: 'Bearer ' + PW } : {}),
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, headers: res.headers };
}

const search = (key, query, machineId) =>
  post('/api/websearch', { licenseKey: key, query, machineId });

(async () => {
  console.log('\nWeb search tests against ' + BASE + '\n');

  // ---- a paying customer ----
  const created = await post('/admin/create', {
    customer: 'Search Tester', phone: '+2348000000001', plan: 'installment', days: 30,
  }, true);
  const key = created.data.licenseKey;
  check('admin can issue a licence', !!key, created.data);

  const m1 = 'search-machine-1';

  // ---- the plain case ----
  const q1 = 'who is the current president of Nigeria';
  const r1 = await search(key, q1, m1);
  console.log('\n  --- what actually came back ---');
  if (r1.data && r1.data.results) {
    r1.data.results.forEach(r => console.log(`  [${r1.data.results.indexOf(r) + 1}] ${r.title}\n      ${(r.snippet || '').slice(0, 110)}`));
  }
  console.log('');
  check('search answers', r1.data && r1.data.ok === true, r1.data);
  check('returns several results', r1.data && r1.data.results.length >= 3, r1.data && r1.data.results.length);
  check('results carry title, url and snippet',
    r1.data && r1.data.results.every(r => r.title && /^https?:/.test(r.url) && r.snippet !== undefined),
    r1.data && r1.data.results[0]);
  check('snippets are kept short enough for a small model',
    r1.data && r1.data.results.every(r => r.snippet.length <= 330),
    r1.data && Math.max(...r1.data.results.map(r => r.snippet.length)));
  const namesThePresident = r1.data && r1.data.results.some(r => /tinubu/i.test(r.title + r.snippet));
  check('the results actually name the current president', !!namesThePresident,
    r1.data && r1.data.results.map(r => r.title));
  check('quota is reported back', r1.data && r1.data.quota && r1.data.quota.limit > 0, r1.data && r1.data.quota);

  // ---- a second, different question that must not be garbage ----
  const q2 = 'nvidia latest quarterly earnings';
  const r2 = await search(key, q2, m1);
  check('second question also answers', r2.data && r2.data.ok === true, r2.data);
  console.log('  --- ' + q2 + ' ---');
  if (r2.data && r2.data.results) {
    r2.data.results.forEach(r => console.log(`      ${r.title}  (${r.url.slice(0, 60)})`));
  }
  console.log('');

  // ---- caching ----
  const usedBefore = r2.data.quota.used;
  const again = await search(key, q2, m1);
  check('asking the same thing twice is served from cache', again.data && again.data.cached === true, again.data);
  check('a cached search does not burn quota', again.data.quota.used === usedBefore,
    { before: usedBefore, after: again.data.quota.used });

  // ---- nonsense must be refused rather than fed to the model ----
  const nonsense = await search(key, 'zzzqqq flibbertigibbet wumblecrumpet', m1);
  check('unrelated results are refused, not handed over as fact',
    nonsense.data && nonsense.data.ok === false && nonsense.data.reason === 'no_relevant_results', nonsense.data);

  // ---- abuse / limits ----
  const wrongKey = await search('DEFINITELY-NOT-A-KEY', 'hello world test', m1);
  check('an unknown key cannot search', wrongKey.status === 403, wrongKey.data);
  const tooLong = await search(key, 'x'.repeat(500), m1);
  check('absurdly long questions are rejected', tooLong.status === 400, tooLong.data);

  // ---- the key is only good on the computer it was first used on ----
  const bound = await post('/api/register', { licenseKey: key, machineId: m1 });
  check('registering binds the key to this computer', bound.data && bound.data.registered === true, bound.data);
  const sameMachine = await search(key, 'weather in lagos tomorrow', m1);
  check('the bound computer can search', sameMachine.status === 200, sameMachine.data);
  const otherMachine = await search(key, 'weather in lagos tomorrow', 'a-different-computer');
  check('a copy of the same key on another computer cannot search',
    otherMachine.status === 403, otherMachine.data);

  // ---- per-customer quota ----
  // A repeated question is served from cache and deliberately costs no quota,
  // so these two questions carry a nonce: the test must not depend on whether
  // an earlier run of this file already asked them.
  const nonce = String(Date.now()).slice(-6);
  await post('/admin/websearch', { licenseKey: key, quota: 1, resetUsage: true }, true);
  const first = await search(key, `zimbabwe inflation rate ${nonce}`, m1);
  check('search works again after a usage reset', first.data && first.data.ok === true, first.data);
  check('that search used exactly one of the quota',
    first.data && first.data.quota.used === 1 && first.data.quota.remaining === 0, first.data && first.data.quota);
  const second = await search(key, `canada wildfire season ${nonce}`, m1);
  check('quota of 1 stops the next search', second.status === 429, second.data);
  check('the quota message says what happened',
    second.data && /limit/i.test(second.data.message), second.data && second.data.message);

  // ---- switching search off for one customer ----
  const off = await post('/admin/websearch', { licenseKey: key, enabled: false }, true);
  check('admin can switch search off for one licence', off.status === 200, off.data);
  const blocked = await search(key, 'who won the world cup', m1);
  check('a switched-off licence is refused', blocked.status === 403 && blocked.data.reason === 'off_for_license', blocked.data);
  const list = await (await fetch(BASE + '/admin/licenses', { headers: { Authorization: 'Bearer ' + PW } })).json();
  check('the dashboard can see search is off', list[key].webSearchAllowed === false, list[key] && list[key].webSearchAllowed);

  await post('/admin/websearch', { licenseKey: key, enabled: true, resetUsage: true }, true);
  const back = await search(key, 'who won the afcon final', m1);
  check('switching it back on works', back.status === 200, back.data);

  // ---- and globally ----
  const cfg = await (await fetch(BASE + '/admin/config', { headers: { Authorization: 'Bearer ' + PW } })).json();
  check('the dashboard reports the search backend', cfg.websearch && cfg.websearch.configured === true, cfg.websearch);

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
