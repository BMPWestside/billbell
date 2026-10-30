/**
 * BillBell — Gmail scanner + app API.
 * Runs inside the Google account sm466991234@gmail.com.
 *
 *  - Every 15 minutes: reads new emails under the "Billbell" Gmail label,
 *    reads the email text and any PDF/photo attachments, and saves each bill
 *    to the "BillBell Data" Google Sheet.
 *  - Every morning at 8am: phone reminders (ntfy) for bills due in 2 days,
 *    due today, overdue, and regular bills that haven't arrived.
 *  - Serves the bill data to the BillBell web app (protected by an API key).
 *
 * Needs: Services → Drive API (v3) turned on. Parser.gs in the same project.
 */

var CONFIG = {
  LABEL: 'Billbell',
  FORWARD_TO: 'sm466991234+billbell@gmail.com',   // the address iCloud forwards bills to
  SHEET_NAME: 'BillBell Data',
  FOLDER_NAME: 'BillBell Bills',
  APP_URL: 'https://bmpwestside.github.io/billbell/',
  REMIND_DAYS: 2,          // reminder this many days before the due date
  PRICE_RISE: 0.20,        // flag bills 20% above the provider's recent average
  SCAN_DAYS: 30,           // normal scans look back this far
  BACKFILL_DAYS: 400,      // first scan looks back this far (for charts history)
  TZ: 'Australia/Sydney'
};

var BILL_COLS = ['id', 'provider', 'category', 'amount', 'dueDate', 'issueDate', 'period', 'invoiceNo',
  'accountNo', 'billerCode', 'bpayRef', 'status', 'paidDate', 'autopay', 'flags', 'reason',
  'fileUrl', 'emailUrl', 'messageId', 'source', 'notes', 'createdAt'];
var PROVIDER_COLS = ['id', 'name', 'category', 'match', 'colour', 'cycle', 'payUrl', 'short', 'domain', 'active', 'logo'];
var PAYMENT_COLS = ['date', 'provider', 'amount', 'invoiceNo', 'billId', 'messageId'];
var LOG_COLS = ['messageId', 'date', 'subject', 'result'];

/* ======================= SETUP ======================= */

/**
 * Run once. Creates the sheet, folder, keys and timers. Finishes in under a minute:
 * past bills and logos are then read in the background every 15 minutes.
 */
function setup() {
  if (typeof DEFAULT_PROVIDERS === 'undefined') throw new Error('Parser.gs is missing. Add a script file named Parser and paste Parser.gs into it.');
  if (typeof Drive === 'undefined') throw new Error('Drive API is not turned on. Click Services + on the left, choose Drive API, click Add, then run setup again.');
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_KEY')) props.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  if (!props.getProperty('NTFY_TOPIC')) props.setProperty('NTFY_TOPIC', 'billbell-' + Utilities.getUuid().slice(0, 12));

  var ss = getSpreadsheet_();
  ensureSheet_(ss, 'Bills', BILL_COLS);
  ensureSheet_(ss, 'Payments', PAYMENT_COLS);
  ensureSheet_(ss, 'Log', LOG_COLS);
  var pSheet = ensureSheet_(ss, 'Providers', PROVIDER_COLS);
  if (pSheet.getLastRow() < 2) {
    var rows = DEFAULT_PROVIDERS.map(function (p) { return p.concat(['true', '']); });
    pSheet.getRange(2, 1, rows.length, PROVIDER_COLS.length).setValues(rows);
  }
  var def = ss.getSheetByName('Sheet1'); if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  getFolder_();

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scanBills').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('dailyReminders').timeBased().atHour(8).nearMinute(0).everyDays(1).inTimezone(CONFIG.TZ).create();

  if (!GmailApp.getUserLabelByName(CONFIG.LABEL)) GmailApp.createLabel(CONFIG.LABEL);

  ScriptApp.newTrigger('refreshLogos').timeBased().after(60 * 1000).create();

  // Past bills are read in the background by the 15-minute timer, a few minutes at a time
  props.setProperty('BACKFILL_LEFT', '1');
  Logger.log('Setup done. Sheet: ' + ss.getUrl());
  Logger.log('Your past bills will be read in the background over the next hour or so. Run checkStatus any time to see progress.');
  Logger.log('Next: Deploy → New deployment → Web app, then run sendSetupLink.');
}

