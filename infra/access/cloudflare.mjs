import { request } from 'node:http'
import { join } from 'node:path'
import { open, readFile } from 'node:fs/promises'
import { isDeepStrictEqual as equal } from 'node:util'
import { pathToFileURL } from 'node:url'

const host = 'plow.tryapparent.com'
const routePath = '^/app(/.*)?$'

export function plan(config, { team, audience, port }) {
  const access = { access: { required: true, teamName: team, audTag: [audience] } }
  const rule = (path, origin) => ({
    hostname: host, path, service: 'http://127.0.0.1:' + origin, originRequest: access,
  })
  const mcp = rule('^/app/mcp$', 15480)
  const legacy = rule('^/app/?$', 3033)
  const publicSite = { hostname: host, service: 'http://127.0.0.1:3032' }
  if (!equal(config.ingress, [mcp, legacy, publicSite, { service: 'http_status:404' }])) {
    throw Error('Unexpected Tunnel rule order or settings. Review the current routes before cutover.')
  }
  return { ...config, ingress: [mcp, rule(routePath, port), ...config.ingress.slice(2)] }
}

export async function transition({ action, current, put, load, save, target, probe, validate }) {
  const actual = await current()
  let receipt = await load()
  if (!receipt) {
    if (action === 'rollback') throw Error('Rollback requires the original private receipt.')
    receipt = { before: actual, after: target(actual) }
  }
  const { before, after } = receipt
  if (!equal(after, target(before))) throw Error('Receipt differs from this release or its configured inputs.')
  if (!equal(actual, before) && !equal(actual, after)) throw Error('Tunnel drift. No write attempted.')

  const replace = async (expected, next) => {
    const observed = await current()
    if (equal(observed, next)) return
    if (!equal(observed, expected)) throw Error('Tunnel drift. Refused to overwrite another change.')
    await put(next)
    if (!equal(await current(), next)) throw Error('Tunnel readback failed.')
  }
  if (action === 'rollback') {
    await replace(after, before)
    return 'legacy'
  }
  await probe()
  const baseline = await validate()
  await save(receipt)
  try {
    await replace(before, after)
    if (!equal(await validate(), baseline)) throw Error('The signed-out edge or a preserved route changed.')
  } catch (error) {
    if (equal(actual, after)) throw error
    try { await replace(after, before) } catch {
      throw Error('Cutover failed and legacy restoration is unverified. Inspect the Tunnel and private receipt.')
    }
    throw Error('Cutover failed. The legacy Tunnel configuration is restored.', { cause: error })
  }
  return 'grafana'
}

function matchesHost(pattern) {
  const domain = pattern.toLowerCase()
  return domain === host ||
    (domain.startsWith('*') && host.endsWith(domain.slice(1))) ||
    (domain.endsWith('*') && host.startsWith(domain.slice(0, -1)))
}

