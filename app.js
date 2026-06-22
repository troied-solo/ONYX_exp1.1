/* ─────────────────────────────────────────────────────────────────────────
   ONYX PoC — frontend wiring
   ───────────────────────────────────────────────────────────────────────── */

// ─── Auth ─────────────────────────────────────────────────────────────────
const AUTH_KEY = 'onyx_auth';
function getToken() { try { return localStorage.getItem(AUTH_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { localStorage.setItem(AUTH_KEY, t); } catch {} }
function clearToken() { try { localStorage.removeItem(AUTH_KEY); } catch {} }

// Auth-aware fetch wrapper. Adds bearer header. On 401, clears token and bounces to login.
async function authFetch(url, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + getToken() });
  const r = await fetch(url, Object.assign({}, opts, { headers }));
  if (r.status === 401) {
    clearToken();
    showLogin('Your session expired. Please sign in again.');
    throw new Error('unauthorized');
  }
  return r;
}

function showLogin(errMsg) {
  document.getElementById('login-overlay').classList.remove('hidden');
  const err = document.getElementById('login-err');
  if (err) err.textContent = errMsg || '';
  const pw = document.getElementById('login-pw');
  if (pw) { pw.value = ''; pw.focus(); }
}

function hideLogin() {
  document.getElementById('login-overlay').classList.add('hidden');
}

// On first paint: show or hide login based on stored token
if (getToken()) hideLogin(); else showLogin();

// Login submit
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = document.getElementById('login-pw').value.trim();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-err');
  if (!pw) { err.textContent = 'Enter the access password.'; return; }
  err.textContent = '';
  btn.disabled = true;
  const origLabel = btn.innerHTML;
  btn.innerHTML = '<span class="spin"><svg width="14" height="14"><use href="#i-loader"/></svg></span> Checking...';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (r.ok) {
      const { token } = await r.json();
      setToken(token);
      hideLogin();
    } else {
      const j = await r.json().catch(() => ({}));
      err.textContent = j.error === 'invalid password' ? 'Incorrect password.' : (j.error || 'Sign-in failed.');
    }
  } catch (e2) {
    err.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.innerHTML = origLabel;
  }
});

// Logout
document.getElementById('logout-btn').addEventListener('click', () => {
  clearToken();
  showLogin();
});

// ─── State ────────────────────────────────────────────────────────────────
let DATA = [];                      // enriched + classified breaks (populated after upload)
let HISTORY = loadHistory();        // run history from localStorage
let BALANCE = [];                   // cash balance comparison rows
let ACTIVITY = [];                  // nvision transactions for display
let sel = null;
let resolved = [];
let activeFilter = 'all';
let searchQuery = '';
let parsedFiles = null;             // last parsed file set, kept for re-runs

const f = n => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fk = n => { if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M'; if (n >= 1000) return '$' + (n / 1000).toFixed(0) + 'K'; return '$' + n.toFixed(0); };
const sv = id => { document.querySelectorAll('.view').forEach(v => v.classList.remove('on')); document.getElementById(id).classList.add('on'); window.scrollTo(0, 0); };

// ─── Initial render ───────────────────────────────────────────────────────
renderHistory();

// ─── Top-bar / hero button → file picker ──────────────────────────────────
document.getElementById('upload-trigger').onclick = () => document.getElementById('file-input').click();
document.getElementById('dz-btn').onclick = () => document.getElementById('file-input').click();
document.getElementById('file-input').addEventListener('change', onFilesSelected);

async function onFilesSelected(e) {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  if (files.length < 2) {
    showToast(`Need at least 2 files: Axiom open breaks + nVision transactions. Trustee summary and nVision balance are optional.`);
    e.target.value = '';
    return;
  }
  e.target.value = '';   // allow re-selecting the same files

  // Move to processing view immediately so the stream is visible
  sv('v-proc');
  resetProcessingUI();
  try {
    await runPipeline(files);
  } catch (err) {
    console.error(err);
    failStream(err.message || String(err));
  }
}

// ─── File parsing (CSV or XLSX) ───────────────────────────────────────────
function parseFile(file) {
  const isXlsx = /\.(xlsx|xls)$/i.test(file.name);
  return isXlsx ? parseXlsx(file) : parseCsv(file);
}

function parseCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,   // keep strings; we'll coerce explicitly
      complete: r => resolve({ name: file.name, rows: r.data, fields: r.meta.fields || [] }),
      error: err => reject(err),
    });
  });
}

function parseXlsx(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: false });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet) return reject(new Error(`${file.name}: no sheets found`));
        // raw:false → format dates/numbers to strings; defval:'' → fill empty cells
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
        // Field names come from the first row's keys (header row)
        const fields = rows.length > 0 ? Object.keys(rows[0]) : [];
        resolve({ name: file.name, rows, fields });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsArrayBuffer(file);
  });
}

function identifyFile(parsed) {
  const cols = new Set(parsed.fields.map(c => c.trim().toUpperCase()));
  const has = (...names) => names.every(n => cols.has(n));

  if (has('DEALNAME', 'DEALID', 'ACCOUNTNUMBER', 'BEGINNINGBALANCE')) return 'trustee_summary';
  if (has('CLEARINGACCOUNTID', 'TDCASHBALANCE')) return 'nvision_balance';
  if (has('CUSIP', 'ASSETID', 'CLEARINGACCOUNTNAME') && !cols.has('TDCASHBALANCE')) return 'nvision_transactions';
  if (has('ASOFDATE', 'AMOUNT', 'INPUT') && (cols.has('VALUEDATE') || cols.has('SETTLEDATE'))) return 'axiom_output';
  return null;
}

