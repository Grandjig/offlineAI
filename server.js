// Offline AI License Server v2
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ---------- Config ----------
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
// DATA_DIR env var lets hosting platforms (e.g. Render disks) point at persistent storage
const dataDir = process.env.DATA_DIR || __dirname;
const licensesPath = path.join(dataDir, config.license_file);
const machinesPath = path.join(dataDir, 'machines.json');
const activityPath = path.join(dataDir, 'activity.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(licensesPath)) fs.writeFileSync(licensesPath, '{}', 'utf8');
if (!fs.existsSync(machinesPath)) fs.writeFileSync(machinesPath, '{}', 'utf8');

// ---------- Helpers ----------
const today = () => new Date().toISOString().split('T')[0];
const inDays = (d) => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().split('T')[0]; };
const nowIso = () => new Date().toISOString();

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback || {}; }
}
function saveJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); }
function genKey() { return 'lic-' + crypto.randomBytes(8).toString('hex').toUpperCase(); }

// Activity log (ring buffer, persisted)
let activity = loadJson(activityPath, []);
function logEvent(type, detail) {
  activity.unshift({ time: nowIso(), type, detail });
  if (activity.length > 200) activity = activity.slice(0, 200);
  saveJson(activityPath, activity);
  console.log(`[${type}] ${detail}`);
}

