// Шлёт напоминания о делах и утреннюю сводку. Ничего из данных не печатает в лог — репозиторий открытый.
import webpush from 'web-push';

const OWNER = 'sarkoruslan-ctrl', REPO = 'planer-data';
const VAPID_PUBLIC = 'BK29stD1eZozutj80QHTr7fF3x9UHqwB6MZ9Ha1bSvziMAP6YO3CFjvdPwuNVcuczRGNOGE5-vBa0b6kOH379zM';
const { DATA_TOKEN, VAPID_PRIVATE } = process.env;
if (!DATA_TOKEN || !VAPID_PRIVATE) { console.log('нет ключей — пропуск'); process.exit(0); }
webpush.setVapidDetails('https://sarkoruslan-ctrl.github.io/planer/', VAPID_PUBLIC, VAPID_PRIVATE);

const api = (path, opt = {}) => fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
  ...opt, headers: { Authorization: `Bearer ${DATA_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } });
async function getJson(path) {
  const r = await api(path); if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error('read ' + r.status);
  const j = await r.json(); return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function putJson(path, data, sha) {
  const body = { message: 'notify', content: Buffer.from(JSON.stringify(data)).toString('base64') }; if (sha) body.sha = sha;
  await api(path, { method: 'PUT', body: JSON.stringify(body) });
}

const TEST = process.env.TEST === 'true';
const { data: S0 } = await getJson('data.json');
if (!S0 && !TEST) { console.log('нет данных'); process.exit(0); }
const S = S0 || {};
const N = { lead: 15, morning: true, mtime: '09:00', tz: 'Europe/Moscow', ...(S.notify || {}) };

// «сейчас» в часовом поясе телефона
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: N.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date()).map(p => [p.type, p.value]));
const today = `${parts.year}-${parts.month}-${parts.day}`, nowMin = +parts.hour * 60 + +parts.minute;
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// дела на сегодня, включая повторы (та же логика, что в приложении)
const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
function occurs(t, k) {
  if (k < t.date || (t.rep.until && k > t.rep.until)) return false;
  const d = fromIso(k), b = fromIso(t.date), w = d.getUTCDay();
  switch (t.rep.k) {
    case 'day': return true; case 'wd': return w > 0 && w < 6; case 'week': return w === b.getUTCDay();
    case '2week': return w === b.getUTCDay() && Math.round((d - b) / 864e5 / 7) % 2 === 0;
    case 'month': return d.getUTCDate() === b.getUTCDate();
  } return false;
}
const items = [];
for (const t of S.tasks || []) {
  if (!t.rep) { if (t.date === today && !t.done) items.push({ ...t, key: t.id }); continue; }
  if (!occurs(t, today)) continue;
  const vid = t.id + '@' + today, st = ((S.rdone || {})[t.cal] || {})[vid];
  if (st !== true && st !== 'skip') items.push({ ...t, key: vid });
}
const CAL = { w: 'Работа', s: 'Учёба', p: 'Личное' };

const { data: sentRaw, sha: sentSha } = await getJson('sent.json');
const sent = sentRaw || {}; let changed = false;
const out = [];
for (const t of items) {
  if (!t.time) continue;
  const at = toMin(t.time) - N.lead, k = `t:${today}:${t.key}`;
  if (nowMin >= at && nowMin - at < 45 && nowMin <= toMin(t.time) + 5 && !sent[k]) {
    out.push({ title: N.lead ? `⏰ Через ${N.lead} мин` : '⏰ Пора', body: `${t.emoji ? t.emoji + ' ' : ''}${t.title} · ${t.time} · ${CAL[t.cal]}`, tag: k });
    sent[k] = Date.now(); changed = true;
  }
}
const mk = `m:${today}`;
if (N.morning && nowMin >= toMin(N.mtime) && nowMin - toMin(N.mtime) < 180 && !sent[mk]) {
  const list = items.slice().sort((a, b) => (a.time || '99') < (b.time || '99') ? -1 : 1);
  const bd = (S.bdays || []).filter(b => b.md === today.slice(5)).map(b => b.n);
  const plural = (n, f) => f[(n % 10 === 1 && n % 100 !== 11) ? 0 : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? 1 : 2];
  let body = list.length ? `Сегодня ${list.length} ${plural(list.length, ['дело', 'дела', 'дел'])}: ${list.slice(0, 3).map(t => (t.time ? t.time + ' ' : '') + t.title).join(', ')}${list.length > 3 ? ` и ещё ${list.length - 3}` : ''}` : 'Сегодня свободный день ✨';
  if (bd.length) body += ` · 🎂 ${bd.join(', ')}`;
  out.push({ title: `☀️ Доброе утро, ${S.name || 'Руслан'}!`, body, tag: mk });
  sent[mk] = Date.now(); changed = true;
}
for (const k of Object.keys(sent)) if (Date.now() - sent[k] > 3 * 864e5) { delete sent[k]; changed = true; }

if (TEST) { out.length = 0; out.push({ title: '✦ Проверка связи', body: 'Уведомления работают! Так будут выглядеть напоминания о делах.', tag: 'test-' + Date.now() }); }
let devices = 0, okN = 0, errs = [];
if (out.length) {
  const r = await api('subs'); const files = r.ok ? await r.json() : [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f.name.endsWith('.json')) continue;
    const { data: sub, sha } = await getJson('subs/' + f.name); devices++;
    for (const n of out) {
      try { await webpush.sendNotification(sub, JSON.stringify({ ...n, url: './' }), { TTL: 3600 }); okN++; }
      catch (e) { errs.push(e.statusCode || 'ошибка'); if (e.statusCode === 404 || e.statusCode === 410) { await api('subs/' + f.name, { method: 'DELETE', body: JSON.stringify({ message: 'notify: old device', sha }) }); break; } }
    }
  }
}
if (changed && !TEST) await putJson('sent.json', sent, sentSha);
console.log(`готово: сообщений ${out.length}, устройств ${devices}, доставлено ${okN}, ошибки: ${errs.join(',') || 'нет'}`);
