/**
 * BillBell — bill text parser (pure JavaScript, no Google services).
 * Reads the text of an email or PDF and pulls out the bill details.
 */

var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
var AMT = '\\$?\\s*((?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2})';
var DATE = '(\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?[\\s\\-]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?[\\s,\\-]+\\d{2,4})';

/** Default providers. Order matters: more specific patterns first. */
var DEFAULT_PROVIDERS = [
  // id, name, category, match (regex), colour, cycle days (0 = irregular), pay URL, short, website (for the logo)
  ['agl-telco', 'AGL Telco', 'Telecommunications', 'energy telco|agl telecommunications|agltelco|aussie broadband telco|agl internet|agl nbn', '#3949AB', 30, 'https://agl.com.au/telcopayment', 'AT', 'agl.com.au'],
  ['agl-energy', 'AGL Electricity', 'Electricity', 'energy\\.agl\\.com\\.au|agl electricity|agl energy|\\bagl\\b', '#1E88E5', 30, 'https://myaccount.agl.com.au', 'AE', 'agl.com.au'],
  ['optus', 'Optus', 'Internet', 'optus', '#139C9F', 30, 'https://www.optus.com.au/paymybill', 'O', 'optus.com.au'],
  ['penrith-council', 'Penrith City Council', 'Council Rates', 'penrith city council|penrithcity\\.nsw|penrith\\.city', '#C0563A', 91, 'https://www.penrithcity.nsw.gov.au', 'PC', 'penrithcity.nsw.gov.au'],
  ['supagas', 'Supagas', 'Gas', 'supagas', '#2E7D32', 0, 'https://www.supagas.com.au/login', 'SG', 'supagas.com.au'],
  ['amaysim', 'Amaysim', 'Telecommunications', 'amaysim', '#F26A21', 28, 'https://www.amaysim.com.au/my-account', 'AM', 'amaysim.com.au'],
  ['sydney-water', 'Sydney Water', 'Water', 'sydney ?water', '#0077C8', 91, 'https://www.sydneywater.com.au', 'SW', 'sydneywater.com.au']
];

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** "26 Oct 2026", "30/11/2026", "06-OCT-26" → "2026-10-26" (Australian day-first). */
function parseDateStr(s) {
  if (!s) return '';
  s = String(s).trim().toLowerCase();
  var m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  var d, mo, y;
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else {
    m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([a-z]{3})[a-z]*\.?[\s,\-]+(\d{2,4})$/);
    if (!m) return '';
    d = +m[1]; mo = MONTHS[m[2]]; y = +m[3];
  }
  if (y < 100) y += 2000;
  if (!mo || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return '';
  return y + '-' + pad2_(mo) + '-' + pad2_(d);
}

function firstMatch_(text, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[1]) return m[1];
  }
  return '';
}

function toNum_(s) { return s ? parseFloat(String(s).replace(/,/g, '')) : 0; }

/** Finds the provider whose pattern matches the text. providers: array of {id, match,...}. */
function matchProvider(text, providers) {
  var t = String(text || '');
  for (var i = 0; i < providers.length; i++) {
    var p = providers[i];
    if (!p.match) continue;
    try { if (new RegExp(p.match, 'i').test(t)) return p; } catch (e) {}
  }
  return null;
}

/* ---------- New providers ---------- */

var PERSONAL_DOMAINS = /(^|\.)(gmail|googlemail|icloud|me|mac|outlook|hotmail|live|yahoo|bigpond)\.(com|com\.au|net|net\.au)$/i;
var CATEGORY_WORDS = [
  ['Electricity', /electricity|kwh|energy usage|power bill|solar feed/i],
  ['Gas', /\bgas\b|\blpg\b|cylinder|megajoules|\bmj\b/i],
  ['Water', /\bwater\b|sewerage|wastewater/i],
  ['Internet', /\bnbn\b|internet|broadband|wi-?fi|fibre/i],
  ['Telecommunications', /mobile|\bsim\b|prepaid|postpaid|phone plan|data plan/i],
  ['Council Rates', /council|\brates\b|instalment notice/i],
  ['Insurance', /insurance|policy|premium|insurer/i],
  ['Rego', /registration|\brego\b|\bctp\b|transport for nsw|service nsw|e-?toll|linkt/i],
  ['Strata', /strata|levy|owners corporation|body corporate/i],
  ['Subscriptions', /subscription|membership|renewal/i]
];
var NEW_COLOURS = ['#5B6BD6', '#139C9F', '#C0563A', '#2E7D32', '#8E44AD', '#D9822B', '#0077C8', '#B03A5B', '#3A7D7B', '#6D4C41'];

