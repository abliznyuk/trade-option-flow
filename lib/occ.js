// OCC (Options Clearing Corp) symbol parser.
//
// Canonical OCC format is a 21-char string:
//   ROOT(6) + YYMMDD(6) + C/P(1) + STRIKE*1000(8)
// e.g. "SPY   260520C00734000" -> root=SPY, expiry=2026-05-20, type=C, strike=734.000
//
// In practice MT5 brokers can deviate slightly:
//   - root may be 1..6 chars, padded with spaces ("SPY   ")  or unpadded ("SPY")
//   - separator between root and date may be space(s), dot, or nothing
//   - strike may be 7 or 8 digits, sometimes with decimal point
//
// We accept anything that resembles the structure. If parsing fails we return null.

'use strict';

const OCC_RX = /^(?<root>[A-Z0-9.\-_]{1,6})\s*(?<yy>\d{2})(?<mm>\d{2})(?<dd>\d{2})(?<type>[CP])(?<strike>\d{6,8})$/;

/** Parse one OCC-style option symbol. Returns null if it doesn't look like an option. */
function parseOCC(symbol) {
  if (typeof symbol !== 'string') return null;
  const compact = symbol.replace(/\s+/g, '');
  const m = compact.match(OCC_RX);
  if (!m) return null;
  const g = m.groups;
  const year = 2000 + parseInt(g.yy, 10);
  const month = parseInt(g.mm, 10);
  const day = parseInt(g.dd, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const strikeRaw = parseInt(g.strike, 10);
  // strike is in millidollars in canonical OCC (8 digits = strike*1000). For 7-digit variants assume same.
  const strike = strikeRaw / 1000;
  return {
    raw: symbol,
    root: g.root,
    expiry: `${year}-${pad2(month)}-${pad2(day)}`,
    yymmdd: `${g.yy}${g.mm}${g.dd}`,
    type: g.type,                   // 'C' | 'P'
    side: g.type === 'C' ? 'call' : 'put',
    strike,
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Build the standard OCC symbol form used by the broker, by replacing strike/type
 * inside a template that is known to work. Useful when constructing strikes around ATM
 * if we already know one valid symbol.
 *
 * NB: many brokers pad ROOT with spaces. We preserve whatever padding was in `templateSymbol`.
 */
function rebuildSymbol(templateSymbol, { strike, type } = {}) {
  if (typeof templateSymbol !== 'string') return null;
  // locate the YYMMDD[CP]NNNNNNNN tail
  const tailRx = /(\d{6})([CP])(\d{6,8})$/;
  const tail = templateSymbol.match(tailRx);
  if (!tail) return null;
  const head = templateSymbol.slice(0, templateSymbol.length - tail[0].length); // root + padding
  const yymmdd = tail[1];
  const newType = (type || tail[2]).toUpperCase();
  const newStrike = strike != null ? strike : parseInt(tail[3], 10) / 1000;
  const strikeStr = String(Math.round(newStrike * 1000)).padStart(tail[3].length, '0');
  return `${head}${yymmdd}${newType}${strikeStr}`;
}

/**
 * Given a list of broker symbols, return the option chain grouped by expiry and strike.
 *   { expiries: ['2026-05-20', ...], byExpiry: { '2026-05-20': { strikes: [...], byStrike: { 734: { call, put }, ... } } } }
 *
 * Non-option symbols are silently filtered out.
 */
function buildChain(symbols) {
  const byExpiry = {};
  for (const sym of symbols) {
    const name = typeof sym === 'string' ? sym : sym?.name;
    if (!name) continue;
    const p = parseOCC(name);
    if (!p) continue;
    if (!byExpiry[p.expiry]) byExpiry[p.expiry] = { strikes: new Set(), byStrike: {} };
    const exp = byExpiry[p.expiry];
    exp.strikes.add(p.strike);
    if (!exp.byStrike[p.strike]) exp.byStrike[p.strike] = { call: null, put: null };
    exp.byStrike[p.strike][p.side] = name;
  }
  // finalize: sort strikes
  for (const exp of Object.values(byExpiry)) {
    exp.strikes = [...exp.strikes].sort((a, b) => a - b);
  }
  const expiries = Object.keys(byExpiry).sort();
  return { expiries, byExpiry };
}

/**
 * Pick 21 strikes around `atm`: the nearest strike + 10 above + 10 below from a sorted list.
 * Returns array of strikes ordered ascending. Fewer than 21 if chain is thin.
 */
function pickStrikesAroundATM(sortedStrikes, atm, side = 10) {
  if (!sortedStrikes.length) return [];
  // index of nearest strike
  let nearestIdx = 0;
  let nearestDist = Math.abs(sortedStrikes[0] - atm);
  for (let i = 1; i < sortedStrikes.length; i++) {
    const d = Math.abs(sortedStrikes[i] - atm);
    if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
  }
  const lo = Math.max(0, nearestIdx - side);
  const hi = Math.min(sortedStrikes.length - 1, nearestIdx + side);
  return sortedStrikes.slice(lo, hi + 1);
}

module.exports = { parseOCC, rebuildSymbol, buildChain, pickStrikesAroundATM };
