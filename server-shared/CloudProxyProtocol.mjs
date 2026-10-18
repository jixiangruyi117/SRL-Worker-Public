/* global URL */

export const CLOUD_PROXY_ERRORS = Object.freeze({
  invalidTarget: Object.freeze({
    code: 'INVALID_TARGET',
    message: '云端目标地址未获允许',
  }),
  invalidContentLength: Object.freeze({
    code: 'CLOUD_CONTENT_LENGTH_INVALID',
    message: '云端请求大小格式无效',
  }),
})

function hasOnlySearchParams(target, expected) {
  const entries = [...target.searchParams.entries()]
  return (
    entries.length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([name, value]) =>
        target.searchParams.getAll(name).length === 1 && target.searchParams.get(name) === value,
    )
  )
}

function hasValidPage(target, perPage) {
  const page = target.searchParams.get('page')
  return (
    target.searchParams.get('per_page') === perPage &&
    page !== null &&
    /^[1-9]\d*$/u.test(page) &&
    Number(page) <= 1_000 &&
    hasOnlySearchParams(target, { per_page: perPage, page })
  )
}

export function resolveCloudTarget(provider, rawUrl, method = 'GET') {
  let target
  try {
    target = new URL(String(rawUrl ?? ''))
  } catch {
    return null
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.port ||
    target.hash
  )
    return null
  if (
    provider === 'koofr' &&
    target.hostname === 'app.koofr.net' &&
    (target.pathname === '/dav/Koofr' || target.pathname.startsWith('/dav/Koofr/'))
  ) {
    return target
  }
  if (
    provider === 'github' &&
    target.hostname === 'uploads.github.com' &&
    method.toUpperCase() === 'POST' &&
    /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/\d+\/assets$/u.test(target.pathname) &&
    target.searchParams.getAll('name').length === 1 &&
    Boolean(target.searchParams.get('name')) &&
    target.searchParams.get('name').length <= 255 &&
    target.searchParams.getAll('label').length <= 1 &&
    (target.searchParams.get('label')?.length ?? 0) <= 255 &&
    [...target.searchParams.keys()].every((name) => name === 'name' || name === 'label')
  ) {
    return target
  }
  if (provider === 'github' && target.hostname === 'api.github.com') {
    const repo = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?<path>\/.*)?$/u.exec(target.pathname)
    if (!repo) return null
    const path = repo.groups?.path ?? ''
    const verb = method.toUpperCase()
    const allowed =
      (path === '' && verb === 'GET' && target.search === '') ||
      (path === '/commits' && verb === 'GET' && hasOnlySearchParams(target, { per_page: '1' })) ||
      (path === '/contents/.srl-backup-container' && verb === 'PUT' && target.search === '') ||
      (path === '/releases' &&
        ((verb === 'GET' && hasValidPage(target, '10')) ||
          (verb === 'POST' && target.search === ''))) ||
      (/^\/releases\/tags\/[A-Za-z0-9_.-]+$/u.test(path) &&
        verb === 'GET' &&
        target.search === '') ||
      (/^\/releases\/\d+\/assets$/u.test(path) && verb === 'GET' && hasValidPage(target, '100')) ||
      (/^\/releases\/assets\/\d+$/u.test(path) &&
        (verb === 'GET' || verb === 'DELETE') &&
        target.search === '')
    if (allowed) return target
  }
  return null
}
