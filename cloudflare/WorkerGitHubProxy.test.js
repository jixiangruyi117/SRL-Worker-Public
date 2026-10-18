import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './Worker.js'

describe('Public 自部署 GitHub 云备份中继', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('只转发受限的 GitHub 请求、用户请求头与原始附件，并返回 CORS 标记', async () => {
    const upstream = vi.fn(async () => new Response('uploaded', { status: 201 }))
    vi.stubGlobal('fetch', upstream)
    const token = 'Bearer user-owned-github-token'
    const response = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/github?url=' +
          encodeURIComponent(
            'https://uploads.github.com/repos/example/library/releases/42/assets?name=chunk.bin',
          ),
        {
          method: 'POST',
          headers: {
            origin: 'https://library.example',
            authorization: token,
            'content-type': 'application/octet-stream',
            'x-srl-content-length': '3',
          },
          body: new Uint8Array([1, 2, 3]),
        },
      ),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://library.example')
    expect(response.headers.get('access-control-expose-headers')).toContain('x-srl-cloud-proxy')
    expect(response.headers.get('x-srl-cloud-proxy')).toBe('1')
    expect(upstream).toHaveBeenCalledOnce()
    const [target, init] = upstream.mock.calls[0]
    expect(String(target)).toContain('uploads.github.com/repos/example/library/releases/42/assets')
    expect(init.redirect).toBe('manual')
    expect(init.headers.get('authorization')).toBe(token)
    expect(init.headers.get('user-agent')).toBe('SillyTavern-Resource-Library-Public')
    expect([...new Uint8Array(init.body)]).toEqual([1, 2, 3])
  })

  it('拒绝任意主机、未允许的方法和超限请求体', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    const arbitrary = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/github?url=' +
          encodeURIComponent('https://example.org/collect'),
        { headers: { origin: 'https://library.example' } },
      ),
    )
    const unsupported = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/github?url=' +
          encodeURIComponent('https://api.github.com/repos/example/library'),
        { method: 'PATCH', headers: { origin: 'https://library.example' } },
      ),
    )
    const tooLarge = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/github?url=' +
          encodeURIComponent(
            'https://uploads.github.com/repos/example/library/releases/42/assets?name=chunk.bin',
          ),
        {
          method: 'POST',
          headers: {
            origin: 'https://library.example',
            'x-srl-content-length': String(64 * 1024 * 1024 + 1),
          },
          body: 'x',
        },
      ),
    )

    expect(arbitrary.status).toBe(400)
    expect(unsupported.status).toBe(405)
    expect(tooLarge.status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('跟随私有 Release 附件的签名下载地址时不转发仓库 Token', async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/signed/asset',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('backup bytes', { status: 200 }))
    vi.stubGlobal('fetch', upstream)
    const response = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/github?url=' +
          encodeURIComponent('https://api.github.com/repos/example/library/releases/assets/9'),
        {
          headers: {
            origin: 'https://library.example',
            authorization: 'Bearer user-owned-token',
          },
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('x-srl-cloud-upstream')).toBe('github-asset')
    expect(response.headers.get('access-control-expose-headers')).toContain('x-srl-cloud-upstream')
    await expect(response.text()).resolves.toBe('backup bytes')
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(String(upstream.mock.calls[1]?.[0])).toBe(
      'https://release-assets.githubusercontent.com/signed/asset',
    )
    expect(upstream.mock.calls[1]?.[1]?.headers?.get?.('authorization')).toBeUndefined()
  })

  it.each([
    undefined,
    'https://example.org/collect?secret=signed-value',
    'https://user:password@release-assets.githubusercontent.com/asset',
    'http://release-assets.githubusercontent.com/asset',
  ])('拒绝不受支持的附件跳转，且不向客户端泄露签名地址：%s', async (location) => {
    const upstream = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: location ? { location } : {},
        }),
    )
    vi.stubGlobal('fetch', upstream)
    const response = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/github?url=' +
          encodeURIComponent('https://api.github.com/repos/example/library/releases/assets/9'),
        { headers: { origin: 'https://library.example' } },
      ),
    )

    expect(response.status).toBe(502)
    expect(response.headers.get('x-srl-cloud-proxy')).toBe('1')
    expect(response.headers.get('access-control-allow-origin')).toBe('https://library.example')
    expect(response.headers.has('location')).toBe(false)
    expect(await response.json()).toMatchObject({
      code: 'CLOUD_ASSET_REDIRECT_INVALID',
    })
    expect(upstream).toHaveBeenCalledOnce()
  })

  it('附件服务器连接失败返回502，不把302交回禁止跳转的客户端', async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/signed/asset',
          },
        }),
      )
      .mockRejectedValueOnce(new TypeError('connection failed'))
    vi.stubGlobal('fetch', upstream)
    const response = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/github?url=' +
          encodeURIComponent('https://api.github.com/repos/example/library/releases/assets/9'),
        { headers: { origin: 'https://library.example' } },
      ),
    )

    expect(response.status).toBe(502)
    expect(response.headers.get('x-srl-cloud-proxy')).toBe('1')
    expect(response.headers.has('location')).toBe(false)
    expect(await response.json()).toMatchObject({
      code: 'CLOUD_ASSET_UNREACHABLE',
    })
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('保留附件服务器404的真实上游阶段，便于客户端区分API错误', async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/signed/asset',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', upstream)
    const response = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/github?url=' +
          encodeURIComponent('https://api.github.com/repos/example/library/releases/assets/9'),
      ),
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('x-srl-cloud-upstream')).toBe('github-asset')
    await expect(response.text()).resolves.toBe('missing')
  })

  it('响应 CORS 预检且拒绝不支持的来源协议', async () => {
    const valid = await worker.fetch(
      new Request('https://worker.example/api/cloud/proxy/github', {
        method: 'OPTIONS',
        headers: { origin: 'https://library.example' },
      }),
    )
    const invalid = await worker.fetch(
      new Request('https://worker.example/api/cloud/proxy/github', {
        method: 'OPTIONS',
        headers: { origin: 'file://local' },
      }),
    )

    expect(valid.status).toBe(204)
    expect(valid.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(invalid.status).toBe(403)
  })
})