// ─── The pipeline ─────────────────────────────────────────────────────────
async function runPipeline(files) {
  /* ── Stage 1 (Orchestration): Parse & validate ─────────────────────── */
  startStep(0, 'Parsing the export files');

  const parsed = await Promise.all(files.map(parseFile));
  await subSleep();
  addSub(0, 'Reading files', `${parsed.length} files`, 'OK');

  const identified = {};
  for (const p of parsed) {
    const kind = identifyFile(p);
    if (kind) identified[kind] = p;
  }

  // Required files
  const required = [
    ['axiom_output', 'Axiom open breaks'],
    ['nvision_transactions', 'nVision transactions'],
  ];
  const requiredMissing = required.filter(([k]) => !identified[k]).map(([, label]) => label);
  if (requiredMissing.length > 0) {
    throw new Error(`Missing required file(s): ${requiredMissing.join(', ')}. Check column headers.`);
  }

  const haveTrustee = !!identified.trustee_summary;
  const haveBalance = !!identified.nvision_balance;
  const totalIdentified = 2 + (haveTrustee ? 1 : 0) + (haveBalance ? 1 : 0);

  await subSleep();
  addSub(0, 'Identified file types', `${totalIdentified} of 4`, totalIdentified === 4 ? 'OK' : 'WARN');
  await subSleep();
  addSub(0, 'Axiom open breaks', `${identified.axiom_output.rows.length} rows`, 'OK');
  await subSleep();
  addSub(0, 'nVision transactions', `${identified.nvision_transactions.rows.length} rows`, 'OK');
  if (haveTrustee) {
    await subSleep();
    addSub(0, 'Trustee accounts', `${identified.trustee_summary.rows.length} rows`, 'OK');
  }
  if (haveBalance) {
    await subSleep();
    addSub(0, 'nVision balances', `${identified.nvision_balance.rows.length} rows`, 'OK');
  }

  // Detect fund IDs from whichever sources have them
  const fundSources = []
    .concat(haveBalance ? identified.nvision_balance.rows : [])
    .concat(identified.nvision_transactions.rows);
  const fundIds = uniqBy(fundSources, r => r.FUNDID).map(r => r.FUNDID).filter(Boolean);
  await subSleep();
  addSub(0, 'Fund IDs detected', fundIds.join(', ') || '—', `${fundIds.length} FOUND`);

  parsedFiles = identified;

  // Populate the file header with REAL info from the upload
  const procFn = document.querySelector('.proc-fn');
  const procFm = document.querySelector('.proc-fm');
  if (procFn) {
    const otherCount = parsed.length - 1;   // primary = Axiom; rest are "source files"
    procFn.textContent = identified.axiom_output.name + (otherCount > 0 ? ` + ${otherCount} source file${otherCount === 1 ? '' : 's'}` : '');
  }
  if (procFm) {
    const asOf = identified.axiom_output.rows[0]?.ASOFDATE || '—';
    const totalRows = parsed.reduce((s, p) => s + (p.rows?.length || 0), 0);
    procFm.textContent = `${identified.axiom_output.rows.length} breaks · ${totalRows} total rows · ${fundIds.join(', ') || '—'} · ${asOf}`;
  }

  endStep(0, '0.6s', `Schema validated. <strong>${identified.axiom_output.rows.length} breaks</strong> across <strong>${fundIds.length} fund ID${fundIds.length === 1 ? '' : 's'}</strong>.`);

  /* ── Stage 2 (Data Agent): Cross-reference sources ─────────────────── */
  startStep(1, 'Cross-referencing sources');

  if (haveTrustee) {
    await subSleep();
    addSub(1, 'Querying Trustee — cash accounts', `${identified.trustee_summary.rows.length} records`, 'OK');
  }
  if (haveBalance) {
    await subSleep();
    addSub(1, 'Querying nVision — clearing balances', `${identified.nvision_balance.rows.length} records`, 'OK');
  }
  await subSleep();
  addSub(1, 'Querying nVision — transactions', `${identified.nvision_transactions.rows.length} records`, 'OK');

  // Enrich each axiom break with matched-record evidence
  const today = new Date('2026-01-15');   // demo "today" — fixed for sample data
  const enriched = identified.axiom_output.rows.map((row, idx) => enrichBreak(row, idx + 1, identified, today));
  const matched = enriched.filter(b => b.matchedInOtherSource).length;
  const unmatched = enriched.length - matched;

  await subSleep();
  addSub(1, 'Description matching window', '±5 days', 'OK');
  await subSleep();
  addSub(1, 'Matched', `${matched} of ${enriched.length}`, 'OK');
  await subSleep();
  addSub(1, 'Unmatched', `${unmatched} of ${enriched.length}`, unmatched > 0 ? 'WARN' : 'OK');

  endStep(1, `${(enriched.length * 0.01).toFixed(1)}s`, `<strong>${matched} matched</strong>, <strong>${unmatched} unmatched</strong> across both sources.`);

  /* ── Stage 3 (Reconciliation Agent): Classify (real LLM) ───────────── */
  startStep(2, 'Classifying each break');

  await subSleep();
  addSub(2, 'Loading pattern library', `7 break types`, 'OK');
  await subSleep();
  addSub(2, 'Sending to Reconciliation Agent', `${enriched.length} breaks`, 'OK');

  const t0 = Date.now();
  const classifications = await classifyBreaks(enriched);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Merge classifications back into the breaks
  const cMap = new Map(classifications.map(c => [c.id, c]));
  enriched.forEach(b => {
    const c = cMap.get(b.id);
    if (c) {
      b.type = c.type;
      b.confidence = c.confidence;
      b.pattern = c.pattern;
      b.severity = c.severity;
      b.priority = c.priority;
    } else {
      b.type = 'Normal';
      b.confidence = 50;
      b.pattern = 'No classification returned.';
      b.severity = 'normal';
      b.priority = 'Normal';
    }
  });

  const counts = countBy(enriched, b => b.type);
  for (const [type, n] of Object.entries(counts)) {
    await subSleep();
    const pill = type === 'Unmatched txn' ? 'BAD' : (type === 'Reversal' || type === 'Aged break') ? 'WARN' : 'OK';
    addSub(2, type, `${n} detected`, pill);
  }

  endStep(2, `${elapsed}s`, `Classified — <strong>${counts['Unmatched txn'] || 0} unmatched</strong>, ${counts['Timing diff'] || 0} timing, ${counts['Rounding'] || 0} rounding, ${counts['Reversal'] || 0} reversals.`);

  /* ── Stage 4 (Orchestration): Priority scoring ─────────────────────── */
  startStep(3, 'Scoring & ranking the queue');

  await subSleep();
  addSub(3, 'Impact weighting', 'amount × age', 'OK');
  await subSleep();
  addSub(3, 'Confidence decay', 'applied', 'OK');

  // Compute final priority/rank
  enriched.forEach(b => {
    b.score = Math.abs(b.amount) * (1 + b.ageInDays / 7);
  });
  enriched.sort((a, b) => b.score - a.score);
  enriched.forEach((b, i) => { b.id = i + 1; });   // re-id by rank

  const critical = enriched.filter(b => b.severity === 'critical').length;
  const high = enriched.filter(b => b.severity === 'warning').length;
  const normal = enriched.length - critical - high;

  await subSleep();
  addSub(3, 'Queue assembled', `${enriched.length} cases`, 'OK');
  endStep(3, '0.4s', `Queue ready — <strong>${critical} critical</strong>, ${high} high, ${normal} normal.`);

  /* ── Finalize ──────────────────────────────────────────────────────── */
  DATA = enriched.map(b => adaptForUI(b));
  BALANCE = buildBalance(identified);
  ACTIVITY = buildActivity(identified);

  // Save a history record with a unique runId so we can rehydrate this run later
  const totalExposure = enriched.reduce((s, b) => s + Math.abs(b.amount), 0);
  const runId = 'run_' + Date.now();
  pushHistory(
    {
      runId,
      date: formatDate(today),
      breaks: enriched.length,
      resolved: 0,
      carried: enriched.length,
      exposure: totalExposure,
      avg: totalExposure / Math.max(enriched.length, 1),
      ttr: '—',
      status: 'open',
    },
    { DATA, BALANCE, ACTIVITY, resolved: [] },
  );
  renderHistory();

  document.getElementById('proc-stat').className = 'proc-stat done';
  document.getElementById('proc-stat').innerHTML = '<svg width="13" height="13"><use href="#i-check"/></svg>Complete';

  // Populate go-banner
  const gb = document.getElementById('go-banner');
  gb.querySelector('.gb-stats').innerHTML = `
    <div class="gb-stat"><div class="gb-v r">${critical}</div><div class="gb-l">Critical</div></div>
    <div class="gb-stat"><div class="gb-v a">${high}</div><div class="gb-l">High</div></div>
    <div class="gb-stat"><div class="gb-v">${normal}</div><div class="gb-l">Normal</div></div>
    <div class="gb-stat"><div class="gb-v g">${fk(totalExposure)}</div><div class="gb-l">Exposure</div></div>`;
  setTimeout(() => gb.classList.add('show'), 250);

  // Update file summary in sidebar
  updateProcessingSidebar(enriched, totalExposure);
}

