// index.js — Main bot loop for TSLA regression trading bot
// Runs on Railway (or locally). Polls every POLL_INTERVAL_MS during RTH.
// Serves a web dashboard on PORT for live monitoring.

const http = require('http');
const fs = require('fs');
const path = require('path');

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
const PORT       = parseInt(process.env.PORT || '3000', 10);

if (!API_KEY || !API_SECRET) {
  console.error('[FATAL] Missing ALPACA_API_KEY or ALPACA_API_SECRET. Set env vars and restart.');
  process.exit(1);
}

const client = new AlpacaClient(API_KEY, API_SECRET, FEED);

// ── Bot State (exposed via API for dashboard) ──

const botState = {
  startedAt: new Date().toISOString(),
  lastTick: null,
  session: null,
  account: null,
  position: null,
  lastTickData: null,
  candles: [],
  regression: null,
  tradeLog: [],
  config: { symbol: SYMBOL, qty: QTY, slPct: SL_PCT, pollMs: POLL_MS, feed: FEED },
};

function addLogEntry(message, type) {
  const entry = {
    time: nowET(),
    message,
    type: type || 'info', // info, entry, exit, error
  };
  botState.tradeLog.unshift(entry);
  if (botState.tradeLog.length > 100) botState.tradeLog.length = 100;
}

// ── Helpers ──

function nowET() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
}

function log(msg) {
  const et = nowET();
  console.log(`[${et}] ${msg}`);
}

function todayDateStr() {
  const d = new Date();
  const etStr = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const parts = etStr.split('/');
  const mm = parts[0].padStart(2, '0');
  const dd = parts[1].padStart(2, '0');
  const yyyy = parts[2];
  return `${yyyy}-${mm}-${dd}`;
}

function isWeekend() {
  const d = new Date();
  const etStr = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return etStr === 'Sat' || etStr === 'Sun';
}

