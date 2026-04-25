// shang-whitelist Worker
// 兩個端點：
//   POST /check — 檢查 email 是否在白名單，回 { ok: true/false }
//   POST /apply — 收申請單，透過 EmailJS 寄通知信給賞哥
//
// 環境變數（在 Cloudflare Dashboard → Settings → Variables and Secrets 設）：
//   WHITELIST            逗號分隔的 Gmail 清單，例如 "bingshang1019@gmail.com,partner@gmail.com"
//   EMAILJS_SERVICE_ID   EmailJS 服務 ID（service_xxx）
//   EMAILJS_TEMPLATE_ID  EmailJS 模板 ID（template_xxx）
//   EMAILJS_PUBLIC_KEY   EmailJS Public Key

interface Env {
	WHITELIST: string;
	EMAILJS_SERVICE_ID: string;
	EMAILJS_TEMPLATE_ID: string;
	EMAILJS_PUBLIC_KEY: string;
}

const ALLOWED_ORIGINS = new Set([
	'https://bingshang-house.github.io',
	'http://localhost:8787',
	'http://localhost:3000',
	'http://127.0.0.1:5500',
]);

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';

function corsHeaders(origin: string | null): HeadersInit {
	const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://bingshang-house.github.io';
	return {
		'Access-Control-Allow-Origin': allowOrigin,
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		'Vary': 'Origin',
	};
}

function jsonResponse(body: unknown, status: number, cors: HeadersInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			...cors,
			'Content-Type': 'application/json; charset=utf-8',
		},
	});
}

function normalizeEmail(s: unknown): string {
	return String(s || '').trim().toLowerCase();
}

function isValidEmail(s: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function parseWhitelist(raw: string): Set<string> {
	const set = new Set<string>();
	for (const part of (raw || '').split(',')) {
		const e = normalizeEmail(part);
		if (e) set.add(e);
	}
	return set;
}

async function handleCheck(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
	let body: any;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400, cors);
	}

	const email = normalizeEmail(body?.email);
	if (!isValidEmail(email)) {
		return jsonResponse({ ok: false, error: 'Invalid email' }, 400, cors);
	}

	const whitelist = parseWhitelist(env.WHITELIST);
	return jsonResponse({ ok: whitelist.has(email) }, 200, cors);
}

async function handleApply(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
	let body: any;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400, cors);
	}

	const name = String(body?.name || '').trim().slice(0, 50);
	const email = normalizeEmail(body?.email);
	const purpose = String(body?.purpose || '').trim().slice(0, 200);

	if (!name) return jsonResponse({ ok: false, error: '姓名必填' }, 400, cors);
	if (!isValidEmail(email)) return jsonResponse({ ok: false, error: 'Gmail 格式錯誤' }, 400, cors);
	if (!purpose) return jsonResponse({ ok: false, error: '申請用途必填' }, 400, cors);

	const applyTime = new Date().toLocaleString('zh-TW', {
		timeZone: 'Asia/Taipei',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});

	const emailjsRes = await fetch(EMAILJS_ENDPOINT, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Origin': 'https://bingshang-house.github.io',
		},
		body: JSON.stringify({
			service_id: env.EMAILJS_SERVICE_ID,
			template_id: env.EMAILJS_TEMPLATE_ID,
			user_id: env.EMAILJS_PUBLIC_KEY,
			template_params: {
				from_name: name,
				from_email: email,
				purpose,
				apply_time: applyTime,
			},
		}),
	});

	if (!emailjsRes.ok) {
		const text = await emailjsRes.text();
		return jsonResponse(
			{ ok: false, error: `EmailJS ${emailjsRes.status}: ${text.slice(0, 200)}` },
			502,
			cors,
		);
	}

	return jsonResponse({ ok: true }, 200, cors);
}

export default {
	async fetch(request, env): Promise<Response> {
		const origin = request.headers.get('Origin');
		const cors = corsHeaders(origin);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: cors });
		}

		if (origin && !ALLOWED_ORIGINS.has(origin)) {
			return jsonResponse({ ok: false, error: 'Origin not allowed' }, 403, cors);
		}

		if (request.method !== 'POST') {
			return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, cors);
		}

		const url = new URL(request.url);
		switch (url.pathname) {
			case '/check':
				return handleCheck(request, env, cors);
			case '/apply':
				return handleApply(request, env, cors);
			default:
				return jsonResponse({ ok: false, error: 'Endpoint not found' }, 404, cors);
		}
	},
} satisfies ExportedHandler<Env>;
