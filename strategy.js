// strategy.js — Linear regression + signal detection logic
// Ported from tsla_dashboard.html

const REG_BAND_MULT = 2.5;   // ±2.5σ entry bands
const REG_REF_MULT = 1.5;    // ±1.5σ reference bands (not used in bot, kept for parity)
const DEFAULT_STOP_LOSS_PCT = 5.0;

// Session boundaries in ET (Eastern Time) — minutes from midnight
const SESSIONS_ET = {
  PREMARKET:  { startMin: 4 * 60,       endMin: 9 * 60 + 30 },
  RTH:        { startMin: 9 * 60 + 30,  endMin: 16 * 60 },
  AFTERHOURS: { startMin: 16 * 60,      endMin: 23 * 60 + 59 },
};

// Convert Alpaca bar → candle object
function toCandle(bar) {
  return {
    time: Math.floor(new Date(bar.t).getTime() / 1000),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v || 0,
  };
}

// Get ET minutes-from-midnight for a UTC timestamp (seconds)
function getETMinutes(utcSeconds) {
  const d = new Date(utcSeconds * 1000);
  const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const parts = etStr.split(', ')[1] || etStr;
  const timeParts = parts.split(':');
  let h = parseInt(timeParts[0], 10);
  const m = parseInt(timeParts[1], 10);
  if (h === 24) h = 0;
  return h * 60 + m;
}

// Classify session: PREMARKET / RTH / AFTERHOURS
function getSession(utcSeconds) {
  const mins = getETMinutes(utcSeconds);
  if (mins < SESSIONS_ET.RTH.startMin) return 'PREMARKET';
  if (mins < SESSIONS_ET.RTH.endMin) return 'RTH';
  return 'AFTERHOURS';
}

// Find N previous trading dates from daily bars
function getPrevNTradingDates(dailyBars, selectedDateStr, n) {
  if (!dailyBars || dailyBars.length < 2) return [];
  const before = dailyBars.filter(b => b.t.slice(0, 10) < selectedDateStr);
  const dates = [];
  for (let i = before.length - 1; i >= 0 && dates.length < n; i--) {
    dates.push(before[i].t.slice(0, 10));
  }
  return dates; // [prevDay1 (most recent), prevDay2, ...]
}

// Compute linear regression over 5-day candle array
// Returns: { slope, intercept, sigma, x0, reg, upper, lower } or empty
function computeRegression(candles) {
  const empty = { reg: [], upper: [], lower: [], slope: 0, intercept: 0, sigma: 0, x0: 0 };
  if (!candles || candles.length < 2) return empty;

  const n = candles.length;
  const xs = candles.map(c => c.time);
  const ys = candles.map(c => c.close);

  // Normalize x to avoid precision issues
  const x0 = xs[0];
  const xn = xs.map(x => x - x0);

  // Least-squares linear regression: y = a + b * x
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xn[i];
    sumY += ys[i];
    sumXY += xn[i] * ys[i];
    sumX2 += xn[i] * xn[i];
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return empty;

  const b = (n * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / n;

  // Compute residuals for σ
  let sumResid2 = 0;
  const regVals = [];
  for (let i = 0; i < n; i++) {
    const regY = a + b * xn[i];
    regVals.push(regY);
    const resid = ys[i] - regY;
    sumResid2 += resid * resid;
  }
  const sigma = Math.sqrt(sumResid2 / n);

  return { slope: b, intercept: a, sigma, x0 };
}

module.exports = {
  REG_BAND_MULT,
  REG_REF_MULT,
  DEFAULT_STOP_LOSS_PCT,
  SESSIONS_ET,
  toCandle,
  getETMinutes,
  getSession,
  getPrevNTradingDates,
  computeRegression,
};
