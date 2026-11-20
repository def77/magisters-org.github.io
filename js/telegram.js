// Telegram alerts for new arbs and value bets. The browser talks to the Bot API directly,
// so alerts go out while the scanner page is open (real-time mode on a PC, for example).

const LS = 'duelpoly.alerted.v1';
const API = 'https://api.telegram.org/bot';

export function loadAlerted() { try { return new Map(Object.entries(JSON.parse(localStorage.getItem(LS) || '{}'))); } catch { return new Map(); } }
export function saveAlerted(map, now = Date.now()) {
  for (const [k, v] of map) if (now - v.at > 2 * 86400e3) map.delete(k);
  try { localStorage.setItem(LS, JSON.stringify(Object.fromEntries(map))); } catch {}
}

/**
 * Should this arb / value bet be sent? New ones yes; the same one again only when it improved by
 * `stepPct` points or was last sent more than `repeatMin` minutes ago.
 */
export function shouldAlert(map, id, pct, now = Date.now(), { stepPct = 1, repeatMin = 60 } = {}) {
  const prev = map.get(id);
  if (!prev) return true;
  if (pct >= prev.pct + stepPct) return true;
  return now - prev.at > repeatMin * 60e3;
}
export function markAlerted(map, id, pct, now = Date.now()) { map.set(id, { pct, at: now }); }

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const usd = x => '$' + (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));
const when = d => new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function arbMessage(r, { bankroll, sportLabel = '' } = {}) {
  const lines = [
    `${r.suspicious ? '⚠️' : '🟢'} <b>Вилка +${r.profitPct.toFixed(2)}%</b>${r.suspicious ? ' — проверьте руками' : ''}`,
    `${esc(sportLabel)}${sportLabel ? ' · ' : ''}<b>${esc(r.poly.title)}</b> · ${when(r.poly.start)}`,
    `${esc(r.label)}`,
    '',
    `🔵 Polymarket: <b>${esc(r.pSide)}</b> — купить ${r.polyShares.toFixed(1)} акций по ${r.polyLeg.price.toFixed(3)} (≈${usd(r.polyUsd)})`,
    `🟠 Duel: <b>${esc(r.duelLeg.label)}</b> @${r.duelLeg.price} — ставка ${usd(r.duelStake)}`,
    '',
    `Банк ${usd(bankroll)} → +${usd(r.profitUsd)}${r.maxBank != null ? ` · стакан до ${usd(r.maxBank)}` : ''}`,
  ];
  if (r.move?.lags) lines.push('⏱ Duel отстаёт от Polymarket');
  if (r.risk) lines.push(`⚠️ ${esc(r.risk)}`);
  return lines.join('\n');
}

export function valueMessage(v, { valueBank, kellyFraction, sportLabel = '' } = {}) {
  const lines = [
    `🔷 <b>Валуйка +${v.evPct.toFixed(1)}% EV</b>`,
    `${esc(sportLabel)}${sportLabel ? ' · ' : ''}<b>${esc(v.poly.title)}</b> · ${when(v.poly.start)}`,
    `${esc(v.label)}`,
    '',
    `🟠 Duel: <b>${esc(v.duelLeg.label)}</b> @${v.duelLeg.price} — ставка ${usd(v.stake)} (${Math.round(kellyFraction * 100)}% Келли от ${usd(valueBank)})`,
    `Справедливо по Polymarket: ${(v.p * 100).toFixed(1)}% → кэф ${v.fairOdds.toFixed(2)}`,
    'Это не вилка: плюс — на дистанции.',
  ];
  if (v.risk) lines.push(`⚠️ ${esc(v.risk)}`);
  return lines.join('\n');
}

export const linkButtons = (polyUrl, duelUrl) => ({ inline_keyboard: [[{ text: 'Polymarket ↗', url: polyUrl }, { text: 'Duel ↗', url: duelUrl }]] });

/**
 * Send a message. Tries a normal request (Telegram answers with CORS headers, so errors are visible);
 * if the browser blocks it, falls back to a form post the browser always allows (no answer to read).
 */
export async function sendTelegram(token, chatId, text, replyMarkup, fetchImpl = fetch) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) };
  try {
    const res = await fetchImpl(`${API}${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw Object.assign(new Error(`Telegram: ${j.description || res.status}`), { fromApi: true });
    return true;
  } catch (e) {
    if (e.fromApi) throw e;
    const form = new URLSearchParams({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: 'true' });
    if (replyMarkup) form.set('reply_markup', JSON.stringify(replyMarkup));
    await fetchImpl(`${API}${token}/sendMessage`, { method: 'POST', mode: 'no-cors', body: form });
    return null; // sent, but the answer cannot be read
  }
}

/** Chat id of the last person who wrote to the bot (to fill the setting in one click). */
export async function findChatId(token, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}${token}/getUpdates`);
  const j = await res.json();
  if (!j.ok) throw new Error(`Telegram: ${j.description || res.status}`);
  const msg = [...(j.result || [])].reverse().map(u => u.message || u.channel_post || u.my_chat_member).find(Boolean);
  return msg?.chat?.id ?? null;
}
