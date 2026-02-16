// index.js — Main bot loop for TSLA regression trading bot
// Runs on Railway (or locally). Polls every POLL_INTERVAL_MS during RTH.

const { AlpacaClient } = require('./alpaca');
const {
  REG_BAND_MULT,
  DEFAULT_STOP_LOSS_PCT,
  toCandle,
  getSession,
  getPrevNTradingDates,
  computeRegression,
} = require('./strategy');

// ── Config from environment ──
const API_KEY    = process.env.ALPACA_API_KEY    || '';
const API_SECRET = process.env.ALPACA_API_SECRET || '';
const FEED       = process.env.ALPACA_FEED       || 'sip';
const SYMBOL     = process.env.SYMBOL            || 'TSLA';
const QTY        = parseInt(process.env.QTY      || '1', 10);
const SL_PCT     = parseFloat(process.env.STOP_LOSS_PCT || String(DEFAULT_STOP_LOSS_PCT));
const POLL_MS    = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);

if (!API_KEY || !API_SECRET) {
  console.error('[FATAL] Missing ALPACA_API_KEY or ALPACA_API_SECRET. Set env vars and restart.');
  process.exit(1);
}

const client = new AlpacaClient(API_KEY, API_SECRET, FEED);

// ── Helpers ──

function nowET() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
}

function log(msg) {
  const et = nowET();
  console.log(`[${et}] ${msg}`);
}

function todayDateStr() {
  // Get today's date in YYYY-MM-DD format in ET
  const d = new Date();
  const etStr = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  // etStr is "M/D/YYYY"
  const parts = etStr.split('/');
  const mm = parts[0].padStart(2, '0');
  const dd = parts[1].padStart(2, '0');
  const yyyy = parts[2];
  return `${yyyy}-${mm}-${dd}`;
}

function isWeekend() {
  const d = new Date();
  // Get day of week in ET
  const etStr = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return etStr === 'Sat' || etStr === 'Sun';
}

// ── Main tick ──

let ticking = false;