/** Checks the app connection from inside Google and shows the app key. */
function testApp() {
  var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  var out = JSON.parse(doGet({ parameter: { action: 'data', key: key } }).getContent());
  Logger.log('Web app address: ' + String(ScriptApp.getService().getUrl()).replace(/\/dev(\?.*)?$/, '/exec'));
  Logger.log(out.error ? 'Problem: ' + out.error : 'Working. ' + out.bills.length + ' bills, ' + out.providers.length + ' providers.');
  Logger.log('App key: ' + key);
}

/** Shows how far the scanner has got. */
function checkStatus() {
  var props = PropertiesService.getScriptProperties();
  var bills = readTable_('Bills'), log = readTable_('Log');
  var errors = log.filter(function (r) { return /^error/.test(r.result); });
  Logger.log('Emails read: ' + log.length + ' · Bills found: ' + bills.length +
    ' (' + bills.filter(function (b) { return b.status === 'review'; }).length + ' in Review)');
  Logger.log(props.getProperty('BACKFILL_LEFT') ? 'Still reading older bills in the background…' : 'All past bills have been read.');
  Logger.log('Logos saved: ' + readTable_('Providers').filter(function (p) { return p.logo; }).length);
  errors.slice(-5).forEach(function (r) { Logger.log('Problem with "' + r.subject + '": ' + r.result); });
}

/** Run after deploying as a web app. Emails you the one-tap link that connects the app. */
function sendSetupLink() {
  var props = PropertiesService.getScriptProperties();
  var url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('Deploy the script as a Web app first (Deploy → New deployment).');
  // The editor sometimes hands back the private test address (/dev), which phones can't use
  url = url.replace(/\/dev(\?.*)?$/, '/exec');
  var link = CONFIG.APP_URL + '#api=' + encodeURIComponent(url) + '&key=' + props.getProperty('API_KEY');
  var topic = props.getProperty('NTFY_TOPIC');
  var me = Session.getEffectiveUser().getEmail();
  var html = '<div style="font-family:sans-serif;font-size:15px">' +
    '<h2 style="color:#1B2A5E">BillBell is ready</h2>' +
    '<p><b>1.</b> On your iPhone, tap this link to open and connect BillBell:<br>' +
    '<a href="' + link + '">Open BillBell</a></p>' +
    '<p><b>2.</b> In Safari tap Share → <b>Add to Home Screen</b>.</p>' +
    '<p><b>3.</b> Install the free <b>ntfy</b> app, tap +, and subscribe to this topic for reminders:<br>' +
    '<code style="font-size:16px">' + topic + '</code></p>' +
    '<p style="color:#888">Keep this email private — the link contains your app key.</p></div>';
  MailApp.sendEmail({ to: me, subject: 'BillBell setup link', htmlBody: html });
  notify_('BillBell connected', 'Reminders will arrive here.', 'bell');
  Logger.log('Setup link emailed to ' + me + '\n' + link + '\nntfy topic: ' + topic);
}

/* ======================= SCANNING ======================= */

function scanBills() {
  // If the first big read of past bills didn't finish, keep going with it (quietly)
  var backfill = !!PropertiesService.getScriptProperties().getProperty('BACKFILL_LEFT');
  scanBills_(backfill ? CONFIG.BACKFILL_DAYS : CONFIG.SCAN_DAYS, backfill);
}

