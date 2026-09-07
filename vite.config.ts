import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { defineConfig, loadEnv } from 'vite'

/**
 * Dev proxy for Kakao Local + Navi APIs.
 *
 * - /api/kakao/address → https://dapi.kakao.com/v2/local/search/address.json
 * - /api/kakao/keyword → https://dapi.kakao.com/v2/local/search/keyword.json
 * - /api/kakao/coord2address → https://dapi.kakao.com/v2/local/geo/coord2address.json
 * - /api/kakao/category → https://dapi.kakao.com/v2/local/search/category.json
 * - /api/kakao/navi/directions → https://apis-navi.kakaomobility.com/v1/directions
 *
 * Injects Authorization: KakaoAK … from server env only (never in browser bundle).
 * Prefer KAKAO_REST_API_KEY; VITE_KAKAO_REST_API_KEY accepted as legacy migration.
 * Without a key, responds 503 so the client can fall back (Nominatim / OSRM).
 */
function kakaoProxyPlugin(restApiKey: string): Plugin {
  async function proxyKakao(
    baseOrigin: string,
    upstreamPath: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!restApiKey) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          error: 'KAKAO_REST_API_KEY not configured',
          message:
            '카카오 REST API 키가 없습니다. .env에 KAKAO_REST_API_KEY를 설정한 뒤 개발 서버를 재시작하세요.',
        }),
      )
      return
    }

    const incoming = new URL(req.url ?? '/', 'http://localhost')
    const target = new URL(upstreamPath, baseOrigin)
    incoming.searchParams.forEach((v, k) => {
      target.searchParams.set(k, v)
    })

    try {
      const upstream = await fetch(target.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `KakaoAK ${restApiKey}`,
        },
      })
      const body = await upstream.text()
      res.statusCode = upstream.status
      res.setHeader(
        'Content-Type',
        upstream.headers.get('content-type') ??
          'application/json; charset=utf-8',
      )
      res.end(body)
    } catch (e) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          error: 'kakao_upstream_failed',
          message: (e as Error).message,
        }),
      )
    }
  }

  return {
    name: 'kakao-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (url.startsWith('/api/kakao/navi/directions')) {
          void proxyKakao(
            'https://apis-navi.kakaomobility.com',
            '/v1/directions',
            req,
            res,
          )
          return
        }
        if (url.startsWith('/api/kakao/address')) {
          void proxyKakao(
            'https://dapi.kakao.com',
            '/v2/local/search/address.json',
            req,
            res,
          )
          return
        }
        if (url.startsWith('/api/kakao/keyword')) {
          void proxyKakao(
            'https://dapi.kakao.com',
            '/v2/local/search/keyword.json',
            req,
            res,
          )
          return
        }
        if (url.startsWith('/api/kakao/coord2address')) {
          void proxyKakao(
            'https://dapi.kakao.com',
            '/v2/local/geo/coord2address.json',
            req,
            res,
          )
          return
        }
        if (url.startsWith('/api/kakao/category')) {
          void proxyKakao(
            'https://dapi.kakao.com',
            '/v2/local/search/category.json',
            req,
            res,
          )
          return
        }
        next()
      })
    },
  }
}

/**
 * Optional legacy Juso proxy (unused by primary geocode path).
 * Kept so existing Juso client code still works if called directly.
 */
function jusoProxyPlugin(confmKey: string): Plugin {
  async function proxyJuso(
    upstreamPath: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!confmKey) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          error: 'JUSO_CONFM_KEY not configured',
          message:
            '행정안전부 도로명주소 API 키가 없습니다. .env에 JUSO_CONFM_KEY를 설정한 뒤 개발 서버를 재시작하세요.',
        }),
      )
      return
    }

    const incoming = new URL(req.url ?? '/', 'http://localhost')
    const target = new URL(upstreamPath, 'https://business.juso.go.kr')
    incoming.searchParams.forEach((v, k) => {
      if (k === 'confmKey') return
      target.searchParams.set(k, v)
    })
    target.searchParams.set('confmKey', confmKey)
    if (!target.searchParams.has('resultType')) {
      target.searchParams.set('resultType', 'json')
    }

    try {
      const upstream = await fetch(target.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      const body = await upstream.text()
      res.statusCode = upstream.status
      res.setHeader(
        'Content-Type',
        upstream.headers.get('content-type') ??
          'application/json; charset=utf-8',
      )
      res.end(body)
    } catch (e) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          error: 'juso_upstream_failed',
          message: (e as Error).message,
        }),
      )
    }
  }

  return {
    name: 'juso-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (url.startsWith('/api/juso/search')) {
          void proxyJuso('/addrlink/addrLinkApi.do', req, res)
          return
        }
        if (url.startsWith('/api/juso/coord')) {
          void proxyJuso('/addrlink/addrCoordApi.do', req, res)
          return
        }
        next()
      })
    },
  }
}