function uptimeStr() {
  const ms = Date.now() - new Date(botState.startedAt).getTime();
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60}s`;
}

// ── Main tick ──

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;

  try {
    botState.lastTick = new Date().toISOString();

    // Skip weekends
    if (isWeekend()) {
      botState.session = 'WEEKEND';
      log('Weekend — sleeping...');
      addLogEntry('Weekend — sleeping...', 'info');
      return;
    }

    const today = todayDateStr();

    // 1. Clear today's cache to get fresh bars
    client.clearTodayCache(SYMBOL, today);

    // 2. Fetch today's 30-min bars (no cache)
    const intradayBars = await client.fetchIntradayBars(today, SYMBOL, false);
    if (intradayBars.length === 0) {
      botState.session = 'CLOSED';
      log('No intraday bars yet (holiday or pre-open). Sleeping...');
      addLogEntry('No intraday bars (holiday/pre-open). Sleeping...', 'info');
      return;
    }

    // 3. Check if latest bar is RTH
    const lastBar = intradayBars[intradayBars.length - 1];
    const ts = Math.floor(new Date(lastBar.t).getTime() / 1000);
    const session = getSession(ts);
    botState.session = session;

    if (session !== 'RTH') {
      log(`Outside RTH (session=${session}). Sleeping...`);
      addLogEntry(`Outside RTH (${session}). Sleeping...`, 'info');
      return;
    }

    // 4. Fetch daily bars (for finding prev trading dates)
    const dailyBars = await client.fetchDailyBars(today, 20, SYMBOL);

    // 5. Fetch 4 previous trading days' intraday bars
    const prevDates = getPrevNTradingDates(dailyBars, today, 4);
    const prevBarsAll = [];
    for (const pd of prevDates) {
      const bars = await client.fetchIntradayBars(pd, SYMBOL, true);
      prevBarsAll.push(bars);
    }

    // 6. Build 5-day candle array → compute regression
    const allCandles = [];
    for (let p = prevBarsAll.length - 1; p >= 0; p--) {
      allCandles.push(...prevBarsAll[p].map(toCandle));
    }
    allCandles.push(...intradayBars.map(toCandle));

    const regData = computeRegression(allCandles);

    // Store chart data for dashboard
    botState.candles = allCandles;
    botState.regression = regData.sigma ? { slope: regData.slope, intercept: regData.intercept, sigma: regData.sigma, x0: regData.x0 } : null;

    if (!regData.sigma || regData.sigma < 0.001) {
      log(`Regression σ too small (${regData.sigma?.toFixed(4)}). Skipping...`);
      addLogEntry(`Regression σ too small (${regData.sigma?.toFixed(4)}).`, 'info');
      return;
    }

    // 7. Compute values at latest bar
    const regVal = regData.intercept + regData.slope * (ts - regData.x0);
    const bandOffset = REG_BAND_MULT * regData.sigma;
    const upperBand = regVal + bandOffset;
    const lowerBand = regVal - bandOffset;
    const slPct = SL_PCT / 100;

    botState.lastTickData = {
      regVal, upperBand, lowerBand,
      sigma: regData.sigma,
      barCount: intradayBars.length,
      lastBar: { h: lastBar.h, l: lastBar.l, c: lastBar.c, t: lastBar.t },
    };

    log(`Tick: ${intradayBars.length} bars, σ=${regData.sigma.toFixed(2)}, reg=${regVal.toFixed(2)}, upper=${upperBand.toFixed(2)}, lower=${lowerBand.toFixed(2)}, last=[H:${lastBar.h.toFixed(2)} L:${lastBar.l.toFixed(2)} C:${lastBar.c.toFixed(2)}]`);

    // 8. Get current Alpaca position & account
    const account = await client.getAccount();
    botState.account = account ? { equity: account.equity, buyingPower: account.buying_power, cash: account.cash } : null;

    const alpacaPos = await client.getPosition(SYMBOL);
    const hasLong = alpacaPos && parseFloat(alpacaPos.qty) > 0;
    const hasShort = alpacaPos && parseFloat(alpacaPos.qty) < 0;
    const curQty = alpacaPos ? Math.abs(parseFloat(alpacaPos.qty)) : 0;
    const entryPrice = alpacaPos ? parseFloat(alpacaPos.avg_entry_price) : 0;

    if (alpacaPos) {
      const side = hasLong ? 'LONG' : 'SHORT';
      const unrealPnl = parseFloat(alpacaPos.unrealized_pl || '0');
      botState.position = { side, qty: curQty, entryPrice, unrealizedPnl: unrealPnl, marketValue: alpacaPos.market_value };
      log(`Position: ${side} ${curQty}x @ ${entryPrice.toFixed(2)}, unrealPnL=$${unrealPnl.toFixed(2)}`);
    } else {
      botState.position = null;
      log('No position.');
    }

    // 9. EXIT logic — check SL% and regression line touch
    let exitedThisTick = false;

    if (hasLong) {
      const stopPrice = entryPrice * (1 - slPct);
      if (lastBar.l <= stopPrice) {
        log(`EXIT STOP: low ${lastBar.l.toFixed(2)} <= stop ${stopPrice.toFixed(2)}`);
        addLogEntry(`EXIT STOP: low ${lastBar.l.toFixed(2)} <= stop ${stopPrice.toFixed(2)}`, 'exit');
        exitedThisTick = true;
        try {
          const order = await client.closePosition(SYMBOL);
          log(`  → Closed LONG position. Order ID: ${order.id || 'N/A'}`);
          addLogEntry(`Closed LONG. Order: ${order.id || 'N/A'}`, 'exit');
        } catch (err) {
          log(`  → ERROR closing position: ${err.message}`);
          addLogEntry(`ERROR closing LONG: ${err.message}`, 'error');
        }
        botState.position = null;
      } else if (lastBar.h >= regVal) {
        log(`EXIT REG: high ${lastBar.h.toFixed(2)} >= regVal ${regVal.toFixed(2)}`);
        addLogEntry(`EXIT REG: high ${lastBar.h.toFixed(2)} >= reg ${regVal.toFixed(2)}`, 'exit');
        exitedThisTick = true;
        try {
          const order = await client.closePosition(SYMBOL);
          log(`  → Closed LONG position. Order ID: ${order.id || 'N/A'}`);
          addLogEntry(`Closed LONG. Order: ${order.id || 'N/A'}`, 'exit');
        } catch (err) {
          log(`  → ERROR closing position: ${err.message}`);
          addLogEntry(`ERROR closing LONG: ${err.message}`, 'error');
        }
        botState.position = null;
      }
    }

    if (hasShort) {
      const stopPrice = entryPrice * (1 + slPct);
      if (lastBar.h >= stopPrice) {
        log(`EXIT STOP: high ${lastBar.h.toFixed(2)} >= stop ${stopPrice.toFixed(2)}`);
        addLogEntry(`EXIT STOP: high ${lastBar.h.toFixed(2)} >= stop ${stopPrice.toFixed(2)}`, 'exit');
        exitedThisTick = true;
        try {
          const order = await client.closePosition(SYMBOL);
          log(`  → Closed SHORT position. Order ID: ${order.id || 'N/A'}`);
          addLogEntry(`Closed SHORT. Order: ${order.id || 'N/A'}`, 'exit');
        } catch (err) {
          log(`  → ERROR closing position: ${err.message}`);
          addLogEntry(`ERROR closing SHORT: ${err.message}`, 'error');
        }
        botState.position = null;
      } else if (lastBar.l <= regVal) {
        log(`EXIT REG: low ${lastBar.l.toFixed(2)} <= regVal ${regVal.toFixed(2)}`);
        addLogEntry(`EXIT REG: low ${lastBar.l.toFixed(2)} <= reg ${regVal.toFixed(2)}`, 'exit');
        exitedThisTick = true;
        try {
          const order = await client.closePosition(SYMBOL);
          log(`  → Closed SHORT position. Order ID: ${order.id || 'N/A'}`);
          addLogEntry(`Closed SHORT. Order: ${order.id || 'N/A'}`, 'exit');
        } catch (err) {
          log(`  → ERROR closing position: ${err.message}`);
          addLogEntry(`ERROR closing SHORT: ${err.message}`, 'error');
        }
        botState.position = null;
      }
    }

    // 10. ENTRY logic — no position and didn't just exit
    if (!exitedThisTick && !hasLong && !hasShort) {
      if (lastBar.h >= upperBand) {
        log(`ENTRY SHORT: high ${lastBar.h.toFixed(2)} >= upperBand ${upperBand.toFixed(2)}`);
        addLogEntry(`ENTRY SHORT: high ${lastBar.h.toFixed(2)} >= upper ${upperBand.toFixed(2)}`, 'entry');
        try {
          const order = await client.placeOrder(SYMBOL, QTY, 'sell');
          log(`  → Placed SELL order. Order ID: ${order.id || 'N/A'}`);
          addLogEntry(`Placed SELL ${QTY}x ${SYMBOL}. Order: ${order.id || 'N/A'}`, 'entry');
        } catch (err) {
          log(`  → ERROR placing order: ${err.message}`);
          addLogEntry(`ERROR placing SELL: ${err.message}`, 'error');
        }
      } else if (lastBar.l <= lowerBand) {
        log(`ENTRY LONG: low ${lastBar.l.toFixed(2)} <= lowerBand ${lowerBand.toFixed(2)}`);
        addLogEntry(`ENTRY LONG: low ${lastBar.l.toFixed(2)} <= lower ${lowerBand.toFixed(2)}`, 'entry');
        try {
          const order = await client.placeOrder(SYMBOL, QTY, 'buy');
          log(`  → Placed BUY order. Order ID: ${order.id || 'N/A'}`);
          addLogEntry(`Placed BUY ${QTY}x ${SYMBOL}. Order: ${order.id || 'N/A'}`, 'entry');
        } catch (err) {
          log(`  → ERROR placing order: ${err.message}`);
          addLogEntry(`ERROR placing BUY: ${err.message}`, 'error');
        }
      } else {
        log('No signal. Waiting...');
      }
    }

  } catch (err) {
    log(`TICK ERROR: ${err.message}`);
    addLogEntry(`TICK ERROR: ${err.message}`, 'error');
  } finally {
    ticking = false;
  }
}

// ── HTTP Server (Dashboard + API) ──

let dashboardHTML = '';
try {
  dashboardHTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');
} catch (e) {
  dashboardHTML = '<html><body><h1>Dashboard file not found</h1></body></html>';
}

function sendJSON(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]; // strip query params

  if (url === '/api/status') {
    sendJSON(res, {
      uptime: uptimeStr(),
      startedAt: botState.startedAt,
      lastTick: botState.lastTick,
      session: botState.session,
      config: botState.config,
      account: botState.account,
      position: botState.position,
      lastTickData: botState.lastTickData,
    });
    return;
  }

  if (url === '/api/chart') {
    sendJSON(res, {
      candles: botState.candles,
      regression: botState.regression,
    });
    return;
  }

  if (url === '/api/log') {
    sendJSON(res, {
      entries: botState.tradeLog,
    });
    return;
  }

  // Serve dashboard HTML for everything else
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(dashboardHTML);
});

// ── Startup ──

server.listen(PORT, () => {
  log(`Dashboard running at http://localhost:${PORT}`);
});

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
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