async function tick() {
  if (ticking) return; // prevent overlapping ticks
  ticking = true;

  try {
    // Skip weekends
    if (isWeekend()) {
      log('Weekend — sleeping...');
      return;
    }

    const today = todayDateStr();

    // 1. Clear today's cache to get fresh bars
    client.clearTodayCache(SYMBOL, today);

    // 2. Fetch today's 30-min bars (no cache)
    const intradayBars = await client.fetchIntradayBars(today, SYMBOL, false);
    if (intradayBars.length === 0) {
      log('No intraday bars yet (holiday or pre-open). Sleeping...');
      return;
    }

    // 3. Check if latest bar is RTH
    const lastBar = intradayBars[intradayBars.length - 1];
    const ts = Math.floor(new Date(lastBar.t).getTime() / 1000);
    const session = getSession(ts);

    if (session !== 'RTH') {
      log(`Outside RTH (session=${session}). Sleeping...`);
      return;
    }

    // 4. Fetch daily bars (for finding prev trading dates)
    const dailyBars = await client.fetchDailyBars(today, 20, SYMBOL);

    // 5. Fetch 4 previous trading days' intraday bars
    const prevDates = getPrevNTradingDates(dailyBars, today, 4);
    const prevBarsAll = [];
    for (const pd of prevDates) {
      const bars = await client.fetchIntradayBars(pd, SYMBOL, true); // cached
      prevBarsAll.push(bars);
    }

    // 6. Build 5-day candle array → compute regression
    const allCandles = [];
    for (let p = prevBarsAll.length - 1; p >= 0; p--) {
      allCandles.push(...prevBarsAll[p].map(toCandle));
    }
    allCandles.push(...intradayBars.map(toCandle));

    const regData = computeRegression(allCandles);
    if (!regData.sigma || regData.sigma < 0.001) {
      log(`Regression σ too small (${regData.sigma?.toFixed(4)}). Skipping...`);
      return;
    }

    // 7. Compute values at latest bar
    const regVal = regData.intercept + regData.slope * (ts - regData.x0);
    const bandOffset = REG_BAND_MULT * regData.sigma;
    const upperBand = regVal + bandOffset;
    const lowerBand = regVal - bandOffset;
    const slPct = SL_PCT / 100;

    log(`Tick: ${intradayBars.length} bars, σ=${regData.sigma.toFixed(2)}, reg=${regVal.toFixed(2)}, upper=${upperBand.toFixed(2)}, lower=${lowerBand.toFixed(2)}, last=[H:${lastBar.h.toFixed(2)} L:${lastBar.l.toFixed(2)} C:${lastBar.c.toFixed(2)}]`);

    // 8. Get current Alpaca position
    const alpacaPos = await client.getPosition(SYMBOL);
    const hasLong = alpacaPos && parseFloat(alpacaPos.qty) > 0;
    const hasShort = alpacaPos && parseFloat(alpacaPos.qty) < 0;
    const curQty = alpacaPos ? Math.abs(parseFloat(alpacaPos.qty)) : 0;
    const entryPrice = alpacaPos ? parseFloat(alpacaPos.avg_entry_price) : 0;

    if (alpacaPos) {
      const side = hasLong ? 'LONG' : 'SHORT';
      const unrealPnl = parseFloat(alpacaPos.unrealized_pl || '0');
      log(`Position: ${side} ${curQty}x @ ${entryPrice.toFixed(2)}, unrealPnL=$${unrealPnl.toFixed(2)}`);
    } else {
      log('No position.');
    }

    // 9. EXIT logic — check SL% and regression line touch
    let exitedThisTick = false;

    if (hasLong) {
      const stopPrice = entryPrice * (1 - slPct);
      if (lastBar.l <= stopPrice) {
        log(`EXIT STOP: low ${lastBar.l.toFixed(2)} <= stop ${stopPrice.toFixed(2)}`);
        exitedThisTick = true;
        try {
          const order = await client.closePosition(SYMBOL);
          log(`  → Closed LONG position. Order ID: ${order.id || 'N/A'}`);
        } catch (err) {
          log(`  → ERROR closing position: ${err.message}`);
        }
      } else if (lastBar.h >= regVal) {
        log(`EXIT REG: high ${lastBar.h.toFixed(2)} >= regVal ${regVal.toFixed(2)}`);
        exitedThisTick = true;
        try {
          const order = await client.closePosition(SYMBOL);
          log(`  → Closed LONG position. Order ID: ${order.id || 'N/A'}`);
        } catch (err) {
          log(`  → ERROR closing position: ${err.message}`);
        }
      }
    }

    if (hasShort) {
      const stopPrice = entryPrice * (1 + slPct);
      if (lastBar.h >= stopPrice) {
        log(`EXIT STOP: high ${lastBar.h.toFixed(2)} >= stop ${stopPrice.toFixed(2)}`);
        exitedThisTick = true;
        try {
          const order = await client.closePosition(SYMBOL);
          log(`  → Closed SHORT position. Order ID: ${order.id || 'N/A'}`);
        } catch (err) {
          log(`  → ERROR closing position: ${err.message}`);
        }
      } else if (lastBar.l <= regVal) {
        log(`EXIT REG: low ${lastBar.l.toFixed(2)} <= regVal ${regVal.toFixed(2)}`);
        exitedThisTick = true;
        try {
          const order = await client.closePosition(SYMBOL);
          log(`  → Closed SHORT position. Order ID: ${order.id || 'N/A'}`);
        } catch (err) {
          log(`  → ERROR closing position: ${err.message}`);
        }
      }
    }

    // 10. ENTRY logic — no position and didn't just exit
    if (!exitedThisTick && !hasLong && !hasShort) {
      if (lastBar.h >= upperBand) {
        log(`ENTRY SHORT: high ${lastBar.h.toFixed(2)} >= upperBand ${upperBand.toFixed(2)}`);
        try {
          const order = await client.placeOrder(SYMBOL, QTY, 'sell');
          log(`  → Placed SELL order. Order ID: ${order.id || 'N/A'}`);
        } catch (err) {
          log(`  → ERROR placing order: ${err.message}`);
        }
      } else if (lastBar.l <= lowerBand) {
        log(`ENTRY LONG: low ${lastBar.l.toFixed(2)} <= lowerBand ${lowerBand.toFixed(2)}`);
        try {
          const order = await client.placeOrder(SYMBOL, QTY, 'buy');
          log(`  → Placed BUY order. Order ID: ${order.id || 'N/A'}`);
        } catch (err) {
          log(`  → ERROR placing order: ${err.message}`);
        }
      } else {
        log('No signal. Waiting...');
      }
    }

  } catch (err) {
    log(`TICK ERROR: ${err.message}`);
  } finally {
    ticking = false;
  }
}

// ── Startup ──

log('========================================');
log(`Bot started: ${SYMBOL} x${QTY}, SL=${SL_PCT}%, poll=${POLL_MS / 1000}s, feed=${FEED}`);
log('========================================');

// Run first tick immediately
tick();

// Then poll on interval
const intervalId = setInterval(tick, POLL_MS);

// Graceful shutdown (Railway sends SIGTERM on redeploy)
function shutdown(signal) {
  log(`Received ${signal}. Shutting down gracefully...`);
  clearInterval(intervalId);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
