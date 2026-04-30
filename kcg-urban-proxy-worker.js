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

  let _moiToken = null;
  let _moiTokenExpiry = 0;

  async function getMoiAccessToken(env) {
    const now = Date.now();
    if (_moiToken && now < _moiTokenExpiry) return _moiToken;
    if (!env.MOI_CLIENT_ID || !env.MOI_SECRET_CODE) {
      throw new Error('MOI credentials not configured');
    }
    const cred = btoa(env.MOI_CLIENT_ID + ':' + env.MOI_SECRET_CODE);
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
      try {
        const r = await fetch('https://copapi.moi.gov.tw/cp/gettoken', {
          method: 'GET',
          headers: { 'Authorization': 'Basic ' + cred }
        });
        if (r.ok) {
          const data = await r.json();
          if (data.access_token) {
            _moiToken = data.access_token;
            _moiTokenExpiry = now + ((data.expires_in || 300) - 30) * 1000;
            return _moiToken;
          }
          lastErr = 'no access_token';
        } else {
          const txt = await r.text();
          lastErr = 'status=' + r.status + ': ' + txt.slice(0, 100);
        }
      } catch (e) {
        lastErr = e.message;
      }
    }
    throw new Error('gettoken failed after retries: ' + lastErr);
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
          'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + env.GEMINI_KEY;
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

      if (url.pathname === '/moi-wfs' && request.method === 'GET') {
        const ld = url.searchParams.get('ld');
        const sec = url.searchParams.get('sec');
        const no = url.searchParams.get('no');
        if (!ld || !sec || !no) {
          return new Response(JSON.stringify({ error: 'Missing ld/sec/no' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
          });
        }
        try {
          const token = await getMoiAccessToken(env);
          const typeName = ld + sec + no;
          const params = new URLSearchParams({
            service: 'WFS',
            version: '1.1.1',
            request: 'GetFeature',
            typeName: typeName,
            srs: 'EPSG:3826',
            LD: ld,
            SCNO: sec,
            PO: no,
          });
          const wfsUrl = 'https://copapi.moi.gov.tw/cp/gis/landWFS?' + params.toString();
          let lastErr = '';
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
            const r = await fetch(wfsUrl, {
              headers: { 'Authorization': 'Bearer ' + token }
            });
            if (r.status >= 500) {
              lastErr = 'wfs status=' + r.status;
              continue;
            }
            const text = await r.text();
            return new Response(text, {
              status: r.status,
              headers: {
                'Content-Type': r.headers.get('Content-Type') || 'application/xml',
                ...corsHeaders(origin)
              }
            });
          }
          return new Response(JSON.stringify({ error: lastErr || 'wfs failed' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
          });
        }
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
      const respCT = resp.headers.get('Content-Type') || 'application/json';
      const isBinary = /^(image|application\/octet-stream)/.test(respCT);
      const body = isBinary ? await resp.arrayBuffer() : await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: { 'Content-Type': respCT, ...corsHeaders(origin) }
      });
    }
  };