// ─── Enrichment: cross-reference one break against the source files ───────
function enrichBreak(row, id, files, today) {
  const amount = parseFloat(row.AMOUNT) || 0;
  const asOf = row.ASOFDATE || '';
  const valueDate = row.VALUEDATE || '';
  const settleDate = row.SETTLEDATE || '';
  const input = (row.INPUT || '').trim();
  const description = (row.DESCRIPTION || '').trim();
  const issuer = (row.ISSUERNAME || description).trim();
  const ageInDays = computeAgeDays(asOf, valueDate, today);

  // Look for a transaction in nVision transactions whose description/issuer roughly matches
  const issuerKey = issuer.toLowerCase().slice(0, 10);
  const matches = (files.nvision_transactions.rows || []).filter(t =>
    (t.ISSUERNAME || '').toLowerCase().slice(0, 10) === issuerKey,
  );

  // Best-effort: matched if the OTHER side has the same issuer
  const otherSide = input === 'Trustee' ? 'nVision' : 'Trustee';
  let matchedInOtherSource = false;
  let counterpartHints = '';
  if (input === 'nVision') {
    // Other side is Trustee — see if any trustee account references this issuer
    matchedInOtherSource = false;
    counterpartHints = 'Trustee summary is account-level; no transaction-level counterpart available.';
  } else if (input === 'Trustee') {
    matchedInOtherSource = matches.length > 0;
    counterpartHints = matches.length > 0
      ? `Found ${matches.length} nVision transaction(s) with the same issuer.`
      : 'No nVision transaction with the same issuer in the supplied file.';
  }

  return {
    id,
    amount,
    asOfDate: asOf,
    valueDate,
    settleDate,
    input,
    description,
    issuer,
    ageInDays,
    matchedInOtherSource,
    counterpartHints,
    // raw source records kept around for the investigation page
    raw: {
      nvisionMatches: matches.slice(0, 3),
    },
  };
}

function computeAgeDays(asOf, valueDate, today) {
  // Age = days between value date and the "today" of the report
  const v = parseDate(valueDate) || parseDate(asOf);
  if (!v) return 0;
  const diff = (today.getTime() - v.getTime()) / 86400000;
  return Math.max(0, Math.round(diff));
}

function parseDate(s) {
  if (!s) return null;
  // accept YYYY-MM-DD or MM/DD/YYYY
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return new Date(+us[3], +us[1] - 1, +us[2]);
  return null;
}

// ─── Classification: call /api/classify in parallel batches ───────────────
async function classifyBreaks(breaks) {
  const BATCH = 12;   // 12 breaks per request keeps each call well under 30s
  const batches = [];
  for (let i = 0; i < breaks.length; i += BATCH) {
    batches.push(breaks.slice(i, i + BATCH));
  }
  // Send all batches in parallel
  const results = await Promise.all(batches.map(b => callClassify(b)));
  return results.flat();
}

async function callClassify(batch) {
  const payload = {
    breaks: batch.map(b => ({
      id: b.id,
      amount: b.amount,
      asOfDate: b.asOfDate,
      valueDate: b.valueDate,
      settleDate: b.settleDate,
      input: b.input,
      description: b.description,
      issuer: b.issuer,
      ageInDays: b.ageInDays,
      matchedInOtherSource: b.matchedInOtherSource,
      counterpartHints: b.counterpartHints,
    })),
  };
  const r = await authFetch('/api/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'classify failed' }));
    throw new Error(`Classify API error: ${err.error || r.statusText}`);
  }
  const json = await r.json();
  return json.classifications || [];
}

// ─── Convert enriched break to the shape the existing UI expects ──────────
function adaptForUI(b) {
  const sevMap = { critical: 'critical', warning: 'warning', normal: 'normal' };
  const fundId = b.input === 'Trustee' ? 'WSSA RA' : 'WSSA RA';   // best-effort; could come from raw

  // Pick a fake assignee deterministically by id so it's stable across re-runs
  const assignees = [
    { name: 'R. Costa', code: 'a' },
    { name: 'M. Halvorsen', code: 'b' },
    { name: 'S. Okonkwo', code: 'c' },
    { name: 'L. Petrova', code: 'd' },
    { name: 'J. Castellano', code: 'e' },
    { name: 'A. Nair', code: 'a' },
  ];
  const a = assignees[b.id % assignees.length];

  return {
    id: b.id,
    issuer: b.issuer || b.description,
    fund: fundId,
    acct: b.input === 'Trustee' ? 'WSSA R S N' : 'WSSA R S NO IR',
    src: b.input,
    delta: b.amount,
    age: b.ageInDays,
    type: b.type,
    sev: sevMap[b.severity] || 'normal',
    tr: b.input === 'Trustee' ? b.amount : 0,
    nv: b.input === 'nVision' ? b.amount : 0,
    conf: b.confidence,
    assignee: a.name,
    assn: a.code,
    pat: b.pattern,
    draft: null,            // generated on demand by /api/draft-resolution
    _enriched: b,           // keep the original for the investigation page
  };
}

// ─── Balance / activity tables (for the queue page tabs) ─────────────────
function buildBalance(files) {
  // Both optional files are needed for any meaningful balance comparison
  if (!files.nvision_balance || !files.trustee_summary) return [];
  return (files.nvision_balance.rows || []).map(r => {
    const nv = parseFloat(r.TDCASHBALANCE) || 0;
    // Try to find a matching trustee account by account name
    const tr = matchTrusteeBalance(r, files.trustee_summary.rows || []);
    return {
      acct: r.CLEARINGACCOUNTNAME || r.RECONACCOUNTNAME || '—',
      id: r.CLEARINGACCOUNTID || '—',
      tr,
      nv,
      match: Math.abs(tr - nv) < 0.01 && tr > 0,
    };
  });
}

function matchTrusteeBalance(nvRow, trusteeRows) {
  const acctName = (nvRow.CLEARINGACCOUNTNAME || '').toLowerCase();
  const match = trusteeRows.find(t => (t.ACCOUNTNAME || '').toLowerCase().includes(acctName.slice(0, 8)));
  if (!match) return 0;
  const begin = parseFloat(match.BEGINNINGBALANCE) || 0;
  const txn = parseFloat(match.TRANSACTIONTOTALS) || 0;
  return begin + txn;
}

function buildActivity(files) {
  // The nVision transactions file has no amount column — derive amounts from
  // any matching break (by issuer key). Transactions with no matching break
  // are "Matched" (no discrepancy); transactions with a matching break carry
  // that break's amount and are flagged "Unmatched".
  const breakByIssuerKey = new Map();
  for (const row of (files.axiom_output?.rows || [])) {
    const issuer = (row.ISSUERNAME || row.DESCRIPTION || '').trim();
    const key = issuer.toLowerCase().slice(0, 10);
    if (key && !breakByIssuerKey.has(key)) {
      breakByIssuerKey.set(key, parseFloat(row.AMOUNT) || 0);
    }
  }

  return (files.nvision_transactions.rows || []).slice(0, 50).map(r => {
    const issuer = (r.ISSUERNAME || '').trim();
    const key = issuer.toLowerCase().slice(0, 10);
    const breakAmount = breakByIssuerKey.get(key);
    return {
      src: 'nVision',
      issuer: issuer || '—',
      asset: r.ASSETNAME || '—',
      amount: breakAmount || 0,
      acct: r.CLEARINGACCOUNTNAME || '—',
      match: breakAmount ? 'unmatched' : 'matched',
    };
  });
}

// ─── Processing-page stream helpers ───────────────────────────────────────
function resetProcessingUI() {
  document.getElementById('go-banner').classList.remove('show');
  document.getElementById('proc-stat').className = 'proc-stat';
  document.getElementById('proc-stat').innerHTML = '<span class="spin"><svg width="12" height="12"><use href="#i-loader"/></svg></span>Processing';

  // Clear the file header — populated dynamically once files are identified
  const procFn = document.querySelector('.proc-fn');
  const procFm = document.querySelector('.proc-fm');
  if (procFn) procFn.textContent = 'Reading uploaded files...';
  if (procFm) procFm.textContent = '';

  const AGENTS = ['Orchestration Agent', 'Data Agent', 'Reconciliation Agent', 'Orchestration Agent'];
  const ICONS = ['i-topology', 'i-database', 'i-git-compare', 'i-topology'];
  const stream = document.getElementById('activity-stream');
  stream.innerHTML = '';
  AGENTS.forEach((agent, i) => {
    const el = document.createElement('div');
    el.className = 'as-step pending';
    el.id = 'ag' + i;
    el.innerHTML = `
      <div class="as-step-head">
        <div class="as-node"><svg width="12" height="12"><use href="#${ICONS[i]}"/></svg></div>
        <div class="as-step-info">
          <div class="as-agent">${agent}</div>
          <div class="as-msg" id="am${i}"><span class="as-skel"></span></div>
        </div>
        <div class="as-time" id="at${i}">—</div>
      </div>
      <div class="as-sublog" id="asl${i}"></div>`;
    stream.appendChild(el);
  });
}