function overlapsWorker(pattern) {
  const [domain, ...path] = pattern.replace(/^https?:\/\//i, '').split('/')
  if (!matchesHost(domain)) return false
  const prefix = '/' + path.join('/')
  if (prefix.startsWith('/app/') || prefix === '/app') return true
  return prefix.includes('*') && '/app/'.startsWith(prefix.split('*')[0])
}

async function review(api, { account, zone, application, audience }) {
  const accountPath = 'accounts/' + account
  const appsPath = accountPath + '/access/apps'
  const appPath = appsPath + '/' + application
  const zonesPath = 'zones/' + zone + '/workers/routes'
  const [app, apps, policies, providers, workers] = await Promise.all([
    api(appPath), api(appsPath, 'GET', undefined, true), api(appPath + '/policies', 'GET', undefined, true),
    api(accountPath + '/access/identity_providers', 'GET', undefined, true), api(zonesPath, 'GET', undefined, true),
  ])
  const domains = app.self_hosted_domains ?? []
  if (app.type !== 'self_hosted' || app.aud !== audience ||
      !domains.includes(host + '/app') || !domains.includes(host + '/app/*')) {
    throw Error('The existing Access application must protect both /app and /app/* with the configured audience.')
  }
  for (const other of apps.filter(item => item.id !== application)) {
    const otherDomains = [other.domain, ...(other.self_hosted_domains ?? []),
      ...(other.destinations ?? []).map(item => item.uri)].filter(Boolean)
    if (otherDomains.some(entry => {
      const [domain, ...path] = entry.replace(/^https?:\/\//i, '').split('/')
      const fixed = '/' + path.join('/').split('*')[0]
      return matchesHost(domain) && (fixed.startsWith('/app/') || fixed === '/app' || '/app/'.startsWith(fixed))
    })) throw Error('Another Access application may overlap /app. Review precedence before cutover.')
  }
  const enabled = providers.filter(provider => !app.allowed_idps?.length || app.allowed_idps.includes(provider.id))
  if (!enabled.some(provider => provider.type === 'google' || provider.type === 'google-apps') ||
      !policies.some(policy => policy.decision === 'allow') || policies.some(policy => policy.decision === 'bypass')) {
    throw Error('Expected an enabled Google identity provider, an Allow policy, and no Bypass policy.')
  }
  if (workers.some(route => overlapsWorker(route.pattern))) {
    throw Error('A Worker route overlaps /app. Resolve route precedence before cutover.')
  }
  return {
    providerTypes: enabled.map(provider => provider.type),
    managedOAuth: app.oauth_configuration?.enabled === true,
    policies: policies.map(policy => ({
      precedence: policy.precedence, decision: policy.decision,
      ...Object.fromEntries(['include', 'require', 'exclude'].map(part =>
        [part, (policy[part] ?? []).flatMap(rule => Object.keys(rule))])),
    })),
  }
}

async function signedOut(team) {
  const origin = 'https://' + host
  const statuses = {}
  const protectedPaths = ['/app', '/app/', '/app/d/plow-run-breakdown/run-breakdown', '/app/public/build/plow-cream.png',
    '/app/api/ds/query', '/app/api/live/ws', '/app/mcp']
  for (const path of [...protectedPaths, '/', '/brand/', '/.well-known/cloudflare-access-protected-resource/app/mcp']) {
    const response = await fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
    await response.body?.cancel()
    if (protectedPaths.includes(path)) {
      const location = new URL(response.headers.get('location') ?? origin, origin)
      const challenge = response.headers.get('www-authenticate') ?? ''
      if (!((response.status === 401 && challenge.startsWith('Bearer ') &&
          challenge.includes(origin + '/.well-known/cloudflare-access-protected-resource/')) ||
          (response.status === 302 && location.origin === 'https://' + team + '.cloudflareaccess.com' &&
          location.pathname === '/cdn-cgi/access/login/' + host))) throw Error('Access challenge missing on ' + path)
    }
    statuses[path] = response.status
  }
  return statuses
}

async function probeViewer(directory, viewer, origin) {
  if (!directory || !viewer || !origin) throw Error('Set the gateway runtime and Tailscale viewer inputs for apply.')
  const status = await new Promise((resolve, reject) => {
    const req = request({
      socketPath: join(directory, 'access-tailnet.sock'), path: '/app/api/user',
      headers: { 'x-forwarded-host': new URL(origin).host, 'tailscale-user-login': viewer },
      signal: AbortSignal.timeout(5000),
    }, response => {
      response.resume()
      resolve(response.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  if (status !== 200) throw Error('Gateway could not reach Grafana as its provisioned Viewer.')
}

async function main(action) {
  const {
    PLOW_CF_ACCOUNT: account, PLOW_CF_ZONE: zone, PLOW_CF_TUNNEL: tunnel, PLOW_CF_ACCESS_APP: application,
    PLOW_CF_TOKEN_FILE: tokenFile, PLOW_CF_RECEIPT: receiptFile,
    PLOW_LGTM_WORKDIR: directory, PLOW_TAILNET_VIEWER: viewer, PLOW_TAILNET_ORIGIN: tailnet,
    PLOW_ACCESS_TEAM: team, PLOW_ACCESS_AUDIENCE: audience, PLOW_ACCESS_PORT: port = '15583',
  } = process.env
  if (![account, zone].every(id => /^[a-f0-9]{32}$/.test(id ?? '')) ||
      ![tunnel, application].every(id => /^[a-f0-9-]{36}$/.test(id ?? '')) ||
      !/^[a-z0-9-]+$/.test(team ?? '') || !/^[a-f0-9]{64}$/.test(audience ?? '') ||
      !/^\d+$/.test(port) || +port < 1024 || +port > 65535 || [3032, 3033, 15480].includes(+port) ||
      !tokenFile || (action !== 'status' && !receiptFile)) throw Error('Invalid Cloudflare ingress inputs.')
  const token = (await readFile(tokenFile, 'utf8')).trim()
  if (!/^[\w.-]+$/.test(token)) throw Error('Invalid Cloudflare token file.')
  async function api(path, method = 'GET', body, list = false) {
    const entries = []
    for (let page = 1; page <= 25; page++) {
      const endpoint = 'https://api.cloudflare.com/client/v4/' + path +
        (list && page > 1 ? '?page=' + page : '')
      const response = await fetch(endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw Error('Cloudflare ' + method + ' returned HTTP ' + response.status + '.')
      const payload = await response.json()
      if (!payload.success) throw Error('Cloudflare rejected ' + method + '.')
      if (!list) return payload.result
      entries.push(...payload.result)
      if (page >= (payload.result_info?.total_pages ?? 1)) return entries
    }
    throw Error('Cloudflare list exceeded the bounded inventory.')
  }
  const configuration = 'accounts/' + account + '/cfd_tunnel/' + tunnel + '/configurations'
  const current = async () => (await api(configuration)).config
  const input = { team, audience, port: +port }
  const context = { account, zone, tunnel, application }
  const load = async () => readFile(receiptFile, 'utf8').then(raw => {
    const { scope, before, after } = JSON.parse(raw)
    if (!equal(scope, context)) throw Error('Receipt belongs to a different Cloudflare route.')
    return { before, after }
  }, error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (action !== 'rollback') console.log(JSON.stringify(await review(api, { ...context, audience })))
  if (action === 'status') {
    const actual = await current()
    const saved = receiptFile ? await load() : undefined
    const active = saved && equal(actual, plan(saved.before, input)) ? 'grafana' : 'legacy'
    if (active === 'legacy') plan(actual, input)
    console.log(JSON.stringify({ active, signedOut: await signedOut(team) }))
    return
  }
  const result = await transition({
    action, current, load, target: config => plan(config, input),
    put: config => api(configuration, 'PUT', { config }),
    save: async receipt => {
      if (await load()) return
      const handle = await open(receiptFile, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ scope: context, ...receipt }))
        await handle.sync()
      } finally { await handle.close() }
    },
    probe: async () => {
      await probeViewer(directory, viewer, tailnet)
      const origin = 'http://127.0.0.1:' + port
      for (const path of ['/app', '/app/', '/app/api/user']) {
        const response = await fetch(origin + path, {
          redirect: 'manual', signal: AbortSignal.timeout(5_000),
          headers: { host, 'cf-access-jwt-assertion': 'invalid', 'tailscale-user-login': 'probe@example.invalid' },
        })
        await response.body?.cancel()
        if (response.status !== 401) throw Error('Gateway denial check failed.')
      }
    },
    validate: () => signedOut(team),
  })
  console.log('Tunnel configuration readback: ' + result)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2]
  if (!['status', 'apply', 'rollback'].includes(action)) {
    console.error('Use status, apply, or rollback.')
    process.exitCode = 1
  } else {
    main(action).catch(error => {
      console.error(error instanceof SyntaxError || !error.message || error.code ?
        'Ingress operation failed. Check private inputs and connectivity.' : error.message)
      process.exitCode = 1
    })
  }
}
