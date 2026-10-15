// Smoke test for the Offline AI license server.
// Start the server against a throwaway data dir, then:
//   node smoke-test.js
// Set BASE / ADMIN_PASSWORD to match your instance.
const BASE = process.env.BASE || 'http://localhost:3999';
const PW = process.env.ADMIN_PASSWORD || 'testpass123';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  -> ' + JSON.stringify(extra) : ''}`); }
}

async function post(path, body, admin) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, admin ? { Authorization: 'Bearer ' + PW } : {}),
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
async function get(path, admin) {
  const res = await fetch(BASE + path, { headers: admin ? { Authorization: 'Bearer ' + PW } : {} });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

(async () => {
  console.log('\nLicense server smoke test against ' + BASE + '\n');

  // ---- trial ----
  const m1 = 'hw-machine-one';
  const r1 = await post('/api/register', { licenseKey: 'TRIAL-TEST-0001', machineId: m1 });
  check('new machine gets a 14 day trial', r1.data.registered === true && r1.data.license.status === 'trial', r1.data);
  const trialKey = r1.data.licenseKey;
  const trialExpiry = r1.data.license.expires;
  check('trial expiry is in the future', !!trialExpiry && new Date(trialExpiry) > new Date(), trialExpiry);

  // ---- trial is honoured by /api/check ----
  const c1 = await post('/api/check', { licenseKey: trialKey, machineId: m1 });
  check('trial passes a licence check', c1.data.valid === true, c1.data);

  // ---- deleting local files and starting over does not reset the trial ----
  const r2 = await post('/api/register', { licenseKey: 'TRIAL-TEST-0002', machineId: m1 });
  check('trial reset attempt is refused', r2.status === 409 || r2.status === 403, r2.data);
  check('refused reset hands the real key back', r2.data.licenseKey === trialKey, r2.data);

  // ---- a different machine still gets its own trial ----
  const r3 = await post('/api/register', { licenseKey: 'TRIAL-TEST-0003', machineId: 'hw-machine-two' });
  check('a second machine gets its own trial', r3.data.registered === true, r3.data);

  // ---- activation ----
  const bad = await post('/api/activate', { licenseKey: 'OA-NOPE-NOPE-NOPE', machineId: 'hw-machine-three' });
  check('unknown product key is rejected', bad.status === 404, bad.data);

  const created = await post('/admin/create', { customer: 'Ada Test', phone: '+2348000000000', plan: 'installment', days: 30 }, true);
  check('admin can create a product key', created.data.success === true, created.data);
  const soldKey = created.data.licenseKey;
  check('created key is grouped and readable', /^OA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(soldKey), soldKey);

  const act = await post('/api/activate', { licenseKey: soldKey, machineId: 'hw-machine-three' });
  check('product key activates on the customer machine', act.data.activated === true && act.data.status === 'installment', act.data);

  const act2 = await post('/api/activate', { licenseKey: soldKey, machineId: 'hw-machine-four' });
  check('activation on a second computer is refused (device lock)', act2.status === 403, act2.data);

  // ---- kill switch ----
  await post('/admin/enable', { licenseKey: soldKey, enabled: false }, true);
  const c2 = await post('/api/check', { licenseKey: soldKey, machineId: 'hw-machine-three' });
  check('switched-off key fails its next check', c2.data.valid === false && c2.data.status === 'disabled', c2.data);

  await post('/admin/enable', { licenseKey: soldKey, enabled: true }, true);
  const c3 = await post('/api/check', { licenseKey: soldKey, machineId: 'hw-machine-three' });
  check('key works again after switching it back on', c3.data.valid === true, c3.data);

  // ---- instalments ----
  const beforeExpiry = c3.data.license.expires;
  const pay = await post('/admin/payment', { licenseKey: soldKey, amount: 25000, days: 30, note: 'Instalment 1' }, true);
  check('payment records the instalment', pay.data.installmentsPaid === 1, pay.data);
  check('payment extends access', pay.data.license.expires > beforeExpiry, { beforeExpiry, after: pay.data.license.expires });

  // ---- expiry ----
  await post('/admin/set-expiry', { licenseKey: soldKey, expires: '2020-01-01' }, true);
  const c4 = await post('/api/check', { licenseKey: soldKey, machineId: 'hw-machine-three' });
  check('past expiry date blocks access', c4.data.valid === false && c4.data.status === 'expired', c4.data);

  // ---- ownership ----
  await post('/admin/own', { licenseKey: soldKey }, true);
  const c5 = await post('/api/check', { licenseKey: soldKey, machineId: 'hw-machine-three' });
  check('owned license never expires', c5.data.valid === true && c5.data.license.perpetual === true && c5.data.license.expires === null, c5.data);

  // ---- device move ----
  const blocked = await post('/api/check', { licenseKey: soldKey, machineId: 'hw-machine-four' });
  check('owned license is still bound to its computer', blocked.data.valid === false && blocked.data.status === 'wrong_device', blocked.data);
  await post('/admin/reset-device', { licenseKey: soldKey }, true);
  const moved = await post('/api/activate', { licenseKey: soldKey, machineId: 'hw-machine-four' });
  check('after unlocking, the licence moves to the new computer', moved.data.activated === true, moved.data);

  // ---- data written to disk ----
  const licRes = await get('/admin/licenses', true);
  check('admin can list licenses', licRes.status === 200 && Object.keys(licRes.data).length >= 3, Object.keys(licRes.data || {}).length);
  const bk = await get('/admin/backup', true);
  check('backup contains licenses and machines', !!bk.data.licenses && !!bk.data.machines, Object.keys(bk.data));
  const unauth = await get('/admin/licenses', false);
  check('admin API needs the password', unauth.status === 401, unauth.status);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
