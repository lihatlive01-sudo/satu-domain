// ============================================================
// _worker.js TERPADU — Web Streaming + Generator (SATU DOMAIN) [FIX 2026-10-18: fallback data/videos.json diperkuat + file sensitif dilindungi]
// ============================================================
// Rute yang dilayani worker ini:
//   /api/videos      -> daftar video untuk web.
//                       Prioritas: env.GIST_MASTER_URL (secret/env var)
//                       -> file statis data/videos.json -> []
//   /api/resolve-x   -> resolver video X/Twitter (milik generator)
//   /api/stream      -> proxy stream video (milik generator, proteksi domain)
//   /generator/*     -> generator, diproteksi secret Cloudflare (env.GENERATOR_KEY)
//   lainnya          -> file statis (env.ASSETS)
//
// CATATAN DEPLOY:
// - Secret dipasang via:  wrangler secret put GENERATOR_KEY
//   (atau dashboard: Workers & Pages -> project -> Settings -> Variables -> Add secret)
// - Buka generator SEKALI via: https://domainmu/generator/?key=ISI_SECRET_MU
//   -> worker memasang cookie 30 hari, selanjutnya buka /generator/ biasa.
// - Jika GENERATOR_KEY belum dipasang, proteksi worker nonaktif
//   (generator tetap terkunci password client-side bila GEN_PASSWORD diisi
//   di generator/config.js).
// ============================================================

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range, Content-Type',
};

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json;charset=UTF-8' }, CORS),
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const lp = url.pathname.toLowerCase();

    // Preflight CORS untuk semua /api/*
    if (request.method === 'OPTIONS' && lp.startsWith('/api/')) {
      return new Response(null, { headers: CORS });
    }

    // ---------- 1. API: daftar video untuk web ----------
    if (lp === '/api/videos') {
      // a) dari GIST_MASTER_URL (env var / secret)
      const gistUrl = (env && env.GIST_MASTER_URL) || '';
      if (gistUrl) {
        try {
          const r = await fetch(gistUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (r.ok) {
            const txt = await r.text();
            return new Response(txt, {
              headers: Object.assign(
                { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'public, max-age=300' },
                CORS
              ),
            });
          }
        } catch (e) { /* lanjut ke fallback */ }
      }
      // b) dari file statis data/videos.json (SPAREPART - dipakai saat Gist gagal dibaca)
      if (env && env.ASSETS) {
        try {
          const assetUrl = new URL('/data/videos.json', url.origin).toString();
          const r = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET', headers: { accept: 'application/json' } }));
          if (r && r.ok) {
            const txt = await r.text();
            if (txt && txt.trim().length > 2) {
              return new Response(txt, {
                headers: Object.assign(
                  { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'public, max-age=300' },
                  CORS
                ),
              });
            }
          }
        } catch (e) { /* lanjut ke [] */ }
      }
      return new Response('[]', {
        headers: Object.assign({ 'content-type': 'application/json;charset=UTF-8' }, CORS),
      });
    }

    // ---------- 2. API: TWITTER / X VIDEO RESOLVER (milik generator) ----------
    if (lp === '/api/resolve-x') {
      const tweetUrl = url.searchParams.get('url') || url.searchParams.get('status') || '';
      const match = tweetUrl.match(/status\/(\d+)/i);
      const tweetId = match ? match[1] : (/^\d+$/.test(tweetUrl) ? tweetUrl : null);

      if (!tweetId) {
        return jsonResp({ error: 'ID Tweet tidak ditemukan' }, 400);
      }

      try {
        const resp = await fetch('https://api.fxtwitter.com/i/status/' + tweetId, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const data = await resp.json();
        if (data && data.tweet) {
          const videos = (data.tweet.media && data.tweet.media.videos) || [];
          const videoUrl =
            videos.length > 0
              ? videos[0].url || (videos[0].variants && videos[0].variants[0] && videos[0].variants[0].url)
              : null;
          return jsonResp({
            success: true,
            title: data.tweet.text
              ? data.tweet.text.replace(/https:\/\/t\.co\/\w+/g, '').trim().slice(0, 100)
              : 'Video X',
            videoUrl: videoUrl,
            thumbnail:
              (videos[0] && videos[0].thumbnail_url) || null,
          });
        }
        return jsonResp({ error: 'Tweet tidak memiliki video' }, 404);
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // ---------- 3. API: VIDEO STREAM PROXY (milik generator, proteksi domain) ----------
    if (lp === '/api/stream') {
      const referer = request.headers.get('Referer') || '';
      const origin = request.headers.get('Origin') || '';
      const requestHost = url.hostname;

      const allowedDomains = [requestHost];
      if (env && env.ALLOWED_DOMAINS) {
        allowedDomains.push(
          ...env.ALLOWED_DOMAINS.split(',').map(function (d) { return d.trim(); })
        );
      }

      const isAllowed = allowedDomains.some(function (domain) {
        return referer.includes(domain) || origin.includes(domain);
      });

      if ((referer || origin) && !isAllowed) {
        return new Response('Forbidden: Domain not allowed', {
          status: 403,
          headers: { 'content-type': 'text/plain' },
        });
      }

      const targetUrl = url.searchParams.get('url');
      if (!targetUrl || !targetUrl.startsWith('http')) {
        return new Response('URL video tidak valid', { status: 400 });
      }

      const reqHeaders = new Headers();
      reqHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
      if (request.headers.has('range')) {
        reqHeaders.set('Range', request.headers.get('range'));
      }

      try {
        const streamResp = await fetch(targetUrl, { headers: reqHeaders });
        const respHeaders = new Headers(streamResp.headers);
        respHeaders.set('Access-Control-Allow-Origin', referer ? new URL(referer).origin : '*');
        respHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        respHeaders.set('Access-Control-Allow-Headers', 'Range');
        respHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
        respHeaders.delete('Content-Security-Policy');
        respHeaders.delete('X-Frame-Options');

        return new Response(streamResp.body, {
          status: streamResp.status,
          statusText: streamResp.statusText,
          headers: respHeaders,
        });
      } catch (err) {
        return new Response('Stream error: ' + err.message, { status: 502 });
      }
    }

    // ---------- 4. PROTEKSI GENERATOR (secret Cloudflare) ----------
    if (lp === '/generator' || lp.startsWith('/generator/')) {
      // Normalisasi /generator -> /generator/ agar assets resolve benar
      if (lp === '/generator') {
        return new Response(null, { status: 302, headers: { Location: '/generator/' } });
      }
      const KEY = (env && env.GENERATOR_KEY) || '';
      if (KEY) {
        const qkey = url.searchParams.get('key') || '';
        const cookie = request.headers.get('Cookie') || '';
        const authed = cookie.split(';').some(function (c) {
          return c.trim() === 'gen_auth=' + KEY;
        });
        if (!authed && qkey === KEY) {
          // Kunci cocok -> pasang cookie 30 hari, redirect ke URL bersih
          return new Response(null, {
            status: 302,
            headers: {
              Location: '/generator/',
              'Set-Cookie':
                'gen_auth=' + KEY + '; Path=/generator; Max-Age=2592000; HttpOnly; SameSite=Lax',
            },
          });
        }
        if (!authed) {
          return new Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8">' +
              '<meta name="viewport" content="width=device-width,initial-scale=1">' +
              '<title>403 - Terkunci</title></head>' +
              '<body style="background:#0a0a1a;color:#f1f5f9;font-family:sans-serif;' +
              'display:flex;align-items:center;justify-content:center;min-height:100vh;' +
              'text-align:center;margin:0"><div><div style="font-size:48px">🔒</div>' +
              '<h1>403 - Area Terkunci</h1>' +
              '<p>Halaman generator dilindungi.<br>Buka lewat URL kunci rahasia milikmu.</p>' +
              '</div></body></html>',
            { status: 403, headers: { 'content-type': 'text/html;charset=UTF-8' } }
          );
        }
      }
      // Lolos (atau secret belum dipasang) -> lanjut ke file statis di bawah.
    }

    // ---------- 4b. LINDUNGI FILE SENSITIF (jangan sajikan sebagai aset statis) ----------
    if (lp === '/_worker.js' || lp === '/wrangler.jsonc' || lp === '/wrangler.toml' || lp === '/.assetsignore') {
      return new Response('Not found', { status: 404 });
    }

    // ---------- 5. FILE STATIS ----------
    if (env && env.ASSETS) {
      try {
        const cleanUrl = new URL(url.pathname, url.origin);
        const res = await env.ASSETS.fetch(new Request(cleanUrl.toString(), request));
        if (res) {
          // Player dimuat web dalam iframe -> izinkan frame-ancestors
          if (lp.endsWith('.html') || lp === '/') {
            const h = new Headers(res.headers);
            h.delete('x-frame-options');
            h.set('content-security-policy', 'frame-ancestors *');
            return new Response(res.body, {
              status: res.status,
              statusText: res.statusText,
              headers: h,
            });
          }
          return res;
        }
      } catch (e) { /* abaikan, lanjut 404 */ }
    }
    return new Response('Not found', { status: 404 });
  },
};
