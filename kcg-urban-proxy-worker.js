export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing url', { status: 400 });

    let proxyUrl;
    let host;
    try {
      host = new URL(target).hostname;
      if (host === 'urbanproxy.kcg.gov.tw') {
        proxyUrl = 'https://urbangis.kcg.gov.tw/UBA/ProxyPage/proxy.jsp?' + target;
      } else if (host === 'mapgis2.kcg.gov.tw') {
        proxyUrl = 'https://urbangis.kcg.gov.tw/UBA/ProxyPage/proxyPortal.jsp?' + target;
      } else if (host === 'buildmis.kcg.gov.tw') {
        proxyUrl = target;
      } else {
        return new Response('Forbidden', { status: 403 });
      }
    } catch (e) {
      return new Response('Invalid URL', { status: 400 });
    }

    const init = {
      method: request.method,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': host === 'buildmis.kcg.gov.tw'
          ? 'https://buildmis.kcg.gov.tw/bupic/pages/querylic'
          : 'https://urbangis.kcg.gov.tw/UBA/web_page/UBA010100.jsp',
      }
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
      headers: {
        'Content-Type': respCT,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }
};