function scanBills_(days, quiet) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { added: 0 };
  var started = Date.now(), added = [];
  try {
    tidyReview_();
    var done = {};
    readTable_('Log').forEach(function (r) { done[r.messageId] = true; });
    var start = 0, threads;
    do {
      // Forwarded emails keep their original "To", so also look at where Gmail delivered them
      threads = GmailApp.search('(label:' + CONFIG.LABEL + ' OR deliveredto:' + CONFIG.FORWARD_TO + ') newer_than:' + days + 'd', start, 100);
      var lbl = GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
      try { if (threads.length) lbl.addToThreads(threads); } catch (e) {}
      for (var i = 0; i < threads.length; i++) {
        var msgs = threads[i].getMessages();
        for (var j = 0; j < msgs.length; j++) {
          var m = msgs[j];
          if (done[m.getId()]) continue;
          if (Date.now() - started > 240000) {
            if (days >= CONFIG.BACKFILL_DAYS) PropertiesService.getScriptProperties().setProperty('BACKFILL_LEFT', '1');
            Logger.log('Read ' + added.length + ' bills so far. The rest will be read automatically over the next few runs.');
            return { added: added.length, more: true };
          }
          var res;
          try { res = processMessage_(m); } catch (e) { res = { result: 'error: ' + e.message, bills: [] }; }
          appendRow_('Log', { messageId: m.getId(), date: iso_(m.getDate()), subject: m.getSubject(), result: res.result });
          done[m.getId()] = true;
          added = added.concat(res.bills || []);
        }
      }
      start += 100;
    } while (threads.length === 100);
    if (days >= CONFIG.BACKFILL_DAYS) PropertiesService.getScriptProperties().deleteProperty('BACKFILL_LEFT');
  } finally { lock.releaseLock(); }

  if (!quiet) {
    added.forEach(function (b) {
      var p = providerById_(b.provider);
      var name = p ? p.name : 'Unknown provider';
      if (b.status === 'review') notify_('Check a bill: ' + name, money_(b.amount) + ' — ' + (b.reason || 'needs a quick check'), 'mag');
      else if (b.status === 'due') notify_('New bill: ' + name, money_(b.amount) + ' due ' + niceDate_(b.dueDate) + (b.flags ? ' · ' + b.flags : ''), 'receipt');
    });
  }
  return { added: added.length };
}

function processMessage_(msg) {
  var body = msg.getPlainBody() || stripHtml_(msg.getBody());
  var fwd = parseForwarded(body);
  var emailDate = iso_(msg.getDate());
  var fwdDate = parseDateStr((fwd.date.match(/\d{1,2}\s+[a-z]{3}[a-z]*\s+\d{4}/i) || [''])[0]);
  if (fwdDate) emailDate = fwdDate;
  var header = [msg.getFrom(), msg.getSubject(), fwd.from, fwd.subject].join('\n');
  var providers = getProviders_();
  var emailUrl = 'https://mail.google.com/mail/u/0/#all/' + msg.getId();
  var base = { messageId: msg.getId(), emailUrl: emailUrl, source: 'email', sender: fwd.from || msg.getFrom() };

  // 1) Each PDF / photo attachment is read on its own
  var docs = [];
  msg.getAttachments({ includeInlineImages: false }).forEach(function (a) {
    var type = a.getContentType() || '';
    var isPdf = /pdf/i.test(type) || /\.pdf$/i.test(a.getName());
    var isImg = /^image\/(jpe?g|png|heic|heif)/i.test(type) && a.getSize() > 30000;
    if (!isPdf && !isImg) return;
    var file = getFolder_().createFile(a.copyBlob()).setName(emailDate + ' ' + a.getName());
    var text = '';
    try { text = ocrText_(a.copyBlob(), a.getName()); } catch (e) { text = ''; }
    docs.push({ text: text, fileUrl: file.getUrl() });
  });

  var bills = [], results = [];
  docs.forEach(function (d) {
    var r = handleDoc_(header + '\n' + d.text, emailDate, providers, merge_(base, { fileUrl: d.fileUrl }));
    if (r.bill) bills.push(r.bill);
    results.push(r.result);
  });

  // 2) If no attachment held the bill, read the email text itself
  var anyHit = results.some(function (r) { return !/^skip/.test(r); });
  if (!anyHit) {
    var r = handleDoc_(header + '\n' + body, emailDate, providers, merge_(base, { fileUrl: docs[0] ? docs[0].fileUrl : '' }));
    if (r.bill) bills.push(r.bill);
    results.push(r.result);
    // Known provider but nothing readable → send to Review so nothing is missed
    if (/^skip/.test(r.result)) {
      var p = matchProvider(header + '\n' + body, providers);
      if (p && hasBillNear_(p.id, emailDate)) {
        results.push('skip: reminder or copy of a bill already saved');
      } else if (p && /bill|invoice|statement|notice|amount|due/i.test(header + body.slice(0, 2000))) {
        var b = saveBill_(merge_(base, {
          provider: p.id, category: p.category, amount: 0, dueDate: '', status: 'review',
          reason: 'Couldn\'t read the amount — open the email and enter it', fileUrl: docs[0] ? docs[0].fileUrl : ''
        }));
        bills.push(b); results.push('review: unreadable');
      }
    }
  }
  return { result: results.join(' | ') || 'skip: empty', bills: bills };
}

