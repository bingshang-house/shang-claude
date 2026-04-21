// Gemini API proxy for shang.house tools.
// GitHub Pages is public, so the Gemini key can't be in the frontend.
// Worker holds GEMINI_KEY as a secret and forwards generateContent calls.

interface Env {
	GEMINI_KEY: string;
}

const ALLOWED_ORIGINS = new Set([
	'https://bingshang-house.github.io',
	'http://localhost:8787',
	'http://localhost:3000',
	'http://127.0.0.1:5500',
]);

const UPSTREAM_BASE = 'https://generativelanguage.googleapis.com';
const ALLOWED_PATH = /^\/v1beta\/models\/[a-zA-Z0-9._\-]+:(generateContent|streamGenerateContent|countTokens)$/;

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

export default {
	async fetch(request, env): Promise<Response> {
		const origin = request.headers.get('Origin');
		const cors = corsHeaders(origin);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: cors });
		}

		if (origin && !ALLOWED_ORIGINS.has(origin)) {
			return new Response('Origin not allowed', { status: 403, headers: cors });
		}

		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405, headers: cors });
		}

		const url = new URL(request.url);
		if (!ALLOWED_PATH.test(url.pathname)) {
			return new Response('Endpoint not allowed', { status: 404, headers: cors });
		}

		if (!env.GEMINI_KEY) {
			return new Response('Worker missing GEMINI_KEY secret', { status: 500, headers: cors });
		}

		const upstreamUrl = UPSTREAM_BASE + url.pathname + url.search;
		const upstreamRes = await fetch(upstreamUrl, {
			method: 'POST',
			headers: {
				'Content-Type': request.headers.get('Content-Type') || 'application/json',
				'x-goog-api-key': env.GEMINI_KEY,
			},
			body: request.body,
		});

		const respHeaders = new Headers(cors);
		const ct = upstreamRes.headers.get('Content-Type');
		if (ct) respHeaders.set('Content-Type', ct);

		return new Response(upstreamRes.body, {
			status: upstreamRes.status,
			statusText: upstreamRes.statusText,
			headers: respHeaders,
		});
	},
} satisfies ExportedHandler<Env>;