/** "AGL <hello@mail.agl.com.au>" → { name: 'AGL', email, domain: 'agl.com.au' } */
function senderInfo(from) {
  var s = String(from || '');
  var email = (s.match(/<([^>]+)>/) || s.match(/([^\s<>"]+@[^\s<>"]+)/) || [])[1] || '';
  var name = s.replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  var host = (email.split('@')[1] || '').toLowerCase();
  var parts = host.split('.');
  var keep = /\.(com|net|org|gov|edu|asn|id)\.au$|\.co\.(uk|nz)$/.test(host) ? 3 : 2;
  var domain = parts.slice(-keep).join('.');
  return { name: name, email: email.toLowerCase(), domain: domain };
}

function guessCategory(text) {
  var t = String(text || '').slice(0, 6000);
  for (var i = 0; i < CATEGORY_WORDS.length; i++) if (CATEGORY_WORDS[i][1].test(t)) return CATEGORY_WORDS[i][0];
  return 'Other';
}

/** Builds a provider row for a sender BillBell hasn't seen. Returns null for personal email addresses. */
function makeProvider(from, text) {
  var si = senderInfo(from);
  if (!si.domain || PERSONAL_DOMAINS.test(si.domain)) return null;
  var brand = si.domain.split('.')[0];
  var name = si.name && !/@|no.?reply|do.?not.?reply|notifications?|billing|accounts?$/i.test(si.name)
    ? si.name.replace(/\s+(billing|accounts|notifications?|team|customer service)$/i, '')
    : brand.charAt(0).toUpperCase() + brand.slice(1);
  var id = brand.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  var hash = 0; for (var i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  var words = name.split(/\s+/).filter(Boolean);
  return {
    id: id, name: name, category: guessCategory(name + ' ' + si.domain + ' ' + text),
    match: [brand, si.domain.replace(/\./g, '\\.'), name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()].filter(Boolean).join('|'),
    colour: NEW_COLOURS[hash % NEW_COLOURS.length], cycle: 30,
    payUrl: 'https://www.' + si.domain, short: (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase(),
    domain: si.domain, active: 'true'
  };
}

/** Pulls the original sender/subject/date out of a forwarded email body. */
function parseForwarded(body) {
  var out = { from: '', subject: '', date: '' };
  var t = String(body || '');
  var block = t.match(/(?:forwarded message|begin forwarded message|original message)[\s\S]{0,800}/i);
  var src = block ? block[0] : t.slice(0, 1500);
  var f = src.match(/^\s*from:\s*(.+)$/im); if (f) out.from = f[1].trim();
  var s = src.match(/^\s*subject:\s*(.+)$/im); if (s) out.subject = s[1].trim();
  var d = src.match(/^\s*date:\s*(.+)$/im); if (d) out.date = d[1].trim();
  return out;
}

/**
 * Reads one document (email body or PDF text).
 * Returns { kind: 'bill' | 'paid-bill' | 'receipt' | 'unknown', ...fields }
 */
function parseBillText(text, emailDateIso) {
  var t = String(text || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  var r = {
    kind: 'unknown', amount: 0, dueDate: '', issueDate: '', period: '', invoiceNo: '',
    accountNo: '', billerCode: '', bpayRef: '', autopay: false, dueNow: false,
    credits: [], receiptInvoices: [], paidDate: '', reasons: []
  };

  // ---- Payment receipt (e.g. AGL "PAYMENT RECEIPT") ----
  if (/payment receipt|receipt for your payment|payment confirmation/i.test(t) &&
      !/(?:total )?amount due[^0-9$]{0,40}\$?\s*[1-9]/i.test(t)) {
    r.kind = 'receipt';
    r.amount = toNum_(firstMatch_(t, [
      new RegExp('payment total[^0-9$]{0,30}' + AMT, 'i'),
      new RegExp('amount paid[^0-9$]{0,30}' + AMT, 'i'),
      new RegExp('payment of[^0-9$]{0,10}' + AMT, 'i'),
      new RegExp('\\btotal\\b[^0-9$]{0,20}' + AMT, 'i')
    ]));
    r.paidDate = parseDateStr(firstMatch_(t, [
      new RegExp('(?:payment receipt|payment date|date paid|received on)[^0-9a-z]{0,30}' + DATE, 'i'),
      new RegExp(DATE, 'i')
    ])) || emailDateIso || '';
    var re = /invoice\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{5,})/gi, mm;
    while ((mm = re.exec(t))) r.receiptInvoices.push(mm[1]);
    return r;
  }

  // ---- Amount ----
  var owing = toNum_(firstMatch_(t, [new RegExp('total owing[^0-9$]{0,20}' + AMT, 'i')]));
  var amt = firstMatch_(t, [
    new RegExp('total amount due[^0-9$]{0,40}' + AMT, 'i'),
    new RegExp('amount due[^0-9$]{0,40}' + AMT, 'i'),
    new RegExp('total due[^0-9$]{0,40}' + AMT, 'i'),
    new RegExp('(?:amount payable|balance due|amount to pay|please pay)[^0-9$]{0,40}' + AMT, 'i'),
    new RegExp('total (?:incl(?:\\.|uding)?|inc\\.?)\\s*gst[^0-9$]{0,20}' + AMT, 'i'),
    new RegExp('\\btotal\\b(?!\\s*(?:owing|excl|ex\\b|payments|for this|gst))[^0-9$]{0,20}' + AMT, 'i')
  ]);
  r.amount = toNum_(amt) || owing;

  // ---- Dates ----
  r.dueDate = parseDateStr(firstMatch_(t, [
    new RegExp('(?:this bill due date|due date|payment due|instalment due|due by|due on|pay by|please pay by)[^0-9a-z]{0,30}' + DATE, 'i'),
    new RegExp('(?:debit date|will be debited on)[^0-9a-z]{0,30}' + DATE, 'i'),
    new RegExp('\\bdue\\b[^0-9a-z]{0,15}' + DATE, 'i')
  ]));
  r.issueDate = parseDateStr(firstMatch_(t, [
    new RegExp('(?:issue date|invoice date|date of issue|date issued|issued)[^0-9a-z]{0,30}' + DATE, 'i'),
    new RegExp('(?:tax invoice|customer copy)[^0-9]{0,60}' + DATE, 'i')
  ]));
  if (!r.dueDate && /due now|c\.?o\.?d\.?\b|payable immediately|due immediately/i.test(t)) {
    r.dueNow = true;
    r.dueDate = r.issueDate || emailDateIso || '';
  }

  // ---- Reference numbers ----
  r.invoiceNo = firstMatch_(t, [
    /invoice\s*(?:no\.?|number|#)\s*[:#]?\s*((?=[A-Z0-9\-]*\d)[A-Z0-9\-]{5,})/i,
    /notice\s*(?:no\.?|number)\s*:?\s*(\d{5,})/i,
    /tax invoice\s+((?=[A-Z0-9]*\d)[A-Z0-9]{5,})/i
  ]);
  r.accountNo = firstMatch_(t, [
    /(?:account\s*(?:number|no\.?|code)|customer\s*(?:number|no\.?)|amaysim no\.?)\s*[:.]?\s*([A-Z]?\d[\d ]{2,18}\d)/i
  ]).replace(/\s+/g, ' ').trim();
  r.billerCode = firstMatch_(t, [/biller\s*code\s*:?\s*(\d{3,7})/i]);
  if (r.billerCode) {
    var idx = t.search(/biller\s*code/i);
    var after = t.slice(idx, idx + 220);
    r.bpayRef = firstMatch_(after, [
      /(?:ref(?:erence)?\s*(?:number|no\.?)?|cust(?:omer)?\s*ref(?:erence)?|crn)\s*:?\s*(\d[\d ]{3,24}\d)/i
    ]).replace(/\s+/g, '');
  }
  if (r.billerCode && !r.bpayRef) {
    r.bpayRef = firstMatch_(t, [
      /(?:bpay\s*)?(?:ref(?:erence)?\s*(?:number|no\.?)|customer\s*ref(?:erence)?|crn)\s*:?\s*(\d[\d ]{4,24}\d)/i
    ]).replace(/\s+/g, '');
  }
  r.period = firstMatch_(t, [
    /(?:bill(?:ing)? period|invoice period|supply period|period)\s*:?\s*(\d{1,2}\s*[a-z]{3}[a-z]*\s*\d{0,4}\s*(?:to|\-|–)\s*\d{1,2}\s*[a-z]{3}[a-z]*\s*\d{2,4})/i
  ]);

  r.autopay = /(?:will be|is) (?:automatically )?(?:debited|deducted)|automatically debited|direct debit date|payment method\s*:?\s*(?:automatic|direct debit)/i.test(t);

  // Credits on this bill = payments for earlier bills (e.g. "$84.29 CR")
  var cre = /\$?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*cr\b/gi, cm;
  while ((cm = cre.exec(t))) r.credits.push(toNum_(cm[1]));

  // ---- Classify ----
  var paidInvoice = /no further action required|thanks? (?:you )?for your payment|total owing\s*\$?\s*0\.00|paid in full/i.test(t);
  if (r.amount > 0) {
    r.kind = paidInvoice ? 'paid-bill' : 'bill';
    if (paidInvoice) {
      r.paidDate = parseDateStr(firstMatch_(t, [new RegExp('(?:payment received on|paid on)[^0-9a-z]{0,20}' + DATE, 'i')])) || r.issueDate || emailDateIso || '';
    }
  }
  if (!r.amount) r.reasons.push('No amount found');
  if (r.kind === 'bill' && !r.dueDate) r.reasons.push('No due date found');
  if (r.dueNow) r.reasons.push('Bill says "Due now" — due date set to the invoice date');
  return r;
}

/** Bills that look like the same bill (same provider + invoice, or same amount + due date). */
function isDuplicateBill(newBill, bills) {
  for (var i = 0; i < bills.length; i++) {
    var b = bills[i];
    if (b.provider !== newBill.provider || b.status === 'ignored') continue;
    if (newBill.invoiceNo && b.invoiceNo && String(b.invoiceNo) === String(newBill.invoiceNo)) return b;
    if (Math.abs(Number(b.amount) - Number(newBill.amount)) < 0.005 && b.dueDate && b.dueDate === newBill.dueDate) return b;
  }
  return null;
}

/** % rise against the average of the last 3 bills for the provider, or 0. */
function priceRise(newBill, bills, threshold) {
  var prev = bills.filter(function (b) {
    return b.provider === newBill.provider && b.status !== 'ignored' && b.id !== newBill.id &&
      Number(b.amount) > 0 && (b.dueDate || '') < (newBill.dueDate || '9999');
  }).sort(function (a, b) { return a.dueDate < b.dueDate ? 1 : -1; }).slice(0, 3);
  if (prev.length < 2) return 0;
  var avg = prev.reduce(function (s, b) { return s + Number(b.amount); }, 0) / prev.length;
  var rise = (Number(newBill.amount) - avg) / avg;
  return rise >= (threshold || 0.2) ? Math.round(rise * 100) : 0;
}

/** Providers whose regular bill is late. Returns [{provider, daysLate, last, every}]. */
function missingBills(bills, providers, todayIso) {
  var out = [];
  var today = new Date(todayIso + 'T00:00:00');
  providers.forEach(function (p) {
    if (String(p.active) === 'false' || !(Number(p.cycle) > 0)) return;
    var dates = bills.filter(function (b) { return b.provider === p.id && b.status !== 'ignored'; })
      .map(function (b) { return b.issueDate || b.dueDate; }).filter(Boolean).sort();
    if (!dates.length) return;
    var gaps = [];
    for (var i = 1; i < dates.length; i++) {
      var g = (new Date(dates[i]) - new Date(dates[i - 1])) / 864e5;
      if (g > 5) gaps.push(g);
    }
    var every = Number(p.cycle);
    if (gaps.length >= 2) { gaps.sort(function (a, b) { return a - b; }); every = Math.round(gaps[Math.floor(gaps.length / 2)]); }
    var last = new Date(dates[dates.length - 1] + 'T00:00:00');
    var late = Math.floor((today - last) / 864e5) - every;
    if (late > 5) out.push({ provider: p.id, daysLate: late, last: dates[dates.length - 1], every: every });
  });
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { parseBillText: parseBillText, parseDateStr: parseDateStr, matchProvider: matchProvider,
    parseForwarded: parseForwarded, isDuplicateBill: isDuplicateBill, priceRise: priceRise,
    missingBills: missingBills, DEFAULT_PROVIDERS: DEFAULT_PROVIDERS,
    senderInfo: senderInfo, guessCategory: guessCategory, makeProvider: makeProvider };
}