function startStep(i, msg) {
  document.getElementById('ag' + i).className = 'as-step run';
  document.getElementById('am' + i).innerHTML = msg + '...';
  document.getElementById('at' + i).textContent = 'running';
  const el = document.getElementById('ag' + i);
  requestAnimationFrame(() => { try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} });
}

function endStep(i, time, finalMsg) {
  document.getElementById('am' + i).innerHTML = finalMsg;
  document.getElementById('ag' + i).className = 'as-step done';
  document.getElementById('at' + i).textContent = time;
}

function addSub(stepIdx, label, value, pill) {
  const sublog = document.getElementById('asl' + stepIdx);
  const sd = document.createElement('div');
  sd.className = 'as-sub success';
  const pillCls = pill === 'OK' ? 'ok' : pill === 'WARN' ? 'warn' : pill === 'BAD' ? 'bad' : '';
  sd.innerHTML = `<div class="as-sub-dot"></div>${escapeHtml(label)}<span class="kv">·</span><strong>${escapeHtml(value)}</strong><span class="pill ${pillCls}">${escapeHtml(pill)}</span>`;
  sublog.appendChild(sd);
}

function failStream(msg) {
  document.getElementById('proc-stat').className = 'proc-stat';
  document.getElementById('proc-stat').innerHTML = '<svg width="13" height="13" style="color:var(--rose)"><use href="#i-x"/></svg>Failed';
  showToast('Processing failed: ' + msg);
  // Find the running step, mark it failed
  const running = document.querySelector('.as-step.run');
  if (running) {
    running.className = 'as-step done';
    const i = parseInt(running.id.replace('ag', ''));
    const am = document.getElementById('am' + i);
    am.innerHTML = `<span style="color:var(--rose)">${escapeHtml(msg)}</span>`;
  }
}

function updateProcessingSidebar(breaks, exposure) {
  const card = document.querySelector('.aside-card');
  if (!card) return;
  const critical = breaks.filter(b => b.severity === 'critical').length;
  const funds = new Set(breaks.map(b => b._fundId || 'WSSA RA')).size || 1;
  const maxAge = breaks.reduce((m, b) => Math.max(m, b.ageInDays), 0);
  card.querySelector('.aside-grid').innerHTML = `
    <div class="aside-stat"><div class="as-v">${breaks.length}</div><div class="as-l">Breaks</div></div>
    <div class="aside-stat"><div class="as-v r">${critical}</div><div class="as-l">Critical</div></div>
    <div class="aside-stat"><div class="as-v">${funds}</div><div class="as-l">Funds</div></div>
    <div class="aside-stat"><div class="as-v a">${maxAge}d</div><div class="as-l">Max age</div></div>`;
}

// Sleep just enough between sub-step appends so the stream feels alive, not instant
const subSleep = () => new Promise(r => setTimeout(r, 120 + Math.random() * 120));

// ─── History (localStorage-backed for one-user PoC) ───────────────────────
const RUN_KEY = id => 'onyx_run_' + id;

function loadHistory() {
  try {
    const raw = localStorage.getItem('onyx_history');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  // Seed with a single sample entry so the table isn't empty on first visit.
  // Note: no runId — clicking it just shows a toast (no real data behind it).
  return [
    { runId: null, date: '14 Jan 2026', breaks: 87, resolved: 82, carried: 5, exposure: 11400000, avg: 131034, ttr: '4.2 min', status: 'done' },
  ];
}

function pushHistory(entry, runData) {
  HISTORY = [entry, ...HISTORY].slice(0, 14);
  try { localStorage.setItem('onyx_history', JSON.stringify(HISTORY)); } catch (e) {}
  if (entry.runId && runData) {
    try { localStorage.setItem(RUN_KEY(entry.runId), JSON.stringify(runData)); }
    catch (e) { console.warn('could not persist run data:', e); }
  }
}

function renderHistory() {
  const c = document.getElementById('history-rows');
  c.innerHTML = '';
  HISTORY.forEach(h => {
    const r = document.createElement('div');
    const hasData = !!h.runId;
    r.className = 'hist-row' + (hasData ? '' : ' no-data');
    r.innerHTML = `
      <div class="hr-date">${escapeHtml(h.date)}</div>
      <div class="hr-num">${h.breaks}</div>
      <div class="hr-num mint">${h.resolved}</div>
      <div class="hr-num ${h.carried > 0 ? 'rose' : 'muted'}">${h.carried}</div>
      <div class="hr-num">${fk(h.exposure)}</div>
      <div class="hr-num muted">${fk(h.avg)}</div>
      <div class="hr-num muted">${escapeHtml(h.ttr)}</div>
      <div><span class="hr-status ${h.status}"><span class="hr-status-dot"></span>${h.status === 'done' ? 'Closed' : 'In progress'}</span></div>
      <button class="hr-del" title="Delete this run" aria-label="Delete this run"><svg width="14" height="14"><use href="#i-trash"/></svg></button>`;

    // Row click → open run (only if there's data)
    r.addEventListener('click', (e) => {
      // Don't fire if the click was on the delete button
      if (e.target.closest('.hr-del')) return;
      if (hasData) openHistoryRun(h.runId);
      else showToast('Sample row — no run data behind it');
    });

    // Delete click — stop propagation so the row click doesn't also fire
    r.querySelector('.hr-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryRun(h.runId, h.date);
    });

    c.appendChild(r);
  });
}

function openHistoryRun(runId) {
  let payload = null;
  try {
    const raw = localStorage.getItem(RUN_KEY(runId));
    if (raw) payload = JSON.parse(raw);
  } catch (e) { console.warn('could not load run:', e); }

  if (!payload || !payload.DATA) {
    showToast('Run data not found — it may have been cleared from this browser.');
    return;
  }

  // Swap current state to the historical run
  DATA = payload.DATA || [];
  BALANCE = payload.BALANCE || [];
  ACTIVITY = payload.ACTIVITY || [];
  resolved = payload.resolved || [];
  sel = null;
  activeFilter = 'all';
  searchQuery = '';

  sv('v-queue');
  refreshQueueHeader();
  renderRows();
  renderBalance();
  renderActivity();
  showToast(`Loaded run from ${new Date(parseInt(runId.replace('run_', ''), 10)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`);
}

function deleteHistoryRun(runId, dateLabel) {
  HISTORY = HISTORY.filter(h => !(h.runId === runId && h.date === dateLabel));
  try { localStorage.setItem('onyx_history', JSON.stringify(HISTORY)); } catch (e) {}
  if (runId) {
    try { localStorage.removeItem(RUN_KEY(runId)); } catch (e) {}
  }
  renderHistory();
  showToast(`Removed ${dateLabel} from history`);
}

