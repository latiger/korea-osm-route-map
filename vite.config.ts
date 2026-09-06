import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { defineConfig, loadEnv } from 'vite'

/**
 * Dev proxy for 행정안전부 도로명주소 (Juso) Open API.
 *
 * - /api/juso/search → https://business.juso.go.kr/addrlink/addrLinkApi.do
 * - /api/juso/coord  → https://business.juso.go.kr/addrlink/addrCoordApi.do
 *
 * Injects confmKey from server env only (never exposed to the browser bundle).
 * Prefer JUSO_CONFM_KEY; VITE_JUSO_CONFM_KEY accepted as legacy fallback.
 * Without a key, responds 503 so the client can fall back to Nominatim.
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
        // Proxy map (key injected server-side):
        //   /api/juso/search → addrLinkApi.do
        //   /api/juso/coord  → addrCoordApi.do
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
  // Empty prefix loads non-VITE_ vars (JUSO_CONFM_KEY stays server-only)
  const env = loadEnv(mode, process.cwd(), '')
  const confmKey =
    env.JUSO_CONFM_KEY?.trim() || env.VITE_JUSO_CONFM_KEY?.trim() || ''

  return {
    plugins: [react(), jusoProxyPlugin(confmKey)],
  }
})
