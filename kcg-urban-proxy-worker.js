const ALLOWED_ORIGINS = new Set([
  'https://bingshang-house.github.io',
  'null',
]);

function isOriginOk(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (origin.startsWith('http://localhost')) return true;
  if (origin.startsWith('http://127.0.0.1')) return true;
  return false;
}

function corsHeaders(origin) {
  const allowOrigin = isOriginOk(origin) ? origin : 'https://bingshang-house.github.io';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (!isOriginOk(origin)) {
      return new Response(JSON.stringify({ error: 'Forbidden origin: ' + origin }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === '/gemini' && request.method === 'POST') {
      if (!env.GEMINI_KEY) {
        return new Response(JSON.stringify({ error: 'GEMINI_KEY not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }
      const model = url.searchParams.get('model') || 'gemini-2.5-flash';
      const geminiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`;
      const body = await request.text();
      const res = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }

    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing url', { status: 400 });
    let proxyUrl, host;
    try {
      host = new URL(target).hostname;
      if (host === 'urbanproxy.kcg.gov.tw') {
        proxyUrl = 'https://urbangis.kcg.gov.tw/UBA/ProxyPage/proxy.jsp?' + target;
      } else if (host === 'mapgis2.kcg.gov.tw') {
        proxyUrl = 'https://urbangis.kcg.gov.tw/UBA/ProxyPage/proxyPortal.jsp?' + target;
      } else if (host === 'buildmis.kcg.gov.tw') {
        proxyUrl = target;
      } else if (host === 'api.nlsc.gov.tw') {
        proxyUrl = target;
      } else if (host === 'landmaps.nlsc.gov.tw') {
        proxyUrl = target;
      } else if (host === 'gisdawh.kcg.gov.tw') {
        proxyUrl = target;
      } else if (host === 'swc.kcg.gov.tw') {
        proxyUrl = target;
      } else {
        return new Response('Forbidden', { status: 403, headers: corsHeaders(origin) });
      }
    } catch (e) {
      return new Response('Invalid URL', { status: 400, headers: corsHeaders(origin) });
    }

    let referer;
    if (host === 'buildmis.kcg.gov.tw') referer = 'https://buildmis.kcg.gov.tw/bupic/pages/querylic';
    else if (host === 'api.nlsc.gov.tw' || host === 'landmaps.nlsc.gov.tw') referer = 'https://maps.nlsc.gov.tw/T09/mapshow.action';
    else if (host === 'gisdawh.kcg.gov.tw') referer = 'https://gisdawh.kcg.gov.tw/landeasy/page6.cfm?major=14';
    else if (host === 'swc.kcg.gov.tw') referer = 'https://swc.kcg.gov.tw/Public/map.html';
    else referer = 'https://urbangis.kcg.gov.tw/UBA/web_page/UBA010100.jsp';

    const init = {
      method: request.method,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer }
    };
    if (request.method === 'POST') {
      init.body = await request.text();
      const ct = request.headers.get('Content-Type');
      if (ct) init.headers['Content-Type'] = ct;
    }
    const resp = await fetch(proxyUrl, init);
    const body = await resp.text();
    const respCT = resp.headers.get('Content-Type') || 'application/json';
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': respCT, ...corsHeaders(origin) }
    });
  }
};
