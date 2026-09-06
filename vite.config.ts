import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { defineConfig, loadEnv } from 'vite'

/**
 * Dev proxy for Kakao Local API (primary geocoding).
 *
 * - /api/kakao/address → https://dapi.kakao.com/v2/local/search/address.json
 * - /api/kakao/keyword → https://dapi.kakao.com/v2/local/search/keyword.json
 *
 * Injects Authorization: KakaoAK … from server env only (never in browser bundle).
 * Prefer KAKAO_REST_API_KEY; VITE_KAKAO_REST_API_KEY accepted as legacy migration.
 * Without a key, responds 503 so the client can fall back to Nominatim.
 */
function kakaoProxyPlugin(restApiKey: string): Plugin {
  async function proxyKakao(
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
    const target = new URL(upstreamPath, 'https://dapi.kakao.com')
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
        if (url.startsWith('/api/kakao/address')) {
          void proxyKakao('/v2/local/search/address.json', req, res)
          return
        }
        if (url.startsWith('/api/kakao/keyword')) {
          void proxyKakao('/v2/local/search/keyword.json', req, res)
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

  return {
    plugins: [react(), kakaoProxyPlugin(kakaoKey), jusoProxyPlugin(confmKey)],
  }
})