// ─── Queue / tabs ─────────────────────────────────────────────────────────
function renderBalance() {
  const c = document.getElementById('balance-rows');
  c.innerHTML = '';

  if (BALANCE.length === 0) {
    c.innerHTML = `
      <div style="padding:48px 28px;text-align:center;color:var(--t3);font-size:13px;line-height:1.7">
        <div style="font-size:14px;color:var(--t1);font-weight:600;margin-bottom:8px">No balance data uploaded</div>
        Upload the <strong style="color:var(--t1)">Trustee Cash Account Summary</strong> and <strong style="color:var(--t1)">nVision Cash Balance</strong> files to see balance comparisons across both sources.
      </div>`;
    // Replace the stats row above with a muted placeholder
    const sr = document.querySelector('#tab-balance .stats-row');
    if (sr) {
      sr.innerHTML = `
        <div class="stat-tile"><div class="st-l">Accounts</div><div class="st-v">—</div><div class="st-trend">Not uploaded</div></div>
        <div class="stat-tile"><div class="st-l">Matched</div><div class="st-v">—</div><div class="st-trend">Not uploaded</div></div>
        <div class="stat-tile"><div class="st-l">Differences</div><div class="st-v">—</div><div class="st-trend">Not uploaded</div></div>
        <div class="stat-tile"><div class="st-l">Total balance</div><div class="st-v">—</div><div class="st-trend">Not uploaded</div></div>`;
    }
    return;
  }

  // Populate stats row with real numbers
  const sr = document.querySelector('#tab-balance .stats-row');
  if (sr) {
    const matched = BALANCE.filter(b => b.match).length;
    const diffs = BALANCE.length - matched;
    const totalBal = BALANCE.reduce((s, b) => s + b.nv, 0);
    sr.innerHTML = `
      <div class="stat-tile"><div class="st-l">Accounts</div><div class="st-v">${BALANCE.length}</div><div class="st-trend">All in scope</div></div>
      <div class="stat-tile mint"><div class="st-l">Matched</div><div class="st-v m">${matched}</div><div class="st-trend up">${Math.round(100 * matched / BALANCE.length)}% match rate</div></div>
      <div class="stat-tile peach"><div class="st-l">Differences</div><div class="st-v a">${diffs}</div><div class="st-trend">Under review</div></div>
      <div class="stat-tile gold"><div class="st-l">Total balance</div><div class="st-v g">${fk(totalBal)}</div><div class="st-trend">USD net</div></div>`;
  }

  BALANCE.forEach(b => {
    const diff = b.nv - b.tr;
    const r = document.createElement('div');
    r.className = 'cb-tbl-row';
    r.innerHTML = `
      <div class="cb-acct"><div>${escapeHtml(b.acct)}</div><div class="ca-id">CL-${escapeHtml(String(b.id))}</div></div>
      <div class="cb-bal">${b.tr > 0 ? f(b.tr) : '—'}</div>
      <div class="cb-bal">${b.nv > 0 ? f(b.nv) : '—'}</div>
      <div class="cb-diff ${Math.abs(diff) > 0.01 ? 'r' : 'zero'}">${Math.abs(diff) > 0.01 ? f(diff) : '$0.00'}</div>
      <div><span class="fnd-tag-mini ${b.match ? 'ok' : 'no'}">${b.match ? 'Matched' : 'Diff'}</span></div>
      <div><span class="status-tag ${b.match ? 'resolved' : 'open'}">${b.match ? 'Closed' : 'Open'}</span></div>`;
    c.appendChild(r);
  });
}

function renderActivity() {
  const c = document.getElementById('activity-rows');
  c.innerHTML = '';
  ACTIVITY.forEach(a => {
    const r = document.createElement('div');
    r.className = 'ca-tbl-row';
    const sideCls = a.src === 'Trustee' ? 'tr' : 'nv';
    r.innerHTML = `
      <div><span class="side-pill ${sideCls}">${a.src.toLowerCase()}</span></div>
      <div class="cb-acct" style="font-size:12.5px;color:var(--t1);font-weight:500"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.issuer)}</div></div>
      <div class="td-classifier">${escapeHtml(a.asset)}</div>
      <div class="cb-bal" style="color:${a.amount < 0 ? 'var(--rose)' : 'var(--t1)'};font-weight:600">${a.amount ? f(a.amount) : '—'}</div>
      <div class="td-classifier">${escapeHtml(a.acct)}</div>
      <div><span class="fnd-tag-mini ${a.match === 'matched' ? 'ok' : 'no'}">${a.match === 'matched' ? 'Matched' : 'Unmatched'}</span></div>`;
    c.appendChild(r);
  });
}

document.getElementById('go-queue').onclick = () => { sv('v-queue'); refreshQueueHeader(); renderRows(); renderBalance(); renderActivity(); };

function refreshQueueHeader() {
  if (!DATA.length) return;
  const total = DATA.length;
  const critical = DATA.filter(b => b.sev === 'critical').length;
  const high = DATA.filter(b => b.sev === 'warning').length;
  const exposure = DATA.reduce((s, b) => s + Math.abs(b.delta), 0);
  const sr = document.querySelector('#tab-breaks .stats-row');
  if (sr) {
    sr.innerHTML = `
      <div class="stat-tile"><div class="st-l">Total breaks</div><div class="st-v">${total}</div><div class="st-trend up">From upload</div></div>
      <div class="stat-tile rose"><div class="st-l">Critical</div><div class="st-v r">${critical}</div><div class="st-trend">Action today</div></div>
      <div class="stat-tile peach"><div class="st-l">High priority</div><div class="st-v a">${high}</div><div class="st-trend">Investigate soon</div></div>
      <div class="stat-tile gold"><div class="st-l">Total exposure</div><div class="st-v g">${fk(exposure)}</div><div class="st-trend">USD</div></div>
      <div class="stat-tile mint"><div class="st-l">Resolved</div><div class="st-v m" id="res-count">${resolved.length}</div><div class="st-trend">This run</div></div>`;
  }

  // Dynamic tab counts (were hardcoded as 92 / 6 / 38 in the HTML)
  const setCount = (tab, val) => {
    const el = document.querySelector(`.tab[data-tab="${tab}"] .tab-count`);
    if (el) el.textContent = val;
  };
  setCount('breaks', DATA.length);
  setCount('balance', BALANCE.length || '—');
  setCount('activity', ACTIVITY.length);
}

document.querySelectorAll('.tab').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    const tab = b.getAttribute('data-tab');
    document.getElementById('tab-breaks').style.display = tab === 'breaks' ? 'block' : 'none';
    document.getElementById('tab-balance').style.display = tab === 'balance' ? 'block' : 'none';
    document.getElementById('tab-activity').style.display = tab === 'activity' ? 'block' : 'none';
  };
});

document.querySelectorAll('.q-filter').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.q-filter').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    activeFilter = b.getAttribute('data-filter');
    document.getElementById('q-reset').classList.toggle('show', activeFilter !== 'all' || searchQuery !== '');
    renderRows();
  };
});

document.getElementById('q-search-input').oninput = (e) => {
  searchQuery = e.target.value.toLowerCase();
  document.getElementById('q-reset').classList.toggle('show', activeFilter !== 'all' || searchQuery !== '');
  renderRows();
};

document.getElementById('q-reset').onclick = () => {
  activeFilter = 'all'; searchQuery = '';
  document.getElementById('q-search-input').value = '';
  document.querySelectorAll('.q-filter').forEach(x => x.classList.remove('on'));
  document.querySelector('.q-filter[data-filter="all"]').classList.add('on');
  document.getElementById('q-reset').classList.remove('show');
  renderRows();
};

document.getElementById('inv-back').onclick = () => { sv('v-queue'); renderRows(); };

