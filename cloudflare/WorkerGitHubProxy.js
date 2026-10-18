import { CLOUD_PROXY_ERRORS, resolveCloudTarget } from '../server-shared/CloudProxyProtocol.mjs'
import { json } from './WorkerHttp.js'

const MAX_BODY_BYTES = 64 * 1024 * 1024
const REQUEST_HEADERS = ['accept', 'authorization', 'content-type', 'x-github-api-version']
const RESPONSE_HEADERS = [
  'accept-ranges',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'location',
  'retry-after',
  'x-accepted-github-permissions',
  'x-github-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-ratelimit-used',
]
const ALLOWED_HEADERS =
  'accept, authorization, content-type, x-github-api-version, x-srl-content-length'
const EXPOSED_HEADERS = [...RESPONSE_HEADERS, 'x-srl-cloud-proxy', 'x-srl-cloud-upstream'].join(
  ', ',
)

function originIsAllowed(origin) {
  if (!origin) return true
  if (origin === 'tauri://localhost') return true
  try {
    return ['http:', 'https:', 'capacitor:', 'ionic:'].includes(new URL(origin).protocol)
  } catch {
    return false
  }
}

export function withGitHubCors(response, request) {
  const origin = request.headers.get('origin')
  if (!origin || !originIsAllowed(origin)) return response
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
  headers.set('access-control-allow-headers', ALLOWED_HEADERS)
  headers.set('access-control-expose-headers', EXPOSED_HEADERS)
  headers.set('access-control-max-age', '86400')
  headers.append('vary', 'Origin')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function proxyResponse(body, status = 200) {
  return json(body, status, { 'x-srl-cloud-proxy': '1' })
}

function requestHeaders(source) {
  const headers = new Headers()
  for (const name of REQUEST_HEADERS) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('user-agent', 'SillyTavern-Resource-Library-Public')
  return headers
}

function responseHeaders(source) {
  const headers = new Headers()
  for (const name of RESPONSE_HEADERS) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('x-srl-cloud-proxy', '1')
  return headers
}

export async function handleGitHubProxy(request, pathname) {
  if (request.method === 'OPTIONS') {
    if (!originIsAllowed(request.headers.get('origin')))
      return withGitHubCors(proxyResponse({ code: 'ORIGIN_REJECTED' }, 403), request)
    return withGitHubCors(new Response(null, { status: 204 }), request)
  }
  if (pathname !== '/api/cloud/proxy/github')
    return withGitHubCors(
      proxyResponse({ code: 'NOT_FOUND', message: 'GitHub 代理接口不存在' }, 404),
      request,
    )
  if (!originIsAllowed(request.headers.get('origin')))
    return withGitHubCors(proxyResponse({ code: 'ORIGIN_REJECTED' }, 403), request)
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method))
    return withGitHubCors(
      proxyResponse({ code: 'METHOD_NOT_ALLOWED', message: 'GitHub 代理方法不受支持' }, 405),
      request,
    )

  const target = resolveCloudTarget(
    'github',
    new URL(request.url).searchParams.get('url'),
    request.method,
  )
  if (!target) return withGitHubCors(proxyResponse(CLOUD_PROXY_ERRORS.invalidTarget, 400), request)

  const hasBody = !['GET', 'HEAD'].includes(request.method)
  const declaredLengthHeader =
    request.headers.get('x-srl-content-length') ?? request.headers.get('content-length')
  const declaredLength = declaredLengthHeader === null ? undefined : Number(declaredLengthHeader)
  if (
    declaredLength !== undefined &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES)
  )
    return withGitHubCors(
      proxyResponse(
        {
          code: 'CLOUD_REQUEST_TOO_LARGE',
          message: '单次云端请求不能超过 64 MiB，请使用自动分卷上传',
        },
        declaredLength > MAX_BODY_BYTES ? 413 : 400,
      ),
      request,
    )

  let body
  if (hasBody) {
    body = await request.arrayBuffer()
    if (body.byteLength > MAX_BODY_BYTES)
      return withGitHubCors(
        proxyResponse(
          {
            code: 'CLOUD_REQUEST_TOO_LARGE',
            message: '单次云端请求不能超过 64 MiB，请使用自动分卷上传',
          },
          413,
        ),
        request,
      )
    if (declaredLength !== undefined && body.byteLength !== declaredLength)
      return withGitHubCors(
        proxyResponse(
          {
            code: 'CLOUD_CONTENT_LENGTH_MISMATCH',
            message: '云端上传内容长度不一致，请重试当前分卷',
          },
          400,
        ),
        request,
      )
  }

  let upstream
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: requestHeaders(request.headers),
      body,
      redirect: 'manual',
      signal: request.signal,
    })
  } catch {
    return withGitHubCors(
      proxyResponse(
        {
          code: 'CLOUD_UPSTREAM_UNREACHABLE',
          message: 'GitHub 上游暂时无法连接，请稍后重试',
        },
        502,
      ),
      request,
    )
  }

  let upstreamStage = 'github-api'
  if (
    request.method === 'GET' &&
    target.hostname === 'api.github.com' &&
    /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/assets\/\d+$/u.test(target.pathname) &&
    [301, 302, 303, 307, 308].includes(upstream.status)
  ) {
    const location = upstream.headers.get('location')
    let download
    try {
      if (location) download = new URL(location, target)
    } catch {
      // Do not expose signed URLs in error responses.
    }
    await upstream.body?.cancel()
    if (
      !download ||
      download.protocol !== 'https:' ||
      download.hostname !== 'release-assets.githubusercontent.com' ||
      download.username ||
      download.password ||
      download.port ||
      download.hash
    ) {
      return withGitHubCors(
        proxyResponse(
          {
            code: 'CLOUD_ASSET_REDIRECT_INVALID',
            message: 'GitHub 附件下载跳转地址无效或不受支持，自部署中继未继续下载。',
          },
          502,
        ),
        request,
      )
    }
    try {
      upstream = await fetch(download, {
        method: 'GET',
        redirect: 'follow',
        signal: request.signal,
      })
      upstreamStage = 'github-asset'
    } catch {
      return withGitHubCors(
        proxyResponse(
          {
            code: 'CLOUD_ASSET_UNREACHABLE',
            message:
              '自部署中继已取得 GitHub 附件下载地址，但连接附件下载服务器失败；这不代表浏览器断网或备份文件已删除。',
          },
          502,
        ),
        request,
      )
    }
  }

  const headers = responseHeaders(upstream.headers)
  headers.set('x-srl-cloud-upstream', upstreamStage)
  return withGitHubCors(
    new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    }),
    request,
  )
}