/** Turns one document into a bill, a paid bill or a payment. */
function handleDoc_(text, emailDate, providers, base) {
  var info = parseBillText(text, emailDate);
  var p = matchProvider(text, providers);
  if (info.kind === 'unknown') return { result: 'skip: no amount' };
  var newProvider = false;
  if (!p && info.kind !== 'receipt') {
    p = addNewProvider_(base.sender, text);
    newProvider = !!p;
  }
  base = merge_(base, {}); delete base.sender;

  if (info.kind === 'receipt') {
    var matched = applyPayment_(p ? p.id : '', info.amount, info.receiptInvoices, info.paidDate, base.messageId);
    return { result: 'receipt ' + money_(info.amount) + (matched ? ' → paid ' + matched : ' (no bill yet)') };
  }

  var bill = merge_(base, {
    provider: p ? p.id : 'unknown', category: p ? p.category : 'Other',
    amount: info.amount, dueDate: info.dueDate, issueDate: info.issueDate, period: info.period,
    invoiceNo: info.invoiceNo, accountNo: info.accountNo, billerCode: info.billerCode,
    bpayRef: info.bpayRef, autopay: info.autopay ? 'true' : '', flags: '', reason: ''
  });

  var all = readTable_('Bills');
  var dup = isDuplicateBill(bill, all);
  if (dup) return { result: 'duplicate of ' + dup.id };

  // Status
  var reasons = info.reasons.slice();
  if (!p) reasons.unshift('Unknown provider');
  if (newProvider) reasons.unshift('New provider — check the name and category');
  if (info.kind === 'paid-bill') { bill.status = 'paid'; bill.paidDate = info.paidDate; }
  else if (reasons.length) bill.status = 'review';
  else bill.status = 'due';
  bill.reason = reasons.join('; ');

  // Already paid? (a receipt for this invoice arrived earlier)
  if (bill.status === 'due' && bill.invoiceNo) {
    var pay = readTable_('Payments').filter(function (x) { return String(x.invoiceNo) === String(bill.invoiceNo) && !x.billId; })[0];
    if (pay) { bill.status = 'paid'; bill.paidDate = pay.date; }
  }

  var rise = priceRise(bill, all, CONFIG.PRICE_RISE);
  if (rise) bill.flags = 'Up ' + rise + '% on usual';

  var saved = saveBill_(bill);
  if (saved.status !== 'review') clearUnreadable_(saved.provider, bill.issueDate || bill.dueDate || emailDate);

  // Credits on this bill mean earlier bills were paid
  if (p && info.credits.length) {
    all.filter(function (b) { return b.provider === p.id && (b.status === 'due' || b.status === 'review') && b.id !== saved.id; })
      .forEach(function (b) {
        if (info.credits.some(function (c) { return Math.abs(c - Number(b.amount)) < 0.005; }))
          updateRow_('Bills', b.id, { status: 'paid', paidDate: bill.issueDate || emailDate });
      });
  }
  return { result: saved.status + ' ' + (p ? p.id : 'unknown') + ' ' + money_(bill.amount), bill: saved };
}

/*
 * Providers often send a short "your bill is ready" or reminder email as well as the bill itself.
 * Those have no amount, so they shouldn't sit in Review when the real bill is already saved.
 */
