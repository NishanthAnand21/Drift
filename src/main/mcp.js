'use strict'
// Local MCP endpoint: lets Claude (Desktop / Code) or any MCP client drive Drift
// through the stdio bridge in src/mcp/bridge.js. Off by default. Listens on
// 127.0.0.1 only, requires a random bearer token, and rejects browser requests.
const http = require('http')
const fs = require('fs')
const crypto = require('crypto')

function startMcp ({ configFile, tools, onCall }) {
  const token = crypto.randomBytes(32).toString('hex')
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const auth = req.headers.authorization || ''
    const okAuth = auth.length === 7 + token.length && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from('Bearer ' + token))
    if (!okAuth || req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return send(403, { error: 'forbidden' })
    if (req.method === 'GET' && req.url === '/tools') return send(200, { tools: tools() })
    if (req.method !== 'POST' || req.url !== '/call') return send(404, { error: 'not found' })
    let body = ''
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy() })
    req.on('end', async () => {
      try {
        const { name, arguments: args } = JSON.parse(body)
        send(200, { result: await onCall(name, args || {}) })
      } catch (e) { send(200, { error: e.message || String(e) }) }
    })
  })
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(configFile, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 })
  })
  return { stop () { server.close(); try { fs.unlinkSync(configFile) } catch {} } }
}

module.exports = { startMcp }
