require('dotenv').config();
const express = require('express');
const path = require('path');
const Parser = require('rss-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const rssParser = new Parser();

app.use(express.static(path.join(__dirname, 'public')));

let cache = { priceData: null, lastUpdate: 0 };
const CACHE_TTL = 3 * 60 * 1000;

function calculateRSI(prices, period = 14) {
	if (prices.length < period + 1) return 50;
	let gains = 0, losses = 0;
	for (let i = 1; i <= period; i++) {
		const diff = prices[i] - prices[i - 1];
		if (diff >= 0) gains += diff;
		else losses -= diff;
	}
	let avgGain = gains / period;
	let avgLoss = losses / period;
	for (let i = period + 1; i < prices.length; i++) {
		const diff = prices[i] - prices[i - 1];
		if (diff >= 0) {
			avgGain = (avgGain * (period - 1) + diff) / period;
			avgLoss = (avgLoss * (period - 1)) / period;
		} else {
			avgGain = (avgGain * (period - 1)) / period;
			avgLoss = (avgLoss * (period - 1) - diff) / period;
		}
	}
	if (avgLoss === 0) return 100;
	return parseFloat((100 - (100 / (1 + avgGain / avgLoss))).toFixed(2));
}

function analyzeSMC(candles) {
	if (!candles || candles.length < 20) return { structure: 'N/A', bos: false, choch: false, orderBlock: 'None', zone: 'Equilibrium', bias: 'Neutral' };
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
	let bos = false, choch = false, structure = 'Sideway';
	if (currentPrice > recentHigh) { bos = true; structure = 'Bullish (ขาขึ้น)'; }
	else if (currentPrice < recentLow) { bos = true; structure = 'Bearish (ขาลง)'; }
	if (currentPrice > prevHigh && closes[closes.length - 5] < recentLow) { choch = true; structure = 'Bullish Reversal (เปลี่ยนเทรนด์เป็นขึ้น)'; }
	else if (currentPrice < prevLow && closes[closes.length - 5] > recentHigh) { choch = true; structure = 'Bearish Reversal (เปลี่ยนเทรนด์เป็นลง)'; }
	let orderBlock = 'ไม่มีจุด OB ชัดเจน';
	if (structure.includes('Bullish')) orderBlock = `Bullish OB (~${recentLow.toFixed(2)})`;
	else if (structure.includes('Bearish')) orderBlock = `Bearish OB (~${recentHigh.toFixed(2)})`;
	return { structure, bos, choch, orderBlock, zone, swingHigh: highestHigh.toFixed(2), swingLow: lowestLow.toFixed(2) };
}

async function fetchGoldCandles() {
	try {
		const resp = await axios.get('https://stooq.com/q/d/l/?s=xauusd&i=d', { timeout: 5000 });
		const candles = resp.data.trim().split('\n').slice(1).map(line => {
			const parts = line.split(',');
			return { open: parseFloat(parts[1]), high: parseFloat(parts[2]), low: parseFloat(parts[3]), close: parseFloat(parts[4]) };
		}).filter(c => !isNaN(c.close));
		return candles.length ? candles : generateDemoCandles();
	} catch (err) {
		console.warn('Fallback to Demo Candles due to Stooq network limit:', err.message);
		return generateDemoCandles();
	}
}

function generateDemoCandles() {
	const candles = [];
	for (let i = 0; i < 50; i++) {
		const close = 4427.96 + (Math.random() - 0.48) * 15 + i * 0.8;
		candles.push({ open: close - 2, high: close + 5, low: close - 5, close });
	}
	return candles;
}

async function fetchNews() {
	try {
		const feed = await rssParser.parseURL('https://www.ryt9.com/tag/%E0%B8%97%E0%B8%AD%E0%B8%87%E0%B8%84%E0%B8%B3/rss.xml');
		const bullish = ['พุ่ง', 'ขึ้น', 'บวก', 'หนุน', 'สูงสุด', 'เด้ง', 'ซื้อ', 'อ่อนค่า'];
		const bearish = ['ร่วง', 'ลง', 'ลบ', 'ดิ่ง', 'กดดัน', 'ปรับฐาน', 'แข็งค่า', 'ขาย'];
		return feed.items.slice(0, 8).map(item => {
			const title = item.title || '';
			const bullMatches = bullish.filter(k => title.includes(k));
			const bearMatches = bearish.filter(k => title.includes(k));
			const sentiment = bullMatches.length > bearMatches.length ? 'positive' : bearMatches.length > bullMatches.length ? 'negative' : 'neutral';
			return { title, link: item.link, pubDate: item.pubDate, sentiment, reason: sentiment === 'positive' ? `มีปัจจัยบวกต่อทองคำ (${bullMatches.join(', ')})` : sentiment === 'negative' ? `มีปัจจัยกดดันราคาทองคำ (${bearMatches.join(', ')})` : 'ข่าวยังไม่ส่งผลต่อทิศทางราคาชัดเจน' };
		});
	} catch (err) {
		return [{ title: 'ราคาทองคำเคลื่อนไหวในกรอบผันผวน ตลาดยังคงจับตาตัวเลขเศรษฐกิจสหรัฐฯ', sentiment: 'neutral', reason: 'รอปัจจัยใหม่', link: '#' }, { title: 'แรงซื้อสินทรัพย์ปลอดภัยช่วยหนุนทองคำรีบาวด์', sentiment: 'positive', reason: 'มีปัจจัยบวกต่อทองคำ', link: '#' }];
	}
}

app.get('/api/dashboard-data', async (req, res) => {
	try {
		if (cache.priceData && Date.now() - cache.lastUpdate < CACHE_TTL) return res.json(cache.priceData);
		const candles = await fetchGoldCandles();
		const closes = candles.map(c => c.close);
		const currentPrice = closes[closes.length - 1];
		const prevPrice = closes[closes.length - 2] || currentPrice;
		const changePercent = (((currentPrice - prevPrice) / prevPrice) * 100).toFixed(2);
		const rsi = calculateRSI(closes);
		const smc = analyzeSMC(candles);
		const news = await fetchNews();
		let action = 'รอดูสถานการณ์ (Wait for Signal)', detail = 'เงื่อนไข RSI และ SMC ยังไม่สอดคล้องกัน ให้รอการยืนยันรูปแบบราคา', badge = 'neutral';
		if (rsi >= 27 && rsi <= 30) { action = smc.zone.includes('Discount') ? 'โซนรอซื้อ (Wait to BUY)' : 'เฝ้ารอซื้อ (Watch BUY)'; detail = `RSI อยู่ในโซนซื้อ (${rsi})`; badge = 'positive'; }
		else if (rsi >= 65 && rsi <= 75) { action = smc.zone.includes('Premium') ? 'โซนรอขาย (Wait to SELL)' : 'เฝ้ารอขาย (Watch SELL)'; detail = `RSI อยู่ในโซนขาย (${rsi})`; badge = 'negative'; }
		else if (rsi < 27) { action = 'Oversold แรง (ชะลอการขาย/รอสัญญาณกลับตัว)'; detail = 'RSI ต่ำกว่า 27 ตลาดขายมากเกินไป'; }
		else if (rsi > 75) { action = 'Overbought แรง (ชะลอการซื้อ/รอสัญญาณย่อตัว)'; detail = 'RSI สูงกว่า 75 ตลาดซื้อมากเกินไป'; }
		const responseData = { price: currentPrice.toFixed(2), change: changePercent >= 0 ? `+${changePercent}%` : `${changePercent}%`, rsi: { value: rsi, status: rsi <= 30 ? 'โซนเฝ้ารอซื้อ (27-30)' : rsi >= 65 ? 'โซนเฝ้ารอขาย (65-75)' : 'โซนปกติ (31-64)' }, smc, signal: { action, detail, badge }, news, updatedAt: new Date().toLocaleTimeString('th-TH') };
		cache = { priceData: responseData, lastUpdate: Date.now() };
		res.json(responseData);
	} catch (err) { console.error('Server execution error:', err); res.status(500).json({ error: 'Internal Server Error' }); }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
