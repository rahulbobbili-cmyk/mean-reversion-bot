# TSLA Regression Trading Bot

Automated paper trading bot using a 5-day linear regression with +/-2.5 sigma entry bands. Runs on Railway (or any Node.js 18+ host) and trades via Alpaca Paper Trading API.

## Strategy

- **Window**: 5 trading days (4 previous + current) of 30-min bars
- **Entry**: Market order when latest bar touches the +/-2.5 sigma band
  - Upper band touch -> SHORT
  - Lower band touch -> LONG
- **Exit**: When price touches the regression line, or stop-loss % triggers
- **Session**: RTH only (9:30 AM - 4:00 PM ET)
- **Carry**: Positions carry overnight (no EOD liquidation)
- **Polling**: Every 30 seconds (configurable)

## Setup

### 1. Environment Variables

Copy `.env.example` to `.env` and fill in your Alpaca paper trading credentials:

```
ALPACA_API_KEY=PKxxxxxxxxxxxxxxxx
ALPACA_API_SECRET=your_secret_here
ALPACA_FEED=sip
SYMBOL=TSLA
QTY=1
STOP_LOSS_PCT=5.0
POLL_INTERVAL_MS=30000
```

### 2. Local Testing

```bash
node index.js
```

No `npm install` needed -- zero dependencies, uses Node 18+ native fetch.

### 3. Deploy to Railway

1. Push this repo to GitHub (private repo recommended)
2. Sign up at [railway.app](https://railway.app)
3. New Project -> Deploy from GitHub repo
4. Add environment variables in Railway dashboard (same as .env)
5. Deploy -- Railway runs `npm start` which calls `node index.js`

### Monitoring

- **Railway logs**: View stdout in the Railway dashboard Logs tab
- **Alpaca**: Check orders and positions at [paper.alpaca.markets](https://paper.alpaca.markets)

### Changing Settings

Update environment variables in Railway dashboard. Railway auto-redeploys on env var changes.

### Stopping the Bot

Delete or pause the Railway service, or remove the deployment.

## Files

| File | Description |
|------|-------------|
| `index.js` | Main polling loop, signal detection, order execution |
| `alpaca.js` | Alpaca REST API wrapper (data + trading) |
| `strategy.js` | Linear regression, session classification, helpers |
| `package.json` | Zero dependencies, Node 18+ |
| `railway.json` | Railway deploy config with restart policy |
| `.env.example` | Environment variable template |
