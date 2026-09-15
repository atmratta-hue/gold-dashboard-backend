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
const CACHE_TTL = 2 * 60 * 1000; // Cache 2 นาที

// 1. ฟังก์ชันคำนวณ Stochastic Oscillator (%K, %D)
function calculateStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (!candles || candles.length < kPeriod + dPeriod) {
    return { k: 50, d: 50 };
  }

  const kValues = [];
  
  // คำนวณ %K ย้อนหลังเพื่อนำมาหาค่าเฉลี่ย %D
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
  
  // คำนวณ %D (SMA 3 งวดของ %K)
  const recentK = kValues.slice(-dPeriod);
  const currentD = recentK.reduce((sum, val) => sum + val, 0) / recentK.length;

  return {
    k: parseFloat(currentK.toFixed(2)),
    d: parseFloat(currentD.toFixed(2))
  };
}

// 2. ฟังก์ชันวิเคราะห์ SMC (Smart Money Concepts)
function analyzeSMC(candles) {
  if (!candles || candles.length < 20) {
    return {
      structure: 'N/A',
      bos: false,
      choch: false,
      orderBlock: 'None',
      zone: 'Equilibrium',
      bias: 'Neutral'
    };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);
  const currentPrice = closes[closes.length - 1];
  
  const eqPrice = (highestHigh + lowestLow) / 2;
  const zone = currentPrice > eqPrice ? 'Premium (โซนแพง/มองหาฝั่งขาย)' : 'Discount (โซนถูก/มองหาฝั่งซื้อ)';

  const recentHigh = Math.max(...highs.slice(-10, -1));
  const recentLow = Math.min(...lows.slice(-10, -1));
  const prevHigh = Math.max(...highs.slice(-20, -10));
  const prevLow = Math.min(...lows.slice(-20, -10));

  let bos = false;
  let choch = false;
  let structure = 'Sideway';

  if (currentPrice > recentHigh) {
    bos = true;
    structure = 'Bullish (ขาขึ้น)';
  } else if (currentPrice < recentLow) {
    bos = true;
    structure = 'Bearish (ขาลง)';
  }

  if (currentPrice > prevHigh && closes[closes.length - 5] < recentLow) {
    choch = true;
    structure = 'Bullish Reversal (เปลี่ยนเทรนด์เป็นขึ้น)';
  } else if (currentPrice < prevLow && closes[closes.length - 5] > recentHigh) {
    choch = true;
    structure = 'Bearish Reversal (เปลี่ยนเทรนด์เป็นลง)';
  }

  let orderBlock = 'ไม่มีจุด OB ชัดเจน';
  if (structure.includes('Bullish')) {
    orderBlock = `Bullish OB (~${recentLow.toFixed(2)})`;
  } else if (structure.includes('Bearish')) {
    orderBlock = `Bearish OB (~${recentHigh.toFixed(2)})`;
  }

  return {
    structure,
    bos,
    choch,
    orderBlock,
    zone,
    swingHigh: highestHigh.toFixed(2),
    swingLow: lowestLow.toFixed(2)
  };
}

// 3. ดึงและประมวลผลแท่งเทียนตาม Timeframe (1h, 4h, 1d)
async function fetchGoldCandles(timeframe = '1h') {
  try {
    const intervalMap = { '1h': 'h', '4h': 'h', '1d': 'd' };
    const interval = intervalMap[timeframe] || 'h';
    const url = `https://stooq.com/q/d/l/?s=xauusd&i=${interval}`;

    const resp = await axios.get(url, { timeout: 5000 });
    const lines = resp.data.trim().split('\n');
    let candles = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 5) {
        const open = parseFloat(parts[1]);
        const high = parseFloat(parts[2]);
        const low = parseFloat(parts[3]);
        const close = parseFloat(parts[4]);
        if (!isNaN(close)) {
          candles.push({ open, high, low, close });
        }
      }
    }

    if (timeframe === '4h' && candles.length >= 4) {
      const resampled = [];
      for (let i = 0; i < candles.length; i += 4) {
        const chunk = candles.slice(i, i + 4);
        if (chunk.length > 0) {
          resampled.push({
            open: chunk[0].open,
            high: Math.max(...chunk.map(c => c.high)),
            low: Math.min(...chunk.map(c => c.low)),
            close: chunk[chunk.length - 1].close
          });
        }
      }
      candles = resampled;
    }

    return candles.length > 0 ? candles : generateDemoCandles(timeframe);
  } catch (err) {
    console.warn(`Fallback to Demo Candles (${timeframe}):`, err.message);
    return generateDemoCandles(timeframe);
  }
}

function generateDemoCandles(timeframe = '1h') {
  const basePrice = 4427.96;
  const stepMap = { '1h': 0.8, '4h': 1.5, '1d': 3.0 };
  const step = stepMap[timeframe] || 1.0;

  const candles = [];
  for (let i = 0; i < 50; i++) {
    const change = (Math.random() - 0.48) * 15;
    const close = basePrice + change + (i * step);
    candles.push({
      open: close - 2,
      high: close + 6,
      low: close - 6,
      close: close
    });
  }
  return candles;
}