/**
 * Dev proxy for Korea Expressway (data.ex.co.kr) OpenAPI.
 * Injects key from EX_API_KEY (server-only). Demo key `test` works for some
 * endpoints (e.g. realtime traffic / route name discovery) but a personal key
 * is required for production and many datasets.
 *
 * - /api/ex/routes → derives unique routeNo/routeName from odtraffic realtime
 * - /api/ex/proxy?path=... → generic passthrough to https://data.ex.co.kr/openapi/...
 */
function exProxyPlugin(apiKey: string): Plugin {
  const key = apiKey.trim() || 'test'

  async function fetchEx(pathAndQuery: string): Promise<Response> {
    const url = new URL(pathAndQuery, 'https://data.ex.co.kr')
    if (!url.searchParams.has('key')) url.searchParams.set('key', key)
    if (!url.searchParams.has('type')) url.searchParams.set('type', 'json')
    return fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'korea-osm-route-map/1.0 (dev proxy)',
      },
    })
  }

  return {
    name: 'ex-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (url.startsWith('/api/ex/routes')) {
          void (async () => {
            try {
              const upstream = await fetchEx(
                '/openapi/odtraffic/trafficAmountByRealtime',
              )
              const body = await upstream.text()
              if (!upstream.ok) {
                res.statusCode = upstream.status
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(
                  JSON.stringify({
                    error: 'ex_upstream_failed',
                    status: upstream.status,
                    body: body.slice(0, 500),
                    hint: 'Set EX_API_KEY in .env (data.ex.co.kr에서 발급). Demo key test may work for some APIs.',
                  }),
                )
                return
              }
              const data = JSON.parse(body) as {
                list?: Array<{ routeNo?: string; routeName?: string }>
              }
              const map = new Map<string, string>()
              for (const row of data.list ?? []) {
                const no = String(row.routeNo ?? '').trim()
                const name = String(row.routeName ?? '').trim()
                if (no && name) map.set(no, name)
              }
              const routes = [...map.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([routeNo, name]) => {
                  const routeNoNorm = String(Number(routeNo))
                  return {
                    routeNo,
                    routeNoNorm,
                    name,
                    aliases: [
                      name,
                      `${name}고속도로`,
                      `${routeNoNorm}번고속도로`,
                      `고속도로${routeNoNorm}`,
                      `고속도로 제${routeNoNorm}호선`,
                    ],
                  }
                })
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(
                JSON.stringify({
                  source: 'EX odtraffic/trafficAmountByRealtime',
                  keyMode: apiKey.trim() ? 'EX_API_KEY' : 'demo:test',
                  routes,
                }),
              )
            } catch (e) {
              res.statusCode = 502
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(
                JSON.stringify({
                  error: 'ex_proxy_failed',
                  message: (e as Error).message,
                }),
              )
            }
          })()
          return
        }
        if (url.startsWith('/api/ex/proxy')) {
          void (async () => {
            try {
              const incoming = new URL(req.url ?? '/', 'http://localhost')
              const path = incoming.searchParams.get('path')
              if (!path || !path.startsWith('/openapi/')) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(
                  JSON.stringify({
                    error: 'invalid_path',
                    message: 'Query path must start with /openapi/',
                  }),
                )
                return
              }
              const target = new URL(path, 'https://data.ex.co.kr')
              incoming.searchParams.forEach((v, k) => {
                if (k === 'path' || k === 'key') return
                target.searchParams.set(k, v)
              })
              target.searchParams.set('key', key)
              if (!target.searchParams.has('type')) {
                target.searchParams.set('type', 'json')
              }
              const upstream = await fetch(target.toString(), {
                headers: {
                  Accept: 'application/json',
                  'User-Agent': 'korea-osm-route-map/1.0 (dev proxy)',
                },
              })
              const body = await upstream.text()
              res.statusCode = upstream.status
              res.setHeader(
                'Content-Type',
                upstream.headers.get('content-type') ??
                  'application/json; charset=utf-8',
              )
              res.end(body)
            } catch (e) {
              res.statusCode = 502
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(
                JSON.stringify({
                  error: 'ex_proxy_failed',
                  message: (e as Error).message,
                }),
              )
            }
          })()
          return
        }
        next()
      })
    },
  }
}


/**
 * Dev proxy for Naver Cloud Platform Maps APIs.
 *
 * - /api/naver/direction → map-direction/v1/driving (Directions 5, ≤5 vias)
 * - /api/naver/direction15 → map-direction-15/v1/driving (Directions 15, ≤15 vias)
 * - /api/naver/geocode → map-geocode/v2/geocode
 * - /api/naver/reversegeocode → map-reversegeocode/v2/gc
 * - /api/naver/map-client-id → public Client ID only (for Dynamic Map JS)
 *
 * Injects X-NCP-APIGW-API-KEY-ID / X-NCP-APIGW-API-KEY from server env only.
 * Without keys, responds 503 so the client can fall back.
 */
