import { createServer, request } from 'node:http'
import { lstatSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export const publicHost = 'plow.tryapparent.com'
const app = '/app'
const dashboard = '/app/d/plow-run-breakdown/run-breakdown'
const live = '/app/api/live/ws'
const upstreamHeaders = [
  'accept', 'accept-encoding', 'accept-language', 'content-length', 'content-type',
  'if-modified-since', 'if-none-match', 'origin', 'range', 'user-agent',
]
const hopHeaders = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade',
]

export function accessIdentity(keys, issuer, audience, viewer) {
  return async token => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'], issuer, audience, requiredClaims: ['exp', 'sub', 'email'],
      })
      if (payload.type === 'app' && typeof payload.sub === 'string' && payload.sub &&
          payload.email === viewer) return payload.exp
    } catch {}
    return false
  }
}

function responseHeaders(response, origin) {
  const headers = { ...response.headers }
  for (const name of [...hopHeaders, ...String(headers.connection || '').toLowerCase().split(/,\s*/),
    'set-cookie', 'x-grafana-user', 'x-grafana-org-id']) delete headers[name]
  headers['cache-control'] = 'private, no-store'
  if (headers.location) {
    const target = new URL(headers.location, 'https://' + publicHost)
    if (target.origin !== 'https://' + publicHost || !target.pathname.startsWith(app + '/')) {
      throw Error('Unexpected Grafana redirect')
    }
    headers.location = origin + target.pathname + target.search + target.hash
  }
  return headers
}