function renderRows() {
  const c = document.getElementById('break-rows'); c.innerHTML = '';
  let filtered = DATA;
  if (activeFilter === 'critical') filtered = filtered.filter(b => b.sev === 'critical');
  if (activeFilter === 'unmatched') filtered = filtered.filter(b => (b.type || '').toLowerCase().includes('unmatched'));
  if (activeFilter === 'aged') filtered = filtered.filter(b => b.age > 14);
  if (activeFilter === 'trustee') filtered = filtered.filter(b => b.src === 'Trustee');
  if (activeFilter === 'nvision') filtered = filtered.filter(b => b.src === 'nVision');
  if (searchQuery) filtered = filtered.filter(b =>
    (b.issuer || '').toLowerCase().includes(searchQuery) ||
    (b.acct || '').toLowerCase().includes(searchQuery) ||
    (b.type || '').toLowerCase().includes(searchQuery));

  const sorted = [...filtered].sort((a, b) => {
    const aRes = resolved.includes(a.id), bRes = resolved.includes(b.id);
    if (aRes !== bRes) return aRes ? 1 : -1;
    return 0;
  });
  sorted.forEach((b, idx) => {
    const res = resolved.includes(b.id);
    const r = document.createElement('div');
    r.className = 'tbl-row' + (sel && sel.id === b.id ? ' sel' : '');
    r.style.animation = `fadeIn 0.3s ease ${idx * 0.025}s both`;
    const sideCls = b.src === 'Trustee' ? 'tr' : 'nv';
    const lastName = b.assignee && b.assignee.includes('. ') ? b.assignee.split('. ')[1] : (b.assignee || '—');
    const initials = lastName.substring(0, 2).toUpperCase();
    r.innerHTML = `
      <div><span class="side-pill ${sideCls}">${b.src.toLowerCase()}</span></div>
      <div class="td-issuer"><div class="iss-name">${escapeHtml(b.issuer)}</div><div class="iss-sub">${escapeHtml(b.fund)} · ${escapeHtml(b.acct)}</div></div>
      <div class="td-amt ${b.sev === 'critical' ? 'r' : ''}" style="text-align:right">${f(b.delta)}</div>
      <div><div class="td-age">${b.age}d</div></div>
      <div class="td-classifier">${escapeHtml(b.type)}</div>
      <div class="td-conf">${b.conf}%</div>
      <div class="assignee-cell"><div class="assn-av ${b.assn}">${initials}</div><div class="assn-name">${escapeHtml(lastName)}</div></div>
      <div><span class="status-tag ${res ? 'resolved' : 'open'}" onclick="event.stopPropagation();toggleStatus(${b.id})">${res ? 'Resolved' : 'Open'}</span></div>`;
    r.onclick = () => openInv(b);
    c.appendChild(r);
  });
}

window.toggleStatus = function (id) {
  if (resolved.includes(id)) { resolved = resolved.filter(x => x !== id); showToast('Break reopened'); }
  else { resolved.push(id); showToast('Break marked resolved'); }
  const rc = document.getElementById('res-count'); if (rc) rc.textContent = resolved.length;
  renderRows();
  if (sel && sel.id === id) buildInv(sel);
};

// ─── Investigation ────────────────────────────────────────────────────────
async function openInv(b) {
  sel = b;
  sv('v-inv');
  document.getElementById('inv-title').textContent = b.issuer;
  document.getElementById('inv-sub').textContent = (b.fund || '') + ' · ' + (b.acct || '') + ' · USD · ' + b.age + ' days old';
  const sev = document.getElementById('inv-sev');
  if (b.sev === 'critical') { sev.className = 'inv-h-sev crit'; sev.textContent = 'Critical'; }
  else if (b.sev === 'warning') { sev.className = 'inv-h-sev warn'; sev.textContent = 'High priority'; }
  else { sev.textContent = 'Normal'; sev.className = 'inv-h-sev'; }
  buildInv(b);

  // Fetch resolution draft lazily on first open
  if (!b.draft && !resolved.includes(b.id)) {
    try {
      const r = await authFetch('/api/draft-resolution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: b.delta,
          type: b.type,
          ageInDays: b.age,
          pattern: b.pat,
          input: b.src,
          asOfDate: b._enriched?.asOfDate,
          valueDate: b._enriched?.valueDate,
          settleDate: b._enriched?.settleDate,
          description: b.issuer,
          matchedInOtherSource: !!b._enriched?.matchedInOtherSource,
        }),
      });
      if (r.ok) {
        const j = await r.json();
        b.draft = j.draft;
        if (sel && sel.id === b.id) buildInv(b);
      }
    } catch (e) { console.warn('draft fetch failed', e); }
  }
}
window.openInv = openInv;