function requireAdmin(req, res, next) {
  if (req.headers.authorization !== `Bearer ${config.admin_password}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function licenseStatus(lic) {
  if (lic.paid || lic.status === 'paid') return 'paid';
  if (lic.status === 'revoked') return 'revoked';
  if (lic.expires && lic.expires < today()) return 'expired';
  return 'trial';
}

// ---------- Public API ----------

// Register a trial: ONE trial per machine (blocks license.dat deletion cheat)
app.post('/api/register', (req, res) => {
  const { licenseKey, machineId } = req.body;
  if (!licenseKey || !machineId) {
    return res.status(400).json({ registered: false, message: 'licenseKey and machineId required' });
  }

  const licenses = loadJson(licensesPath, {});
  const machines = loadJson(machinesPath, {});

  // Key already exists: verify it belongs to this machine
  if (licenses[licenseKey]) {
    if (!licenses[licenseKey].machineId) {
      licenses[licenseKey].machineId = machineId;
      saveJson(licensesPath, licenses);
    }
    if (licenses[licenseKey].machineId !== machineId) {
      return res.status(403).json({ registered: false, message: 'License is bound to a different machine' });
    }
    machines[machineId] = machines[machineId] || { firstSeen: nowIso(), keys: [] };
    if (!machines[machineId].keys.includes(licenseKey)) machines[machineId].keys.push(licenseKey);
    machines[machineId].lastSeen = nowIso();
    saveJson(machinesPath, machines);
    logEvent('register', `Key ${licenseKey} re-registered (machine ${machineId.slice(0, 8)}...)`);
    return res.json({ registered: true, licenseKey, message: 'Already registered' });
  }

  // New key: has this machine used a trial before?
  const machine = machines[machineId];
  if (machine && machine.keys && machine.keys.length > 0) {
    const existingKey = machine.keys[machine.keys.length - 1];
    const existing = licenses[existingKey];
    const existingValid = existing && (existing.paid || licenseStatus(existing) === 'trial');
    if (existingValid) {
      return res.status(403).json({
        registered: false,
        message: 'This machine already has an active license.',
        licenseKey: existingKey
      });
    }
    logEvent('blocked', `Trial reset attempt blocked (machine ${machineId.slice(0, 8)}...)`);
    return res.status(403).json({
      registered: false,
      message: 'Trial already used on this machine. Purchase a license to continue.'
    });
  }

  // Brand-new machine: create the trial
  licenses[licenseKey] = {
    customer: req.body.customer || 'Self-registered',
    email: req.body.email || '',
    status: 'trial',
    created: today(),
    expires: inDays(config.trial_days),
    paid: false,
    machineId,
    notes: `Auto-created trial (${config.trial_days} days)`
  };
  machines[machineId] = { firstSeen: nowIso(), lastSeen: nowIso(), keys: [licenseKey] };
  saveJson(licensesPath, licenses);
  saveJson(machinesPath, machines);
  logEvent('trial', `New trial ${licenseKey} (machine ${machineId.slice(0, 8)}..., expires ${inDays(config.trial_days)})`);
  res.json({ registered: true, licenseKey, expires: inDays(config.trial_days) });
});

// Check license
app.post('/api/check', (req, res) => {
  const { licenseKey, machineId } = req.body;
  if (!licenseKey) return res.status(400).json({ valid: false, error: 'License key required' });

  const licenses = loadJson(licensesPath, {});
  const machines = loadJson(machinesPath, {});
  const lic = licenses[licenseKey];

  if (!lic) {
    logEvent('deny', `Unknown key ${licenseKey}`);
    return res.json({ valid: false, trial: false, message: 'License not found. Please re-activate.' });
  }

  // Machine binding enforcement
  if (lic.machineId && machineId && lic.machineId !== machineId) {
    logEvent('deny', `Key ${licenseKey} used from unexpected machine`);
    return res.json({ valid: false, message: 'License is not valid on this device' });
  }
  if (!lic.machineId && machineId) {
    lic.machineId = machineId;
    licenses[licenseKey] = lic;
    saveJson(licensesPath, licenses);
  }

  // Record last seen
  if (machineId) {
    machines[machineId] = machines[machineId] || { firstSeen: nowIso(), keys: [licenseKey] };
    machines[machineId].lastSeen = nowIso();
    if (!machines[machineId].keys.includes(licenseKey)) machines[machineId].keys.push(licenseKey);
    saveJson(machinesPath, machines);
  }

  const status = licenseStatus(lic);
  const valid = status === 'paid' || status === 'trial';

  logEvent(valid ? 'allow' : 'deny', `Key ${licenseKey}: ${status.toUpperCase()}`);
  res.json({
    valid,
    license: {
      customer: lic.customer,
      email: lic.email,
      status,
      created: lic.created,
      expires: lic.expires,
      paid: status === 'paid'
    },
    message: valid ? 'Valid' : (status === 'expired' ? 'License expired' : 'License not active')
  });
});

// Create trial manually (admin)
app.post('/api/create-trial', (req, res) => {
  const { customer, email } = req.body;
  const licenseKey = genKey();
  const licenses = loadJson(licensesPath, {});
  licenses[licenseKey] = {
    customer: customer || 'Unknown',
    email: email || '',
    status: 'trial',
    created: today(),
    expires: inDays(config.trial_days),
    paid: false,
    notes: `Created by admin (${config.trial_days} days)`
  };
  saveJson(licensesPath, licenses);
  logEvent('trial', `Admin created trial ${licenseKey} for ${customer || 'Unknown'}`);
  res.json({ success: true, licenseKey, expires: inDays(config.trial_days) });
});

// ---------- Admin API ----------

// List all licenses with computed status
app.get('/admin/licenses', requireAdmin, (req, res) => {
  const licenses = loadJson(licensesPath, {});
  const machines = loadJson(machinesPath, {});
  const out = {};
  for (const [key, lic] of Object.entries(licenses)) {
    const machine = lic.machineId ? machines[lic.machineId] : null;
    out[key] = {
      ...lic,
      status: licenseStatus(lic),
      lastSeen: machine ? machine.lastSeen : null
    };
  }
  res.json(out);
});

// Activity feed
app.get('/admin/activity', requireAdmin, (req, res) => {
  res.json(activity.slice(0, 50));
});

// Update license
app.post('/admin/update', requireAdmin, (req, res) => {
  const { licenseKey, updates } = req.body;
  const licenses = loadJson(licensesPath, {});
  if (!licenses[licenseKey]) return res.status(404).json({ error: 'License not found' });
  licenses[licenseKey] = { ...licenses[licenseKey], ...updates };
  saveJson(licensesPath, licenses);
  logEvent('admin', `Updated ${licenseKey}: ${JSON.stringify(updates)}`);
  res.json({ success: true, license: licenses[licenseKey] });
});

// Revoke / un-revoke
app.post('/admin/revoke', requireAdmin, (req, res) => {
  const { licenseKey, revoke } = req.body;
  const licenses = loadJson(licensesPath, {});
  if (!licenses[licenseKey]) return res.status(404).json({ error: 'License not found' });
  licenses[licenseKey].status = revoke ? 'revoked' : 'trial';
  licenses[licenseKey].paid = false;
  saveJson(licensesPath, licenses);
  logEvent('admin', `${revoke ? 'REVOKED' : 'Restored'} ${licenseKey}`);
  res.json({ success: true });
});

// Delete license + unbind machine (so machine can trial again if you choose)
app.post('/admin/delete', requireAdmin, (req, res) => {
  const { licenseKey } = req.body;
  const licenses = loadJson(licensesPath, {});
  if (!licenses[licenseKey]) return res.status(404).json({ error: 'License not found' });
  delete licenses[licenseKey];
  saveJson(licensesPath, licenses);
  logEvent('admin', `Deleted ${licenseKey}`);
  res.json({ success: true });
});

// Backup: download all data
app.get('/admin/backup', requireAdmin, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="license_backup.json"');
  res.json({
    exported: nowIso(),
    licenses: loadJson(licensesPath, {}),
    machines: loadJson(machinesPath, {}),
    activity: activity.slice(0, 100)
  });
});

// Serve dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Root
app.get('/', (req, res) => {
  res.json({ service: 'Offline AI License Server', admin: '/admin' });
});

// ---------- Start ----------
const PORT = process.env.PORT || config.port || 3000;
app.listen(PORT, () => {
  console.log(`License server running on port ${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
});