export function gateway({ origin, viewer, socketPath, authenticate, privateRoute = false }) {
  const authority = new URL(origin).host
  async function route(incoming, respond, openSocket) {
    const { headers, method, url } = incoming
    const host = privateRoute ? headers['x-forwarded-host'] : headers.host
    if (host !== authority || (headers.origin && headers.origin !== origin)) return respond(403)

    const expiry = await authenticate(headers)
    if (!expiry) return respond(401)
    if (incoming.destroyed) return

    const separator = url.indexOf('?')
    const path = separator === -1 ? url : url.slice(0, separator)
    if (!path.startsWith('/') || path.includes('//') || /[\\#]|%(?![0-9a-f]{2})|%(?:2f|5c|2e|25|00)/i.test(path) ||
        path.split('/').some(part => part === '..' || part === '.')) return respond(400)
    const suffix = separator === -1 ? '' : url.slice(separator)
    const inApp = path === app || path.startsWith(app + '/')
    if (privateRoute && !inApp && ['GET', 'HEAD'].includes(method) && !openSocket) {
      return respond(308, { location: origin + (path === '/' ? app + '/' : app + path) + suffix })
    }
    let decoded
    try { decoded = decodeURIComponent(path) } catch { return respond(400) }
    if (!inApp || /^\/app\/(?:mcp|login\/google)(?:\/|$)/i.test(decoded)) return respond(404)
    if (openSocket && (path !== live || method !== 'GET' || headers.upgrade?.toLowerCase() !== 'websocket')) return respond(400)
    if (path === app) return respond(308, { location: origin + app + '/' + suffix })
    if (path === app + '/' && ['GET', 'HEAD'].includes(method)) {
      return respond(302, { location: origin + dashboard + suffix })
    }

    const outgoing = Object.fromEntries(upstreamHeaders.filter(name => headers[name] !== undefined)
      .map(name => [name, headers[name]]))
    Object.assign(outgoing, { host: authority, 'x-forwarded-host': authority, 'x-forwarded-proto': 'https',
      'x-plow-viewer': viewer })
    if (openSocket) {
      outgoing.connection = 'Upgrade'
      outgoing.upgrade = 'websocket'
      for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
        if (headers[name]) outgoing[name] = headers[name]
      }
    }
    const upstream = request({ socketPath, method, path: url, headers: outgoing }, result => {
      try {
        respond(result.statusCode, responseHeaders(result, origin), result)
      } catch {
        result.destroy()
        respond(502)
      }
    })
    upstream.once('error', () => respond(502))
    upstream.setTimeout(30_000, () => upstream.destroy())
    if (openSocket) {
      upstream.once('upgrade', (result, socket, buffered) => openSocket(result, socket, buffered, expiry))
      incoming.socket.once('close', () => upstream.destroy())
      upstream.end()
    } else {
      incoming.once('close', () => { if (!incoming.complete) upstream.destroy() })
      incoming.pipe(upstream)
    }
  }
  const server = createServer((incoming, outgoing) => {
    const respond = (status, headers, body) => {
      if (outgoing.headersSent || outgoing.destroyed) return body?.destroy()
      outgoing.writeHead(status, { ...headers, 'cache-control': 'private, no-store' })
      if (body) {
        body.once('error', () => outgoing.destroy())
        outgoing.once('close', () => body.destroy())
        body.pipe(outgoing)
      } else outgoing.end()
    }
    route(incoming, respond).catch(() => respond(502))
  })
  server.on('upgrade', (incoming, client, head) => {
    client.on('error', () => client.destroy())
    const reject = (_status, _headers, body) => {
      body?.destroy()
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
    route(incoming, reject, (result, socket, buffered, expiry) => {
      const close = () => { socket.destroy(); client.destroy() }
      socket.on('error', close)
      socket.once('close', close)
      client.once('close', close)
      if (client.destroyed) return close()
      const handshake = result.rawHeaders.flatMap((name, index, raw) =>
        index % 2 === 0 && /^(connection|upgrade|sec-websocket-[a-z-]+)$/i.test(name) ?
          [name + ': ' + raw[index + 1]] : [])
      client.write(['HTTP/1.1 101 Switching Protocols', ...handshake, '', ''].join('\r\n'))
      if (buffered.length) client.write(buffered)
      if (head.length) socket.write(head)
      client.pipe(socket).pipe(client)
      if (Number.isFinite(expiry)) {
        const timeout = setTimeout(close, Math.min(2 ** 31 - 1, Math.max(0, expiry * 1000 - Date.now())))
        client.once('close', () => clearTimeout(timeout))
      }
    }).catch(() => reject())
  })
  return server
}

function start() {
  const {
    PLOW_ACCESS_TEAM: team, PLOW_ACCESS_AUDIENCE: audience, PLOW_ACCESS_EMAIL: email,
    PLOW_TAILNET_VIEWER: viewer, PLOW_TAILNET_ORIGIN: tailnet,
    PLOW_ACCESS_PORT = '15583', PLOW_LGTM_WORKDIR: directory,
  } = process.env
  const validEmail = value => /^[^\s@,]+@[^\s@,]+$/.test(value ?? '')
  if (!/^[a-z0-9-]+$/.test(team ?? '') || !/^[a-f0-9]{64}$/.test(audience ?? '') ||
      !validEmail(email) || !validEmail(viewer) || !/^https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?$/.test(tailnet ?? '') ||
      !/^\d+$/.test(PLOW_ACCESS_PORT) || +PLOW_ACCESS_PORT < 1024 || +PLOW_ACCESS_PORT > 65535 ||
      !directory?.startsWith('/')) throw Error('Invalid gateway environment')
  const issuer = 'https://' + team + '.cloudflareaccess.com'
  const keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer))
  const verify = accessIdentity(keys, issuer, audience, email)
  const privateSocket = join(directory, 'access-tailnet.sock')
  const owner = lstatSync(dirname(privateSocket))
  if (!owner.isDirectory() || owner.uid !== process.getuid() || (owner.mode & 0o077)) {
    throw Error('Gateway requires an owner-only runtime directory')
  }
  const socketPath = join(directory, 'access-grafana/grafana.sock')
  const publicGateway = gateway({
    origin: 'https://' + publicHost, viewer, socketPath,
    authenticate: headers => verify(headers['cf-access-jwt-assertion']),
  })
  const privateGateway = gateway({
    origin: tailnet, viewer, socketPath, privateRoute: true,
    authenticate: headers => headers['tailscale-user-login'] === viewer && Infinity,
  })
  for (const server of [publicGateway, privateGateway]) {
    server.on('error', () => { console.error('Gateway listener failed'); process.exit(1) })
  }
  publicGateway.listen(+PLOW_ACCESS_PORT, '127.0.0.1', () => {
    try {
      const stale = lstatSync(privateSocket)
      if (!stale.isSocket() || stale.uid !== owner.uid) throw Error('Unexpected Tailnet socket')
      unlinkSync(privateSocket)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Gateway socket preparation failed')
        process.exit(1)
      }
    }
    privateGateway.listen(privateSocket)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { start() } catch { console.error('Gateway startup failed'); process.exitCode = 1 }
}