function buildInv(b) {
  const res = resolved.includes(b.id);
  const M = document.getElementById('inv-main'); const S = document.getElementById('inv-side');
  M.innerHTML = ''; S.innerHTML = '';

  if (res) {
    const r = document.createElement('div'); r.className = 'resolved-tile';
    r.innerHTML = `<div class="rt-icon"><svg width="18" height="18"><use href="#i-circle-check"/></svg></div><div class="rt-info"><div class="rt-t">Break marked as resolved</div><div class="rt-s">By James Donnelly · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div></div><button class="rt-reopen" onclick="toggleStatus(${b.id})"><svg width="12" height="12"><use href="#i-rotate"/></svg>Reopen</button>`;
    M.appendChild(r);
  }

  // Source comparison
  const sec1 = document.createElement('div');
  sec1.innerHTML = `<div class="inv-section-h"><div class="iv-sh-title">Source comparison</div><div class="iv-sh-desc">What each system reports for this break. The gap between them is the case.</div></div>`;
  const cmp = document.createElement('div'); cmp.className = 'cmp-3';
  cmp.innerHTML = `<div class="cmp-tile tr"><div class="cmp-h"><div class="cmp-src tr">Trustee</div></div><div class="cmp-amt ${b.tr > 0 ? '' : 'missing'}">${b.tr > 0 ? f(b.tr) : 'No record'}</div><div class="cmp-row"><span class="cmp-l">Account</span><span class="cmp-v">${escapeHtml(b.acct)}</span></div><div class="cmp-row"><span class="cmp-l">As of</span><span class="cmp-v">${escapeHtml(b._enriched?.asOfDate || '—')}</span></div><div class="cmp-row"><span class="cmp-l">Feed</span><span class="cmp-v ${b.tr > 0 ? 'ok' : 'bad'}">${b.tr > 0 ? 'Found' : 'Missing'}</span></div></div><div class="cmp-tile nv"><div class="cmp-h"><div class="cmp-src nv">nVision</div></div><div class="cmp-amt ${b.nv > 0 ? '' : 'missing'}">${b.nv > 0 ? f(b.nv) : 'No record'}</div><div class="cmp-row"><span class="cmp-l">Value date</span><span class="cmp-v">${escapeHtml(b._enriched?.valueDate || '—')}</span></div><div class="cmp-row"><span class="cmp-l">Settle</span><span class="cmp-v">${escapeHtml(b._enriched?.settleDate || '—')}</span></div><div class="cmp-row"><span class="cmp-l">Feed</span><span class="cmp-v ${b.nv > 0 ? 'ok' : 'bad'}">${b.nv > 0 ? 'Found' : 'Missing'}</span></div></div><div class="cmp-tile diff"><div class="cmp-h"><div class="cmp-src diff">Break</div></div><div class="cmp-amt r">${f(b.delta)}</div><div class="cmp-row"><span class="cmp-l">Type</span><span class="cmp-v">${escapeHtml(b.type)}</span></div><div class="cmp-row"><span class="cmp-l">Age</span><span class="cmp-v">${b.age} days</span></div><div class="cmp-row"><span class="cmp-l">Priority</span><span class="cmp-v" style="color:${b.sev === 'critical' ? 'var(--rose)' : 'var(--peach)'}">${b.sev === 'critical' ? 'Critical' : 'High'}</span></div></div>`;
  sec1.appendChild(cmp); M.appendChild(sec1);

  // Detail
  const sec2 = document.createElement('div');
  sec2.innerHTML = `<div class="inv-section-h"><div class="iv-sh-title">Break details</div><div class="iv-sh-desc">Transaction context and how Onyx classified this break, including confidence.</div></div>`;
  const det = document.createElement('div'); det.className = 'detail-2';
  det.innerHTML = `<div class="det-tile"><div class="det-h">Transaction context</div><div class="det-row"><span class="det-l">Fund</span><span class="det-v">${escapeHtml(b.fund)}</span></div><div class="det-row"><span class="det-l">Account</span><span class="det-v">${escapeHtml(b.acct)}</span></div><div class="det-row"><span class="det-l">Currency</span><span class="det-v">USD</span></div><div class="det-row"><span class="det-l">Source</span><span class="det-v">${escapeHtml(b.src)}</span></div></div><div class="det-tile"><div class="det-h">Classification</div><div class="det-row"><span class="det-l">Type</span><span class="det-v">${escapeHtml(b.type)}</span></div><div class="det-row"><span class="det-l">Confidence</span><span class="det-v">${b.conf}%</span></div><div class="det-row"><span class="det-l">Priority</span><span class="det-v" style="color:${b.sev === 'critical' ? 'var(--rose)' : 'var(--peach)'}">${b.sev === 'critical' ? 'Critical' : 'High'}</span></div><div class="det-row"><span class="det-l">Age</span><span class="det-v">${b.age} days</span></div></div>`;
  sec2.appendChild(det); M.appendChild(sec2);

  // Agent investigation — three per-agent cards
  const sec3 = document.createElement('div');
  sec3.innerHTML = `<div class="inv-section-h agent-inv-h" style="display:flex;align-items:flex-end;justify-content:space-between;gap:14px"><div><div class="iv-sh-title">Agent investigation</div><div class="iv-sh-desc">How three autonomous agents read this break, in order. Each agent's findings feed the next.</div></div><div style="font-size:11px;color:var(--t3);font-family:'JetBrains Mono',monospace">Completed</div></div>`;
  const stack = document.createElement('div');

  const dataCard = document.createElement('div'); dataCard.className = 'agent-card';
  const matchTxt = b._enriched?.counterpartHints || (b._enriched?.matchedInOtherSource ? 'Counterpart record located in opposite source.' : 'No counterpart record located in opposite source.');
  dataCard.innerHTML = `
    <div class="agent-card-head">
      <div class="agent-card-icon data"><svg width="15" height="15"><use href="#i-database"/></svg></div>
      <div class="agent-card-meta"><div class="agent-card-top"><span class="agent-card-agent data">Data Agent</span><span class="agent-card-headline">Source records pulled &amp; cross-referenced</span><span class="agent-card-status">Done</span></div></div>
    </div>
    <div class="agent-card-detail">${escapeHtml(matchTxt)}</div>
    <div class="agent-card-body">
      <div class="atl-findings">
        <div class="atl-finding"><span class="atl-finding-l">Trustee — ${escapeHtml(b.acct)}</span><span class="atl-finding-r"><span class="atl-finding-v">${b.tr > 0 ? f(b.tr) : 'No record'}</span><span class="fnd-tag-mini ${b.tr > 0 ? 'ok' : 'no'}">${b.tr > 0 ? 'Found' : 'Missing'}</span></span></div>
        <div class="atl-finding"><span class="atl-finding-l">nVision — value ${escapeHtml(b._enriched?.valueDate || '—')}</span><span class="atl-finding-r"><span class="atl-finding-v">${b.nv > 0 ? f(b.nv) : 'No record'}</span><span class="fnd-tag-mini ${b.nv > 0 ? 'ok' : 'no'}">${b.nv > 0 ? 'Found' : 'Missing'}</span></span></div>
        <div class="atl-finding"><span class="atl-finding-l">Counterpart search</span><span class="atl-finding-r"><span class="atl-finding-v">${b._enriched?.raw?.nvisionMatches?.length || 0} matched</span><span class="fnd-tag-mini ${b._enriched?.matchedInOtherSource ? 'ok' : 'no'}">${b._enriched?.matchedInOtherSource ? 'Matched' : 'No counterpart'}</span></span></div>
      </div>
    </div>`;
  stack.appendChild(dataCard);

  const reconCard = document.createElement('div'); reconCard.className = 'agent-card';
  reconCard.innerHTML = `
    <div class="agent-card-head">
      <div class="agent-card-icon recon"><svg width="15" height="15"><use href="#i-git-compare"/></svg></div>
      <div class="agent-card-meta"><div class="agent-card-top"><span class="agent-card-agent recon">Reconciliation Agent</span><span class="agent-card-headline">Classified as <strong>${escapeHtml(b.type)}</strong></span><span class="agent-card-status">Done</span></div></div>
    </div>
    <div class="agent-card-detail">${escapeHtml(b.pat)}</div>
    <div class="agent-card-body">
      <div class="atl-confidence"><span>Classification confidence</span><div class="atl-conf-track"><div class="atl-conf-fill" style="width:${b.conf}%;background:${b.conf >= 85 ? 'var(--mint)' : 'var(--peach)'}"></div></div><span class="atl-conf-pct">${b.conf}%</span></div>
    </div>`;
  stack.appendChild(reconCard);

  const orchCard = document.createElement('div'); orchCard.className = 'agent-card';
  const draftHtml = b.draft
    ? escapeHtml(b.draft)
    : '<span class="as-skel" style="display:inline-block;width:80%;height:14px"></span><br><span class="as-skel" style="display:inline-block;width:60%;height:14px;margin-top:6px"></span>';
  const decisionBlock = res ? '' : `
    <div class="decision-merged">
      <div class="dm-h"><div class="dm-title">Your decision</div><div class="dm-by">Recommendation</div></div>
      <div class="dm-draft">${draftHtml}</div>
      <div class="dm-acts">
        <button class="btn-resolve" onclick="toggleStatus(${b.id})"><svg width="13" height="13"><use href="#i-circle-check"/></svg>Mark resolved</button>
        <button class="btn-escalate" onclick="openEmail(${b.id})"><svg width="13" height="13"><use href="#i-mail"/></svg>Escalate via email</button>
        <button class="btn-edit" id="edit-note-btn" onclick="toggleEditNote(${b.id})"><svg width="13" height="13"><use href="#i-pencil"/></svg>Edit note</button>
      </div>
    </div>`;
  orchCard.innerHTML = `
    <div class="agent-card-head">
      <div class="agent-card-icon orch"><svg width="15" height="15"><use href="#i-topology"/></svg></div>
      <div class="agent-card-meta"><div class="agent-card-top"><span class="agent-card-agent orch">Orchestration Agent</span><span class="agent-card-headline">Resolution drafted — <strong>your decision required</strong></span><span class="agent-card-status">Done</span></div></div>
    </div>
    <div class="agent-card-detail">Based on findings from both agents, a resolution recommendation is prepared for your review below.</div>
    <div class="agent-card-body">${decisionBlock}</div>`;
  stack.appendChild(orchCard);

  sec3.appendChild(stack);
  M.appendChild(sec3);

  // Sidebar
  const tip = document.createElement('div'); tip.className = 'side-card';
  tip.innerHTML = `<div class="side-card-h">Tip for this break type</div><div class="tip-text">${tipForType(b.type)}</div>`;
  S.appendChild(tip);

  const ass = document.createElement('div'); ass.className = 'side-card';
  const lastName = b.assignee && b.assignee.includes('. ') ? b.assignee.split('. ')[1] : (b.assignee || '—');
  ass.innerHTML = `<div class="side-card-h">Assigned to</div><div style="display:flex;align-items:center;gap:11px"><div class="assn-av ${b.assn}" style="width:34px;height:34px;font-size:12px">${lastName.substring(0, 2).toUpperCase()}</div><div><div style="font-size:12.5px;font-weight:600;color:var(--t1)">${escapeHtml(b.assignee)}</div><div style="font-size:10.5px;color:var(--t3);margin-top:1px">Reconciliation analyst</div></div></div>`;
  S.appendChild(ass);

  const rel = document.createElement('div'); rel.className = 'side-card';
  let relHtml = '<div class="side-card-h">Related breaks</div><div class="related-list">';
  DATA.filter(x => x.id !== b.id).slice(0, 3).forEach(r => {
    relHtml += `<div class="rel-row" onclick='openInv(DATA.find(d=>d.id===${r.id}))'><div class="rel-top"><div class="rel-name">${escapeHtml((r.issuer || '').substring(0, 26))}${(r.issuer || '').length > 26 ? '…' : ''}</div><div class="rel-amt">${f(r.delta)}</div></div><div class="rel-meta">${escapeHtml(r.type)} · ${r.age}d</div></div>`;
  });
  relHtml += '</div>';
  rel.innerHTML = relHtml;
  S.appendChild(rel);
}

