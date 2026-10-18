import { describe, expect, it } from 'vitest'

import { CLOUD_PROXY_ERRORS, resolveCloudTarget } from './CloudProxyProtocol.mjs'

describe('shared cloud proxy protocol', () => {
  it('limits GitHub requests to repository backup metadata and release assets', () => {
    expect(resolveCloudTarget('github', 'https://api.github.com/repos/owner/repo')).toBeTruthy()
    expect(
      resolveCloudTarget(
        'github',
        'https://api.github.com/repos/owner/repo/releases?page=1&per_page=10',
      ),
    ).toBeTruthy()
    expect(
      resolveCloudTarget(
        'github',
        'https://api.github.com/repos/owner/repo/releases/1/assets?page=1&per_page=100',
      ),
    ).toBeTruthy()
    expect(
      resolveCloudTarget(
        'github',
        'https://uploads.github.com/repos/owner/repo/releases/1/assets?name=chunk.bin',
        'POST',
      ),
    ).toBeTruthy()
    expect(resolveCloudTarget('github', 'https://api.github.com/repos/owner')).toBeNull()
    expect(resolveCloudTarget('koofr', 'https://app.koofr.net/dav/Koofr/SRL')).toBeTruthy()
    expect(resolveCloudTarget('koofr', 'https://app.koofr.net/dav/Koofr-evil')).toBeNull()
    expect(resolveCloudTarget('github', 'http://api.github.com/repos/owner/repo')).toBeNull()
    expect(
      resolveCloudTarget('github', 'https://api.github.com/repos/owner/repo/releases', 'DELETE'),
    ).toBeNull()
    expect(
      resolveCloudTarget(
        'github',
        'https://api.github.com/repos/owner/repo/releases?page=1&per_page=10&extra=yes',
      ),
    ).toBeNull()
    expect(
      resolveCloudTarget('github', 'https://uploads.github.com/repos/owner/repo/releases/1/assets'),
    ).toBeNull()
  })

  it('keeps the cross-runtime invalid-target response stable', () => {
    expect(CLOUD_PROXY_ERRORS.invalidTarget).toEqual({
      code: 'INVALID_TARGET',
      message: '云端目标地址未获允许',
    })
  })
})