function naverProxyPlugin(clientId: string, clientSecret: string): Plugin {
  type UpstreamPair = { primary: string; fallback: string }

  const DIRECTION5: UpstreamPair = {
    primary: 'https://maps.apigw.ntruss.com/map-direction/v1/driving',
    fallback: 'https://naveropenapi.apigw.ntruss.com/map-direction/v1/driving',
  }
  const DIRECTION15: UpstreamPair = {
    primary: 'https://maps.apigw.ntruss.com/map-direction-15/v1/driving',
    fallback: 'https://naveropenapi.apigw.ntruss.com/map-direction-15/v1/driving',
  }
  const GEOCODE: UpstreamPair = {
    primary: 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode',
    fallback: 'https://naveropenapi.apigw.ntruss.com/map-geocode/v2/geocode',
  }
  const REVERSE: UpstreamPair = {
    primary: 'https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc',
    fallback: 'https://naveropenapi.apigw.ntruss.com/map-reversegeocode/v2/gc',
  }

  async function proxyNaver(
    pair: UpstreamPair,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!clientId || !clientSecret) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          error: 'NAVER_MAP_KEYS_MISSING',
          message:
            '네이버 지도 API 키가 없습니다. .env에 NAVER_MAP_CLIENT_ID와 NAVER_MAP_CLIENT_SECRET을 설정한 뒤 개발 서버를 재시작하세요.',
        }),
      )
      return
    }

    const incoming = new URL(req.url ?? '/', 'http://localhost')
    const query = incoming.searchParams.toString()
    const UPSTREAMS = [pair.primary, pair.fallback]

    let lastError: unknown = null
    for (const base of UPSTREAMS) {
      const target = query ? `${base}?${query}` : base
      try {
        const upstream = await fetch(target, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-NCP-APIGW-API-KEY-ID': clientId,
            'X-NCP-APIGW-API-KEY': clientSecret,
          },
        })
        const body = await upstream.text()
        if (upstream.status >= 500 && base !== UPSTREAMS[UPSTREAMS.length - 1]) {
          lastError = new Error(`upstream ${upstream.status}`)
          continue
        }
        res.statusCode = upstream.status
        res.setHeader(
          'Content-Type',
          upstream.headers.get('content-type') ??
            'application/json; charset=utf-8',
        )
        res.end(body)
        return
      } catch (e) {
        lastError = e
        if (base === UPSTREAMS[UPSTREAMS.length - 1]) break
      }
    }

    res.statusCode = 502
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        error: 'naver_upstream_failed',
        message: (lastError as Error)?.message ?? '네이버 Maps 요청 실패',
      }),
    )
  }

  return {
    name: 'naver-proxy',
    transformIndexHtml(html) {
      // Client ID is public (Maps JS); secret stays server-only.
      if (!clientId) return html
      const tag = `<script type="text/javascript" src="https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(clientId)}"></script>`
      if (html.includes('oapi.map.naver.com/openapi/v3/maps.js')) return html
      return html.replace('</head>', `    ${tag}\n  </head>`)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (url.startsWith('/api/naver/map-client-id')) {
          res.statusCode = clientId ? 200 : 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify(
              clientId
                ? { clientId }
                : {
                    error: 'NAVER_MAP_KEYS_MISSING',
                    message: '네이버 지도 Client ID가 없습니다.',
                  },
            ),
          )
          return
        }
        if (url.startsWith('/api/naver/direction15')) {
          void proxyNaver(DIRECTION15, req, res)
          return
        }
        if (url.startsWith('/api/naver/direction')) {
          void proxyNaver(DIRECTION5, req, res)
          return
        }
        if (url.startsWith('/api/naver/geocode')) {
          void proxyNaver(GEOCODE, req, res)
          return
        }
        if (url.startsWith('/api/naver/reversegeocode')) {
          void proxyNaver(REVERSE, req, res)
          return
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Empty prefix loads non-VITE_ vars (keys stay server-only)
  const env = loadEnv(mode, process.cwd(), '')
  const kakaoKey =
    env.KAKAO_REST_API_KEY?.trim() ||
    env.VITE_KAKAO_REST_API_KEY?.trim() ||
    ''
  const confmKey =
    env.JUSO_CONFM_KEY?.trim() || env.VITE_JUSO_CONFM_KEY?.trim() || ''
  const exKey = env.EX_API_KEY?.trim() || ''
  const naverClientId = env.NAVER_MAP_CLIENT_ID?.trim() || ''
  const naverClientSecret = env.NAVER_MAP_CLIENT_SECRET?.trim() || ''

  return {
    define: {
      // Public Maps JS client id (same as NAVER_MAP_CLIENT_ID); secret stays server-only.
      __NAVER_MAP_CLIENT_ID__: JSON.stringify(naverClientId),
    },
    plugins: [
      react(),
      kakaoProxyPlugin(kakaoKey),
      naverProxyPlugin(naverClientId, naverClientSecret),
      jusoProxyPlugin(confmKey),
      exProxyPlugin(exKey),
    ],
  }
})