var NEAR_DAYS = 25;
function nearDate_(a, b) { return a && b && Math.abs(daysBetween_(a, b)) <= NEAR_DAYS; }
function isUnreadable_(b) { return b.status === 'review' && !(Number(b.amount) > 0) && /^Couldn't read/.test(b.reason || ''); }
function hasBillNear_(providerId, iso) {
  return readTable_('Bills').some(function (b) {
    return b.provider === providerId && Number(b.amount) > 0 && b.status !== 'ignored' &&
      (nearDate_(b.issueDate, iso) || nearDate_(b.dueDate, iso) || nearDate_(String(b.createdAt || '').slice(0, 10), iso));
  });
}
function clearUnreadable_(providerId, iso) {
  readTable_('Bills').filter(function (b) {
    return b.provider === providerId && isUnreadable_(b) && nearDate_(String(b.createdAt || '').slice(0, 10) || iso, iso);
  }).forEach(function (b) { updateRow_('Bills', b.id, { status: 'ignored', reason: 'Reminder for a bill already saved' }); });
}
/** Removes unreadable Review items whose real bill is already saved (runs before every scan). */
function tidyReview_() {
  var bills = readTable_('Bills');
  bills.filter(isUnreadable_).forEach(function (r) {
    var when = r.messageId ? emailDateOf_(r.messageId) : String(r.createdAt || '').slice(0, 10);
    var real = bills.some(function (b) {
      return b.provider === r.provider && b.id !== r.id && Number(b.amount) > 0 && b.status !== 'ignored' &&
        (nearDate_(b.issueDate, when) || nearDate_(b.dueDate, when) || (b.emailDate && nearDate_(b.emailDate, when)));
    });
    if (real) updateRow_('Bills', r.id, { status: 'ignored', reason: 'Reminder for a bill already saved' });
  });
}
function emailDateOf_(id) {
  try { return iso_(GmailApp.getMessageById(id).getDate()); } catch (e) { return ''; }
}

/** Marks a matching unpaid bill as paid, or stores the payment for later. Returns bill id or ''. */
function applyPayment_(providerId, amount, invoices, date, messageId) {
  var bills = readTable_('Bills').filter(function (b) { return b.status === 'due' || b.status === 'review'; });
  var hit = bills.filter(function (b) { return b.invoiceNo && invoices.indexOf(String(b.invoiceNo)) >= 0; })[0] ||
    bills.filter(function (b) { return b.provider === providerId && Math.abs(Number(b.amount) - amount) < 0.005; })
      .sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : 1; })[0];
  if (hit) updateRow_('Bills', hit.id, { status: 'paid', paidDate: date });
  appendRow_('Payments', { date: date, provider: providerId, amount: amount, invoiceNo: invoices[0] || '', billId: hit ? hit.id : '', messageId: messageId });
  return hit ? hit.id : '';
}

function saveBill_(bill) {
  bill.id = bill.id || ('b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  bill.createdAt = bill.createdAt || new Date().toISOString();
  appendRow_('Bills', bill);
  return bill;
}

/** PDF or photo → text, using Google Drive's converter (OCR). */
function ocrText_(blob, name) {
  var file = Drive.Files.create
    ? Drive.Files.create({ name: 'tmp-' + name, mimeType: 'application/vnd.google-apps.document' }, blob, { ocrLanguage: 'en', fields: 'id' })
    : Drive.Files.insert({ title: 'tmp-' + name, mimeType: blob.getContentType() }, blob, { ocr: true, ocrLanguage: 'en', convert: true });
  try { return DocumentApp.openById(file.id).getBody().getText(); }
  finally { try { DriveApp.getFileById(file.id).setTrashed(true); } catch (e) {} }
}

/** Saves a provider for a sender BillBell hasn't seen before, with its logo. */
function addNewProvider_(sender, text) {
  var np = makeProvider(sender, text);
  if (!np) return null;
  var existing = readTable_('Providers').filter(function (x) { return x.id === np.id || x.domain === np.domain; })[0];
  if (existing) return existing;
  try { np.logo = fetchLogo_(np.domain) || ''; } catch (e) { np.logo = ''; }
  appendRow_('Providers', np);
  delete _cache['Providers'];
  Logger.log('New provider added: ' + np.name + ' (' + np.category + ')');
  return np;
}

/* ======================= LOGOS ======================= */

/**
 * Downloads each provider's logo from its own website and saves it in the
 * Providers tab (logo column), so the app shows real logos instead of initials.
 * Runs during setup; run it again any time you add a provider.
 * To use your own image instead, paste an image link into the logo column.
 */
function refreshLogos() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'refreshLogos') ScriptApp.deleteTrigger(t); });
  delete _cache['Providers'];
  var done = {};
  readTable_('Providers').forEach(function (p) {
    if (!p.domain) return;
    if (p.logo && !/^data:/.test(p.logo)) return;          // keep a logo you set yourself
    var uri = done[p.domain] || fetchLogo_(p.domain);
    if (uri) { done[p.domain] = uri; updateRow_('Providers', p.id, { logo: uri }); }
    Logger.log(p.name + ': ' + (uri ? 'logo saved' : 'no logo found, initials will show'));
  });
}

