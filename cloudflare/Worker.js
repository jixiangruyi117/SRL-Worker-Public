import { BridgeSession } from './BridgeSession.js'
import { handleBridge, withBridgeCors } from './WorkerBridge.js'
import { handleGitHubProxy, withGitHubCors } from './WorkerGitHubProxy.js'
import { handleKoofrProxy, withKoofrCors } from './WorkerKoofrProxy.js'
import { json } from './WorkerHttp.js'

export { BridgeSession }

export default {
  async fetch(request, env) {
    let pathname = ''
    try {
      pathname = new URL(request.url).pathname
      if (pathname.startsWith('/api/bridge/')) return await handleBridge(request, env, pathname)
      if (pathname === '/api/cloud/proxy/github') return await handleGitHubProxy(request, pathname)
      if (pathname.startsWith('/api/cloud/')) return await handleKoofrProxy(request, pathname)
      return json({ code: 'NOT_FOUND', message: '接口不存在' }, 404)
    } catch {
      const response = json({ code: 'WORKER_ERROR', message: 'Worker 暂时无法处理此请求' }, 500)
      if (pathname.startsWith('/api/bridge/')) return withBridgeCors(response, request)
      if (pathname === '/api/cloud/proxy/github') return withGitHubCors(response, request)
      if (pathname.startsWith('/api/cloud/')) return withKoofrCors(response, request)
      return response
    }
  },
}
