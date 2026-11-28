import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { plan, transition } from './cloudflare.mjs'
import { accessIdentity, gateway, publicHost } from './gateway.mjs'

const caller = 'viewer@example.invalid'
const accessEmail = 'access@example.invalid'
const team = 'synthetic-team'
const audience = 'a'.repeat(64)
const issuer = 'https://' + team + '.cloudflareaccess.com'
const publicOrigin = 'https://' + publicHost
const target = config => plan(config, { team, audience, port: 15583 })
const edge = { hostname: publicHost, originRequest: { access: { required: true, teamName: team, audTag: [audience] } } }
const original = {
  ingress: [
    { ...edge, path: '^/app/mcp$', service: 'http://127.0.0.1:15480' },
    { ...edge, path: '^/app/?$', service: 'http://127.0.0.1:3033' },
    { hostname: publicHost, service: 'http://127.0.0.1:3032' },
    { service: 'http_status:404' },
  ],
  'warp-routing': { enabled: false },
}
function service(config, host, path) {
  return config.ingress.find(rule => (!rule.hostname || rule.hostname === host) &&
    (!rule.path || new RegExp(rule.path).test(path))).service
}

test('Tunnel rollout retains route precedence and restores the recorded legacy state', async () => {
  let configuration = original
  let receipt
  let writes = 0
  const options = {
    current: async () => configuration,
    put: async next => { configuration = next; writes++ },
    load: async () => receipt,
    save: async next => { receipt ??= next },
    target,
    probe: async () => {},
    validate: async () => ({ '/app': 401, '/': 502 }),
  }
  for (const path of ['/app', '/app/', '/app/d/uid/title', '/app/api/ds/query', '/app/public/build/app.js']) {
    assert.equal(service(target(original), publicHost, path), 'http://127.0.0.1:15583')
  }
  for (const path of ['/', '/brand/', '/app-other', '/oauth/callback']) {
    assert.equal(service(target(original), publicHost, path), 'http://127.0.0.1:3032')
  }
  assert.equal(service(target(original), publicHost, '/app/mcp'), 'http://127.0.0.1:15480')
  assert.equal(service(target(original), 'other.example.invalid', '/app'), 'http_status:404')
  await assert.rejects(transition({ ...options, action: 'apply', probe: async () => { throw Error('down') } }), /down/)
  assert.equal(writes, 0)
  for (const action of ['apply', 'apply', 'rollback', 'rollback']) await transition({ ...options, action })
  assert.equal(writes, 2)
  assert.deepEqual(configuration, original)

  const changed = () => configuration === original ? { '/': 502 } : { '/': 503 }
  await assert.rejects(transition({ ...options, action: 'apply', validate: changed }), /restored/)
  assert.deepEqual(configuration, original)
  await assert.rejects(transition({ ...options, action: 'apply', put: async next => {
    await options.put(next)
    if (next !== original) throw Error('response lost')
  } }), /restored/)
  assert.deepEqual(configuration, original)
  configuration = { ...original, ingress: original.ingress.slice(1) }
  await assert.rejects(transition({ ...options, action: 'apply' }), /drift/)
  assert.throws(() => target(configuration), /Unexpected Tunnel/)
})

function call(options, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ ...options, path, method: body ? 'POST' : 'GET' }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.setTimeout(15_000, () => req.destroy(Error('Fixture request timed out')))
    req.once('error', reject)
    req.end(body)
  })
}

function websocket(options) {
  return new Promise((resolve, reject) => {
    const req = request({ ...options, path: '/app/api/live/ws', headers: { ...options.headers,
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'),
    } })
    req.once('response', res => { res.resume(); resolve(res.statusCode) })
    req.once('upgrade', (res, socket) => { resolve(res.statusCode); socket.destroy() })
    req.once('error', reject)
    req.setTimeout(5_000, () => req.destroy(Error('Fixture WebSocket timed out')))
    req.end()
  })
}

async function listen(t, server, socket) {
  t.after(() => { server.closeAllConnections(); server.close() })
  if (socket) server.listen(socket)
  else server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return socket ? { socketPath: socket } : { host: '127.0.0.1', port: server.address().port }
}

