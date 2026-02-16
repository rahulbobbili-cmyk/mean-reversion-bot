// alpaca.js — Alpaca REST API wrapper for Node.js
// Ported from tsla_dashboard.html — uses native fetch (Node 18+)

const DATA_BASE_URL = 'https://data.alpaca.markets/v2';
const TRADE_BASE_URL = 'https://paper-api.alpaca.markets';

class AlpacaClient {
  constructor(apiKey, apiSecret, feed) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.feed = feed || 'sip';
    this._cache = new Map();
  }

  _getHeaders() {
    return {
      'APCA-API-KEY-ID': this.apiKey,
      'APCA-API-SECRET-KEY': this.apiSecret,
    };
  }

  async _fetchJSON(url) {
    const resp = await fetch(url, { headers: this._getHeaders() });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (resp.status === 401 || resp.status === 403)
        throw new Error('Invalid API credentials. Check your API key and secret.');
      if (resp.status === 429)
        throw new Error('Rate limited by Alpaca. Wait a moment and try again.');
      if (resp.status === 422)
        throw new Error('Invalid request: ' + body);
      throw new Error('Alpaca API error ' + resp.status + ': ' + body);
    }
    return resp.json();
  }

  // ---- Market Data ----

  async fetchBars(symbol, timeframe, start, end, useCache) {
    useCache = useCache !== false; // default true
    const cacheKey = symbol + '_' + timeframe + '_' + start + '_' + end;
    if (useCache && this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    let allBars = [];
    let pageToken = null;

    do {
      const params = new URLSearchParams({
        timeframe,
        start,
        end,
        limit: '10000',
        feed: this.feed,
        sort: 'asc',
      });
      if (pageToken) params.set('page_token', pageToken);

      const url = DATA_BASE_URL + '/stocks/' + symbol + '/bars?' + params.toString();
      const data = await this._fetchJSON(url);
      if (data.bars && data.bars.length > 0) {
        allBars = allBars.concat(data.bars);
      }
      pageToken = data.next_page_token || null;
    } while (pageToken);

    if (useCache) this._cache.set(cacheKey, allBars);
    return allBars;
  }

  // Fetch 30-min intraday bars for a single day (extended hours: 4AM–8PM ET)
  async fetchIntradayBars(dateStr, symbol, useCache) {
    const start = dateStr + 'T04:00:00-05:00';
    const end = dateStr + 'T20:00:00-05:00';
    return this.fetchBars(symbol, '30Min', start, end, useCache);
  }

  // Fetch daily bars (20 days lookback for finding prev trading dates)
  async fetchDailyBars(endDateStr, count, symbol) {
    count = count || 20;
    const endD = new Date(endDateStr + 'T12:00:00Z');
    const startD = new Date(endD);
    startD.setDate(startD.getDate() - Math.ceil(count * 1.6));
    const startStr = startD.toISOString().slice(0, 10);
    return this.fetchBars(symbol, '1Day', startStr, endDateStr);
  }

  clearTodayCache(symbol, dateStr) {
    const start = dateStr + 'T04:00:00-05:00';
    const end = dateStr + 'T20:00:00-05:00';
    const cacheKey = symbol + '_30Min_' + start + '_' + end;
    this._cache.delete(cacheKey);
  }

  // ---- Paper Trading ----

  async getAccount() {
    return this._fetchJSON(TRADE_BASE_URL + '/v2/account');
  }

  async getPosition(symbol) {
    try {
      return await this._fetchJSON(TRADE_BASE_URL + '/v2/positions/' + symbol);
    } catch (e) {
      return null; // 404 = no position
    }
  }

  async placeOrder(symbol, qty, side, type) {
    type = type || 'market';
    const resp = await fetch(TRADE_BASE_URL + '/v2/orders', {
      method: 'POST',
      headers: { ...this._getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol,
        qty: String(qty),
        side,
        type,
        time_in_force: 'day',
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error('Order error ' + resp.status + ': ' + body);
    }
    return resp.json();
  }

  async closePosition(symbol) {
    const resp = await fetch(TRADE_BASE_URL + '/v2/positions/' + symbol, {
      method: 'DELETE',
      headers: this._getHeaders(),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error('Close position error ' + resp.status + ': ' + body);
    }
    return resp.json();
  }

  async closeAllPositions() {
    const resp = await fetch(TRADE_BASE_URL + '/v2/positions?cancel_orders=true', {
      method: 'DELETE',
      headers: this._getHeaders(),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error('Close all error ' + resp.status + ': ' + body);
    }
    return resp.json();
  }
}

module.exports = { AlpacaClient, DATA_BASE_URL, TRADE_BASE_URL };