function fetchLogo_(domain) {
  var hosts = ['https://www.' + domain.replace(/^www\./, ''), 'https://' + domain.replace(/^www\./, '')];
  var cands = [];
  // 1) Icons the website itself declares (largest first)
  for (var h = 0; h < hosts.length && !cands.length; h++) {
    try {
      var res = UrlFetchApp.fetch(hosts[h], { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
      if (res.getResponseCode() >= 400) continue;
      var html = res.getContentText().slice(0, 300000), re = /<link\b[^>]*>/gi, m, found = [];
      while ((m = re.exec(html))) {
        var tag = m[0], rel = (tag.match(/rel=["']?([^"'>]+)/i) || [])[1] || '', href = (tag.match(/href=["']?([^"' >]+)/i) || [])[1];
        if (!href || !/icon/i.test(rel)) continue;
        var size = parseInt((tag.match(/sizes=["']?(\d+)/i) || [])[1] || (/apple-touch/i.test(rel) ? '180' : '32'), 10);
        found.push({ url: absUrl_(href.replace(/&amp;/g, '&'), hosts[h]), size: size });
      }
      found.sort(function (a, b) { return b.size - a.size; });
      cands = found.map(function (f) { return f.url; });
      cands.push(hosts[h] + '/apple-touch-icon.png');
    } catch (e) {}
  }
  // 2) Fallback: Google's icon service
  cands.push('https://www.google.com/s2/favicons?domain=' + domain + '&sz=128');

  for (var i = 0; i < cands.length; i++) {
    try {
      var r = UrlFetchApp.fetch(cands[i], { muteHttpExceptions: true, followRedirects: true });
      if (r.getResponseCode() !== 200) continue;
      var blob = r.getBlob(), type = (blob.getContentType() || '').split(';')[0], bytes = blob.getBytes();
      if (!/^image\//.test(type) && /\.svg(\?|$)/i.test(cands[i])) type = 'image/svg+xml';
      if (!/^image\//.test(type) || bytes.length < 600 || bytes.length > 36000) continue;
      return 'data:' + type + ';base64,' + Utilities.base64Encode(bytes);
    } catch (e) {}
  }
  return '';
}

function absUrl_(href, base) {
  if (/^https?:\/\//i.test(href)) return href;
  if (/^\/\//.test(href)) return 'https:' + href;
  if (/^\//.test(href)) return base.replace(/\/$/, '') + href;
  return base.replace(/\/$/, '') + '/' + href;
}

/* ======================= REMINDERS ======================= */

function dailyReminders() {
  var today = todayIso_();
  var bills = readTable_('Bills');
  var providers = getProviders_();
  var names = {}; providers.forEach(function (p) { names[p.id] = p.name; });

  bills.filter(function (b) { return b.status === 'due' && b.dueDate; }).forEach(function (b) {
    var days = daysBetween_(today, b.dueDate);
    var n = names[b.provider] || 'Bill';
    var auto = String(b.autopay) === 'true';
    if (days === CONFIG.REMIND_DAYS) notify_(n + (auto ? ' auto-debit in ' : ' due in ') + days + ' days', money_(b.amount) + ' on ' + niceDate_(b.dueDate), 'bell');
    else if (days === 0 && !auto) notify_(n + ' is due today', money_(b.amount), 'warning');
    else if (days < 0 && !auto && (-days) % 3 === 1) notify_(n + ' is ' + (-days) + ' days overdue', money_(b.amount) + ' was due ' + niceDate_(b.dueDate), 'rotating_light');
  });

  var props = PropertiesService.getScriptProperties();
  missingBills(bills, providers, today).forEach(function (m) {
    var key = 'MISSING_' + m.provider + '_' + m.last;
    if (props.getProperty(key)) return;
    props.setProperty(key, '1');
    notify_((names[m.provider] || 'A bill') + ' hasn\'t arrived', m.daysLate + ' days later than usual (every ~' + m.every + ' days).', 'hourglass');
  });

  var review = bills.filter(function (b) { return b.status === 'review'; }).length;
  if (review) notify_(review + ' bill' + (review > 1 ? 's' : '') + ' to check', 'Open the Review tab in BillBell.', 'mag');
}

function notify_(title, message, tags) {
  var topic = PropertiesService.getScriptProperties().getProperty('NTFY_TOPIC');
  if (!topic) return;
  try {
    UrlFetchApp.fetch('https://ntfy.sh/' + topic, {
      method: 'post', payload: message, muteHttpExceptions: true,
      headers: { Title: title.replace(/[^\x20-\x7E]/g, ''), Tags: tags || 'bell', Click: CONFIG.APP_URL }
    });
  } catch (e) {}
}

/* ======================= APP API ======================= */

/*
 * The app talks to the scanner with GET requests (?action=…&key=…&payload=…&callback=…).
 * With "callback" the reply is wrapped as JavaScript, which iPhone Safari always accepts.
 * Photo uploads are too large for a link, so they come in by POST.
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (!authOk_(p.key)) out = { error: 'Wrong or missing key' };
    else if (!p.action || p.action === 'data') out = getData_();
    else out = handleAction_(merge_(JSON.parse(p.payload || '{}'), { action: p.action }));
  } catch (err) { out = { error: 'Scanner error: ' + err.message }; }
  return reply_(out, p.callback);
}

function doPost(e) {
  var out;
  try {
    var body = JSON.parse(e.postData.contents);
    out = authOk_(body.key) ? handleAction_(body) : { error: 'Wrong or missing key' };
  } catch (err) { out = { error: 'Scanner error: ' + err.message }; }
  return reply_(out);
}

function reply_(o, callback) {
  if (callback && /^[A-Za-z_$][\w$]{0,40}$/.test(callback))
    return ContentService.createTextOutput(callback + '(' + JSON.stringify(o) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return json_(o);
}

function handleAction_(body) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    switch (body.action) {
      case 'update': {
        var allowed = ['provider', 'category', 'amount', 'dueDate', 'issueDate', 'status', 'paidDate', 'notes', 'invoiceNo', 'autopay', 'reason', 'flags'];
        var patch = {}; allowed.forEach(function (k) { if (k in body.patch) patch[k] = body.patch[k]; });
        if (patch.provider && !patch.category) { var pr = providerById_(patch.provider); if (pr) patch.category = pr.category; }
        updateRow_('Bills', body.id, patch);
        break;
      }
      case 'add': {
        var pv = providerById_(body.bill.provider);
        saveBill_(merge_(body.bill, { category: pv ? pv.category : (body.bill.category || 'Other'), status: body.bill.status || 'due', source: 'manual' }));
        break;
      }
      case 'upload': {
        var blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mime, body.name || 'bill');
        var file = getFolder_().createFile(blob).setName(todayIso_() + ' ' + (body.name || 'upload'));
        var text = ocrText_(blob, body.name || 'upload');
        var info = parseBillText(text, todayIso_());
        var prov = matchProvider(text, getProviders_());
        saveBill_({
          provider: prov ? prov.id : 'unknown', category: prov ? prov.category : 'Other', amount: info.amount,
          dueDate: info.dueDate, issueDate: info.issueDate, period: info.period, invoiceNo: info.invoiceNo,
          accountNo: info.accountNo, billerCode: info.billerCode, bpayRef: info.bpayRef,
          autopay: info.autopay ? 'true' : '', status: 'review', fileUrl: file.getUrl(), source: 'upload',
          reason: 'Added from a photo — check the details' + (info.reasons.length ? ' (' + info.reasons.join('; ') + ')' : '')
        });
        break;
      }
      case 'provider': {
        var row = body.provider;
        if (readTable_('Providers').some(function (x) { return x.id === row.id; })) updateRow_('Providers', row.id, row);
        else appendRow_('Providers', merge_({ active: 'true', cycle: 30 }, row));
        break;
      }
      case 'scan': lock.releaseLock(); scanBills(); break;
      case 'testNotify': notify_('BillBell test', 'Reminders are working.', 'white_check_mark'); break;
      default: return { error: 'Unknown action' };
    }
  } finally { try { lock.releaseLock(); } catch (x) {} }
  return getData_();
}

function getData_() {
  var cutoff = Utilities.formatDate(new Date(Date.now() - 800 * 864e5), CONFIG.TZ, 'yyyy-MM-dd');
  var bills = readTable_('Bills').filter(function (b) {
    return b.status === 'due' || b.status === 'review' || (b.dueDate || b.paidDate || '') >= cutoff;
  });
  return {
    bills: bills, providers: getProviders_(),
    settings: { ntfyTopic: PropertiesService.getScriptProperties().getProperty('NTFY_TOPIC'), remindDays: CONFIG.REMIND_DAYS },
    generated: new Date().toISOString()
  };
}

function authOk_(key) {
  var k = PropertiesService.getScriptProperties().getProperty('API_KEY');
  return !!k && key === k;
}

/* ======================= SHEET HELPERS ======================= */

function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var ss = SpreadsheetApp.create(CONFIG.SHEET_NAME);
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function getFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var f = DriveApp.createFolder(CONFIG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

function ensureSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#1B2A5E').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  // Plain text everywhere, so long reference numbers and leading zeros are kept exactly
  sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
  return sh;
}

function sheet_(name) { return getSpreadsheet_().getSheetByName(name); }

var _cache = {};
function readTable_(name) {
  if (_cache[name]) return _cache[name];
  var sh = sheet_(name);
  if (!sh || sh.getLastRow() < 2) return (_cache[name] = []);
  var v = sh.getDataRange().getValues(), h = v[0];
  _cache[name] = v.slice(1).map(function (row) {
    var o = {};
    h.forEach(function (k, i) {
      var x = row[i];
      o[k] = x instanceof Date ? Utilities.formatDate(x, CONFIG.TZ, 'yyyy-MM-dd') : (x === null || x === undefined ? '' : x);
    });
    return o;
  });
  return _cache[name];
}

function appendRow_(name, obj) {
  var sh = sheet_(name), h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var row = h.map(function (k) { return obj[k] === undefined || obj[k] === null ? '' : obj[k]; });
  // Written as plain text so the sheet never reformats dates or long numbers
  sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row.map(String)]);
  if (_cache[name]) _cache[name].push(obj);
}

function updateRow_(name, id, patch) {
  var sh = sheet_(name), v = sh.getDataRange().getValues(), h = v[0];
  for (var r = 1; r < v.length; r++) {
    if (String(v[r][0]) === String(id)) {
      Object.keys(patch).forEach(function (k) {
        var c = h.indexOf(k);
        if (c >= 0) sh.getRange(r + 1, c + 1).setNumberFormat('@').setValue(patch[k] === null || patch[k] === undefined ? '' : String(patch[k]));
      });
      break;
    }
  }
  delete _cache[name];
}

function getProviders_() {
  return readTable_('Providers').filter(function (p) { return String(p.active) !== 'false'; });
}
function providerById_(id) { return getProviders_().filter(function (p) { return p.id === id; })[0]; }

/* ======================= SMALL HELPERS ======================= */

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function merge_(a, b) { var o = {}; [a, b].forEach(function (x) { for (var k in x) o[k] = x[k]; }); return o; }
function iso_(d) { return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd'); }
function todayIso_() { return iso_(new Date()); }
function daysBetween_(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5); }
function money_(n) { return '$' + Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function niceDate_(s) { return s ? Utilities.formatDate(new Date(s + 'T00:00:00'), CONFIG.TZ, 'EEE d MMM') : '—'; }
function stripHtml_(h) { return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$'); }