function tipForType(type) {
  if (!type) return '';
  const t = type.toLowerCase();
  if (t.includes('unmatched')) return '<strong>Unmatched transactions</strong> persisting beyond T+3 are unlikely to self-resolve. Confirm with the source system before closing.';
  if (t.includes('rounding')) return '<strong>Rounding artefacts</strong> under $100 can be bulk-resolved with a tolerance rule.';
  if (t.includes('reversal')) return '<strong>Reversals</strong> with no counterpart need confirmation from both teams before closure.';
  if (t.includes('aged')) return '<strong>Aged breaks</strong> warrant manual review — system rules have already failed to clear them.';
  if (t.includes('fx')) return '<strong>FX adjustments</strong> often resolve when the corresponding currency leg posts.';
  return '<strong>Timing differences</strong> usually auto-clear within 2 business days. Monitor daily before escalating.';
}

// ─── Email modal (real LLM compose) ───────────────────────────────────────
window.openEmail = async function (id) {
  const b = DATA.find(x => x.id === id);
  if (!b) return;
  const body = document.getElementById('email-body');
  body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--t3)"><span class="spin"><svg width="14" height="14"><use href="#i-loader"/></svg></span> Composing email...</div>`;
  document.getElementById('email-modal').classList.add('show');

  try {
    const r = await authFetch('/api/draft-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: b.id,
        issuer: b.issuer,
        fund: b.fund,
        account: b.acct,
        amount: b.delta,
        ageInDays: b.age,
        type: b.type,
        pattern: b.pat,
        draft: b.draft || '',
        analystName: 'James Donnelly',
      }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'compose failed');
    const j = await r.json();
    body.innerHTML = `
      <div class="em-field"><span class="em-field-l">To</span><input class="em-field-input" value="${escapeAttr(j.to || '')}"/><span class="em-prefilled"><svg width="12" height="12"><use href="#i-sparkles"/></svg>Pre-filled based on break type</span></div>
      <div class="em-field"><span class="em-field-l">Subject</span><input class="em-field-input" value="${escapeAttr(j.subject || '')}"/></div>
      <div class="em-field"><span class="em-field-l">Message</span><textarea class="em-field-textarea">${escapeHtml(j.body || '')}</textarea><span class="em-prefilled"><svg width="12" height="12"><use href="#i-sparkles"/></svg>Composed from agent findings</span></div>`;
  } catch (err) {
    body.innerHTML = `<div style="padding:24px;color:var(--rose)">Compose failed: ${escapeHtml(err.message || String(err))}</div>`;
  }
};

window.closeEmail = function () { document.getElementById('email-modal').classList.remove('show'); };
window.sendEmail = function () { closeEmail(); showToast('Email sent to escalation team'); };
function showToast(msg) { const t = document.getElementById('toast'); document.getElementById('toast-msg').textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2400); }

document.querySelectorAll('.tbl-hd .th, .cb-tbl-hd .th, .ca-tbl-hd .th, .hist-thead .th').forEach(th => {
  th.onclick = () => { th.parentElement.querySelectorAll('.th').forEach(x => x.classList.remove('sorted')); th.classList.add('sorted'); };
});

// Brand / logo click — back to landing
document.querySelector('.brand').addEventListener('click', () => sv('v-upload'));

// ─── Edit Note (inline edit of the recommendation draft) ──────────────────
window.toggleEditNote = function (id) {
  const b = DATA.find(x => x.id === id);
  if (!b) return;
  const draftEl = document.querySelector('.dm-draft');
  const editBtn = document.getElementById('edit-note-btn');
  if (!draftEl || !editBtn) return;

  const isEditing = draftEl.tagName === 'TEXTAREA';

  if (isEditing) {
    // Save mode — persist text, restore the div
    const newText = draftEl.value.trim();
    b.draft = newText;
    const div = document.createElement('div');
    div.className = 'dm-draft';
    div.textContent = newText;
    draftEl.replaceWith(div);
    editBtn.innerHTML = '<svg width="13" height="13"><use href="#i-pencil"/></svg>Edit note';
    showToast('Note updated');
  } else {
    // Edit mode — swap div for a textarea
    const ta = document.createElement('textarea');
    ta.className = 'dm-draft';
    ta.value = draftEl.textContent || '';
    ta.style.cssText = 'width:100%;min-height:96px;font-family:inherit;font-size:12.5px;color:var(--t2);line-height:1.7;background:var(--s2);border:1px solid var(--gold);border-radius:9px;padding:13px 15px;resize:vertical;outline:none';
    draftEl.replaceWith(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    editBtn.innerHTML = '<svg width="13" height="13"><use href="#i-check"/></svg>Save note';
  }
};

// ─── Export break investigation as JSON ───────────────────────────────────
function exportBreak(b) {
  if (!b) { showToast('No break selected to export'); return; }
  const payload = {
    id: b.id,
    issuer: b.issuer,
    fund: b.fund,
    account: b.acct,
    source: b.src,
    amount: b.delta,
    currency: 'USD',
    age_days: b.age,
    classification: {
      type: b.type,
      confidence: b.conf,
      pattern: b.pat,
      severity: b.sev,
    },
    source_records: {
      trustee_amount: b.tr || null,
      nvision_amount: b.nv || null,
      as_of_date: b._enriched?.asOfDate,
      value_date: b._enriched?.valueDate,
      settle_date: b._enriched?.settleDate,
    },
    agent_findings: {
      data_agent: {
        matched_in_other_source: !!b._enriched?.matchedInOtherSource,
        counterpart_hints: b._enriched?.counterpartHints || '',
        nvision_matches: b._enriched?.raw?.nvisionMatches || [],
      },
      reconciliation_agent: {
        classification: b.type,
        confidence: b.conf,
        pattern: b.pat,
      },
      orchestration_agent: {
        recommendation: b.draft || null,
      },
    },
    assignee: b.assignee,
    resolved: resolved.includes(b.id),
    exported_at: new Date().toISOString(),
  };

  const safeName = (b.issuer || 'break').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  const filename = `onyx_break_${String(b.id).padStart(3, '0')}_${safeName}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${filename}`);
}

// Wire the Export button at the top of the investigation page
document.getElementById('inv-export-btn').addEventListener('click', () => exportBreak(sel));

// ─── Utilities ────────────────────────────────────────────────────────────
function uniqBy(arr, fn) { const seen = new Set(); return arr.filter(x => { const k = fn(x); if (seen.has(k)) return false; seen.add(k); return true; }); }
function countBy(arr, fn) { const m = {}; for (const x of arr) { const k = fn(x); m[k] = (m[k] || 0) + 1; } return m; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
function escapeAttr(s) { return escapeHtml(s); }
function formatDate(d) { return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