test('Grafana 12.3.0 candidate serves only verified Viewer requests through both ingress listeners',
  { skip: !process.env.PLOW_LGTM_WORKDIR }, async t => {
    const dir = process.env.PLOW_LGTM_WORKDIR
    const socketPath = join(dir, 'access-grafana/grafana.sock')
    const tailnet = process.env.PLOW_TAILNET_ORIGIN
    const authority = new URL(tailnet).host
    const adminPass = (await readFile(join(dir, 'grafana-password'), 'utf8')).trim()
    const admin = (path, body) => call({ socketPath, auth: 'admin:' + adminPass,
      headers: { 'content-type': 'application/json' } }, '/app/api/' + path, body && JSON.stringify(body))
    assert.equal((await admin('health')).code, 200)
    assert.equal(JSON.parse((await admin('health')).body).version, '12.3.0')
    if (!process.env.PLOW_ACCESS_REAPPLY) {
      assert.equal((await admin('admin/users', {
        name: 'Fixture Viewer', email: caller, login: caller, password: randomBytes(24).toString('hex'),
      })).code, 200)
    }
    const viewer = JSON.parse((await admin('org/users')).body).find(user => user.login === caller)
    assert.equal(viewer.role, 'Viewer')
    assert.equal(JSON.parse((await admin('users/' + viewer.userId)).body).isGrafanaAdmin, false)

    const key = await generateKeyPair('RS256')
    const wrongKey = await generateKeyPair('RS256')
    const publicKey = { ...await exportJWK(key.publicKey), kid: 'fixture' }
    const jwks = await listen(t, createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ keys: [publicKey] }))
    }))
    const keys = createRemoteJWKSet(new URL('http://127.0.0.1:' + jwks.port + '/certs'))
    const now = Math.floor(Date.now() / 1000)
    const claims = { iss: issuer, aud: [audience], sub: 'oauth-fixture', type: 'app', exp: now + 300, email: accessEmail }
    const sign = (overrides, signer = key.privateKey) =>
      new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).sign(signer)
    const token = await sign({})
    const spoof = { 'tailscale-user-login': caller, 'x-plow-viewer': 'admin', 'cf-access-authenticated-user-email': accessEmail,
      authorization: 'Basic ' + Buffer.from('admin:' + adminPass).toString('base64'), cookie: 'grafana_session=unused' }
    const verify = accessIdentity(keys, issuer, audience, accessEmail)
    const open = await listen(t, gateway({ origin: publicOrigin, viewer: caller, socketPath,
      authenticate: headers => verify(headers['cf-access-jwt-assertion']),
    }))
    const privateSocket = join(dir, 'fixture-serve.sock')
    const local = await listen(t, gateway({ origin: tailnet, viewer: caller, socketPath, privateRoute: true,
      authenticate: headers => headers['tailscale-user-login'] === caller && Infinity,
    }), privateSocket)
    const options = (jwt, origin = publicOrigin) => ({ ...open, headers: { ...spoof, host: publicHost, origin,
      ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}),
    } })
    for (const bad of [undefined, 'invalid', await sign({}, wrongKey.privateKey), await sign({ exp: now - 30 }),
      await sign({ exp: undefined }), await sign({ aud: ['wrong'] }), await sign({ iss: 'https://example.invalid' }),
      await sign({ email: 'missed@example.invalid' }), await sign({ email: undefined }),
      await sign({ sub: undefined }), await sign({ type: 'org' })]) {
      assert.equal((await call(options(bad), '/app/api/user')).code, 401)
    }
    assert.equal((await call(options(token, 'https://wrong.example.invalid'), '/app/api/user')).code, 403)
    assert.equal((await call({ ...open, headers: { ...options(token).headers, host: 'other.example.invalid' } },
      '/app/api/user')).code, 403)
    const tailHeaders = { 'x-forwarded-host': authority, 'tailscale-user-login': caller, origin: tailnet,
      'x-plow-viewer': 'admin' }
    const tail = { ...local, headers: tailHeaders }
    assert.equal((await call({ ...local, headers: { ...tailHeaders, 'tailscale-user-login': 'stranger@example.invalid',
      'cf-access-jwt-assertion': token } }, '/app/api/user')).code, 401)
    assert.equal((await call(tail, '/d/plow-run-breakdown/run-breakdown?orgId=1')).headers.location,
      tailnet + '/app/d/plow-run-breakdown/run-breakdown?orgId=1')
    for (const [origin, entry] of [[publicOrigin, options(token)], [tailnet, tail]]) {
      const canonical = await call(entry, '/app?from=now-1h')
      assert.equal(canonical.code, 308)
      assert.equal(canonical.headers.location, origin + '/app/?from=now-1h')
      const home = await call(entry, '/app/')
      assert.equal(home.code, 302)
      const dashboard = await call(entry, new URL(home.headers.location).pathname)
      assert.equal(dashboard.code, 200)
      const html = dashboard.body.toString()
      assert.ok(html.includes('<base href="/app/"'))
      const bundlePath = html.match(/src="(public\/build\/app\.[^"]+\.js)"/)?.[1]
      assert.ok(bundlePath)
      assert.equal((await call(entry, "/app/" + bundlePath)).code, 200)
      assert.equal(dashboard.headers['set-cookie'], undefined)
      assert.equal(dashboard.headers['cache-control'], 'private, no-store')
      const user = await call(entry, '/app/api/user')
      assert.equal(user.code, 200)
      assert.equal(JSON.parse(user.body).login, caller)
      assert.equal((await call(entry, '/app/api/admin/settings')).code, 403)
      for (const path of ['/app/mcp', '/app/mcp/', '/app/login/google']) assert.equal((await call(entry, path)).code, 404)
      const asset = await call(entry, '/app/public/build/plow-cream.png')
      assert.equal(asset.code, 200)
      assert.equal(asset.headers['content-type'], 'image/png')
      assert.equal((await call(entry, '/app/public/plugins/plow-agent-observability-datasource/module.js')).code, 200)
      assert.equal(await websocket(entry), 101)

      const provisioned = await call(entry, '/app/api/dashboards/uid/plow-run-breakdown')
      const query = JSON.parse(provisioned.body).dashboard.panels.find(panel => panel.id === 1).targets[0]
      const payload = JSON.stringify({ from: '1748951940000', to: '1748952060000', queries: [{ ...query, runId: 'fixture-run' }] })
      const post = { ...entry, headers: { ...entry.headers, 'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload) } }
      let covered = false
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await call(post, '/app/api/ds/query', payload)
        assert.equal(response.code, 200)
        const frames = JSON.parse(response.body).results.A.frames
        covered = frames.some(frame => frame.schema.name === 'intervals' && frame.data.values[4].includes(2000))
        if (covered) break
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      assert.equal(covered, true)
    }
    assert.equal(await websocket(options()), 403)
    assert.equal((await call(options(token), '/brand/')).code, 404)
    assert.equal((await call(options(token), '/app/%2e%2e/')).code, 400)
  })
