require('dotenv').config();
const express = require('express');
const path = require('path');
const Parser = require('rss-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Current Anthropic API model string (see product docs if this ever needs updating).
const ANTHROPIC_MODEL = 'claude-sonnet-5';

// Official public RSS feed for the "ทองคำ" (gold) tag on ryt9.com.
// Using the RSS feed instead of scraping the HTML page: it's the format
// the site itself publishes for syndication, so it's stable and lightweight.
const RSS_URL = 'https://www.ryt9.com/tag/%E0%B8%97%E0%B8%AD%E0%B8%87%E0%B8%84%E0%B8%B3/rss.xml';

const parser = new Parser();
app.use(express.static(path.join(__dirname, 'public')));

// Very small in-memory cache so we don't re-fetch the feed / re-call the
// LLM on every page load. Resets when the server restarts.
let cache = { data: null, ts: 0 };
const CACHE_MS = 15 * 60 * 1000; // 15 minutes

async function getHeadlines(limit = 10) {
	const feed = await parser.parseURL(RSS_URL);
	return feed.items.slice(0, limit).map((item) => ({
		title: item.title || '',
		snippet: (item.contentSnippet || item.content || '').replace(/\s+/g, ' ').trim().slice(0, 220),
		link: item.link,
		pubDate: item.pubDate,
	}));
}

async function analyzeSentiment(headlines) {
	if (!ANTHROPIC_API_KEY) {
		throw new Error('Missing ANTHROPIC_API_KEY environment variable');
	}

	const list = headlines
		.map((h, i) => `${i + 1}. ${h.title} — ${h.snippet}`)
		.join('\n');

	const prompt = `ต่อไปนี้คือหัวข้อข่าวและสรุปย่อเกี่ยวกับราคาทองคำ (ภาษาไทย)
วิเคราะห์ข่าวแต่ละข้อว่ามีผลต่อทิศทางราคาทองคำเชิงบวก (positive) เชิงลบ (negative) หรือเป็นกลาง/ไม่ชัดเจน (neutral)
พร้อมเหตุผลสั้นๆ ไม่เกิน 1 ประโยค ให้สรุปด้วยคำพูดของตัวเอง ห้ามคัดลอกข้อความจากข่าวตรงๆ

ตอบกลับเป็น JSON array เท่านั้น ห้ามมีคำอธิบายอื่นนอกเหนือจาก JSON โครงสร้างนี้:
[{"index": 1, "sentiment": "positive", "reason": "..."}]

ข่าว:
${list}`;

	const resp = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: ANTHROPIC_MODEL,
			max_tokens: 1200,
			messages: [{ role: 'user', content: prompt }],
		}),
	});

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
	}

	const data = await resp.json();
	const textBlock = (data.content || []).find((b) => b.type === 'text');
	let raw = (textBlock && textBlock.text) || '[]';
	raw = raw.trim().replace(/^```json/i, '').replace(/```$/, '').trim();

	try {
		return JSON.parse(raw);
	} catch (e) {
		console.error('Could not parse model output as JSON:', raw);
		return [];
	}
}

app.get('/api/news-sentiment', async (req, res) => {
	try {
		if (cache.data && Date.now() - cache.ts < CACHE_MS) {
			return res.json(cache.data);
		}

		const headlines = await getHeadlines(10);
		if (headlines.length === 0) {
			return res.json([]);
		}

		const analysis = await analyzeSentiment(headlines);
		const merged = headlines.map((h, i) => {
			const a = analysis.find((x) => x.index === i + 1) || {};
			return {
				title: h.title,
				link: h.link,
				pubDate: h.pubDate,
				sentiment: a.sentiment || 'neutral',
				reason: a.reason || '',
			};
		});

		cache = { data: merged, ts: Date.now() };
		res.json(merged);
	} catch (err) {
		console.error('news-sentiment error:', err.message);
		res.status(500).json({ error: err.message });
	}
});

app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
