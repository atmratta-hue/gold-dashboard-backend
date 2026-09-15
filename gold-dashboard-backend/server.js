require('dotenv').config();
const express = require('express');
const path = require('path');
const Parser = require('rss-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const rssParser = new Parser();

app.use(express.static(path.join(__dirname, 'public')));

const cacheStore = {};
const CACHE_TTL = 10 * 1000; // Cache 10 วินาที เพื่อให้ข้อมูล Realtime

// 1. คำนวณ Stochastic Oscillator (%K, %D)
function calculateStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (!candles || candles.length < kPeriod + dPeriod) {
    return { k: 50, d: 50 };
  }

  const kValues = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const highestHigh = Math.max(...slice.map(c => c.high));
    const lowestLow = Math.min(...slice.map(c => c.low));
    const currentClose = slice[slice.length - 1].close;

    let k = 50;
    if (highestHigh !== lowestLow) {
      k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    }
    kValues.push(k);
  }

  const currentK = kValues[kValues.length - 1];
  const recentK = kValues.slice(-dPeriod);
  const currentD = recentK.reduce((sum, val) => sum + val, 0) / recentK.length;

  return {
    k: parseFloat(currentK.toFixed(2)),
    d: parseFloat(currentD.toFixed(2))
  };
}

// 2. วิเคราะห์ SMC Structure & Zone
function analyzeSMC(candles) {
  if (!candles || candles.length < 15) {
    return {
      structure: 'Sideway',
      zone: 'Equilibrium',
      orderBlock: 'None',
      trend: 'ขาขึ้น'
    };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);
  const currentPrice = closes[closes.length - 1];
  const eqPrice = (highestHigh + lowestLow) / 2;

  const zone = currentPrice > eqPrice ? 'Premium (โซนแพง)' : 'Discount (โซนถูก)';

  const recentHigh = Math.max(...highs.slice(-10, -1));
  const recentLow = Math.min(...lows.slice(-10, -1));

  let structure = 'Sideway';
  let trend = currentPrice >= closes[0] ? 'ขาขึ้น' : 'ขาลง';

  if (currentPrice > recentHigh) {
    structure = 'Bullish BOS';
    trend = 'ขาขึ้น';
  } else if (currentPrice < recentLow) {
    structure = 'Bearish BOS';
    trend = 'ขาลง';
  }

  let orderBlock = trend === 'ขาขึ้น' ? `Bullish OB (~${recentLow.toFixed(2)})` : `Bearish OB (~${recentHigh.toFixed(2)})`;

  return { structure, zone, orderBlock, trend };
}

// 3. จำลอง/ดึงแท่งเทียนตาม Timeframe (1m, 5m, 1h, 4h, 1d)
async function fetchGoldCandles(timeframe = '1h') {
  try {
    const intervalMap = { '1m': '1m', '5m': '5m', '1h': 'h', '4h': '4h', '1d': 'd' };
    const interval = intervalMap[timeframe] || 'h';
    const url = `https://stooq.com/q/d/l/?s=xauusd&i=${interval}`;

    const resp = await axios.get(url, { timeout: 3000 });
    const lines = resp.data.trim().split('\n');
    let candles = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 5) {
        const open = parseFloat(parts[1]);
        const high = parseFloat(parts[2]);
        const low = parseFloat(parts[3]);
        const close = parseFloat(parts[4]);
        if (!isNaN(close)) candles.push({ open, high, low, close });
      }
    }
    return candles.length >= 20 ? candles : generateDemoCandles(timeframe);
  } catch (err) {
    return generateDemoCandles(timeframe);
  }
}

function generateDemoCandles(timeframe = '1h') {
  const basePrice = 2740.50;
  const volatilityMap = { '1m': 0.5, '5m': 1.2, '1h': 4.0, '4h': 8.0, '1d': 18.0 };
  const vol = volatilityMap[timeframe] || 2.0;

  const candles = [];
  let current = basePrice;
  for (let i = 0; i < 40; i++) {
    const change = (Math.random() - 0.49) * vol;
    current += change;
    candles.push({
      open: current - change * 0.5,
      high: current + Math.abs(change) * 1.2,
      low: current - Math.abs(change) * 1.2,
      close: current
    });
  }
  return candles;
}

// 4. API Dashboard Main Endpoint
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const timeframe = (req.query.tf || '1h').toLowerCase();
    const validTFs = ['1m', '5m', '1h', '4h', '1d'];
    const selectedTF = validTFs.includes(timeframe) ? timeframe : '1h';

    if (cacheStore[selectedTF] && Date.now() - cacheStore[selectedTF].lastUpdate < CACHE_TTL) {
      return res.json(cacheStore[selectedTF].data);
    }

    const candles = await fetchGoldCandles(selectedTF);
    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2] || currentPrice;
    const changePercent = (((currentPrice - prevPrice) / prevPrice) * 100).toFixed(2);

    const stoch = calculateStochastic(candles);
    const smc = analyzeSMC(candles);

    // เงื่อนไขการ์ดใบที่ 1: แสดงเฉพาะ "โซนซื้อ", "โซนขาย", "ขาขึ้น", หรือ "ขาลง"
    let card1DisplayStatus = '';
    let card1Color = 'neutral';

    if (stoch.k >= 15 && stoch.k <= 22) {
      card1DisplayStatus = 'โซนซื้อ';
      card1Color = 'positive';
    } else if (stoch.k >= 80 && stoch.k <= 100) {
      card1DisplayStatus = 'โซนขาย';
      card1Color = 'negative';
    } else {
      // หากไม่อยู่ในโซน ให้แสดงตามเทรนด์แท่งเทียนปัจจุบัน
      card1DisplayStatus = smc.trend;
      card1Color = smc.trend === 'ขาขึ้น' ? 'positive' : 'negative';
    }

    const responseData = {
      timeframe: selectedTF.toUpperCase(),
      price: currentPrice.toFixed(2),
      change: (changePercent >= 0 ? `+${changePercent}%` : `${changePercent}%`),
      card1Status: card1DisplayStatus,
      card1Color: card1Color,
      stochasticRaw: stoch,
      smc: smc,
      updatedAt: new Date().toLocaleTimeString('th-TH')
    };

    cacheStore[selectedTF] = { data: responseData, lastUpdate: Date.now() };
    res.json(responseData);
  } catch (err) {
    res.status(500).json({ error: 'Server Error' });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));