// 4. ดึงและประมวลผลข่าวสดจาก RYT9
async function fetchNews() {
  try {
    const feed = await rssParser.parseURL('https://www.ryt9.com/tag/%E0%B8%97%E0%B8%AD%E0%B8%87%E0%B8%84%E0%B8%B3/rss.xml');
    const keywordsBullish = ['พุ่ง', 'ขึ้น', 'บวก', 'หนุน', 'สูงสุด', 'เด้ง', 'ซื้อ', 'อ่อนค่า'];
    const keywordsBearish = ['ร่วง', 'ลง', 'ลบ', 'ดิ่ง', 'กดดัน', 'ปรับฐาน', 'แข็งค่า', 'ขาย'];

    return feed.items.slice(0, 8).map(item => {
      const title = item.title || '';
      let sentiment = 'neutral';
      let reason = 'ข่าวยังไม่ส่งผลต่อทิศทางราคาชัดเจน';

      const bullMatches = keywordsBullish.filter(k => title.includes(k));
      const bearMatches = keywordsBearish.filter(k => title.includes(k));

      if (bullMatches.length > bearMatches.length) {
        sentiment = 'positive';
        reason = `มีปัจจัยบวกต่อทองคำ (${bullMatches.join(', ')})`;
      } else if (bearMatches.length > bullMatches.length) {
        sentiment = 'negative';
        reason = `มีปัจจัยกดดันราคาทองคำ (${bearMatches.join(', ')})`;
      }

      return { title, link: item.link, pubDate: item.pubDate, sentiment, reason };
    });
  } catch (err) {
    return [
      { title: 'ราคาทองคำเคลื่อนไหวในกรอบผันผวน ตลาดยังคงจับตาตัวเลขเศรษฐกิจสหรัฐฯ', sentiment: 'neutral', reason: 'รอปัจจัยใหม่', link: '#' },
      { title: 'แรงซื้อสินทรัพย์ปลอดภัยช่วยหนุนทองคำรีบาวด์', sentiment: 'positive', reason: 'มีปัจจัยบวกต่อทองคำ', link: '#' }
    ];
  }
}

// API Endpoint รองรับ Stochastic (15-22 / 80-100)
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const timeframe = (req.query.tf || '1h').toLowerCase();
    const validTFs = ['1h', '4h', '1d'];
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
    const news = await fetchNews();

    // ประมวลผลสัญญาณรวมตามเกณฑ์ Stochastic (15-22 / 80-100)
    let actionSignal = 'รอดูสถานการณ์ (Wait for Signal)';
    let signalDetail = `[TF ${selectedTF.toUpperCase()}] เงื่อนไข Stochastic (%K: ${stoch.k}) และ SMC ยังไม่สอดคล้องกัน`;
    let signalBadge = 'neutral';
    let stochStatus = 'โซนปกติ (23–79)';

    if (stoch.k >= 15 && stoch.k <= 22) {
      stochStatus = 'โซนเฝ้ารอซื้อ (15–22)';
      if (smc.zone.includes('Discount')) {
        actionSignal = 'โซนรอซื้อ (Wait to BUY)';
        signalDetail = `[TF ${selectedTF.toUpperCase()}] Stochastic (%K: ${stoch.k}) เข้าโซนซื้อ (15-22) ร่วมกับ SMC อยู่ในโซน Discount`;
        signalBadge = 'positive';
      } else {
        actionSignal = 'เฝ้ารอซื้อ (Watch BUY)';
        signalDetail = `[TF ${selectedTF.toUpperCase()}] Stochastic (%K: ${stoch.k}) เข้าโซนซื้อ (15-22) แต่ SMC ยังไม่ยืนยันโซน Discount`;
        signalBadge = 'positive';
      }
    } else if (stoch.k >= 80 && stoch.k <= 100) {
      stochStatus = 'โซนเฝ้ารอขาย (80–100)';
      if (smc.zone.includes('Premium')) {
        actionSignal = 'โซนรอขาย (Wait to SELL)';
        signalDetail = `[TF ${selectedTF.toUpperCase()}] Stochastic (%K: ${stoch.k}) เข้าโซนขาย (80-100) ร่วมกับ SMC อยู่ในโซน Premium`;
        signalBadge = 'negative';
      } else {
        actionSignal = 'เฝ้ารอขาย (Watch SELL)';
        signalDetail = `[TF ${selectedTF.toUpperCase()}] Stochastic (%K: ${stoch.k}) เข้าโซนขาย (80-100) แต่ SMC ยังเป็นเทรนด์ขึ้นแรง`;
        signalBadge = 'negative';
      }
    } else if (stoch.k < 15) {
      stochStatus = 'Oversold แรง (<15)';
      actionSignal = 'ชะลอการขาย (Oversold แรง)';
      signalDetail = `[TF ${selectedTF.toUpperCase()}] Stochastic (%K: ${stoch.k}) ต่ำกว่า 15 ตลาดขายมากเกินไป ให้รอเกิดสัญญาณกลับตัว`;
      signalBadge = 'neutral';
    }

    const responseData = {
      timeframe: selectedTF.toUpperCase(),
      price: currentPrice.toFixed(2),
      change: (changePercent >= 0 ? `+${changePercent}%` : `${changePercent}%`),
      stochastic: {
        k: stoch.k,
        d: stoch.d,
        status: stochStatus
      },
      smc,
      signal: {
        action: actionSignal,
        detail: signalDetail,
        badge: signalBadge
      },
      news,
      updatedAt: new Date().toLocaleTimeString('th-TH')
    };

    cacheStore[selectedTF] = {
      data: responseData,
      lastUpdate: Date.now()
    };

    res.json(responseData);
  } catch (err) {
    console.error('Server execution error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});