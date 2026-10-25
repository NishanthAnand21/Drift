#!/usr/bin/env node
'use strict'
// Drift MCP bridge (stdio ⇄ running Drift). Runs with Node.js 18+. Configure your MCP client with:
//   command: "node", args: ["<path to this file>"], env: { DRIFT_MCP_CONFIG: "<userData>/drift-mcp.json" }
// Settings → Integrations shows the exact snippet.
const fs = require('fs')
const http = require('http')
const readline = require('readline')

const CONFIG = process.env.DRIFT_MCP_CONFIG
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

function drift (method, path, body) {
  return new Promise((resolve, reject) => {
    let cfg
    try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch { return reject(new Error('Drift is not running, or “Allow MCP clients” is off in Settings → Integrations.')) }
    const data = body ? JSON.stringify(body) : null
    const req = http.request({ host: '127.0.0.1', port: cfg.port, path, method, headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', c => { s += c }); res.on('end', () => { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } })
    })
    req.on('error', () => reject(new Error('Could not reach Drift — is it running with MCP enabled?')))
    if (data) req.write(data)
    req.end()
  })
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg; try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (id === undefined) return // notification
  try {
    if (method === 'initialize') {
      return out({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'drift-browser', version: '1.1.0' }, instructions: 'Control the Drift web browser: list/open/switch tabs, read page text, search history and manage spaces.' } })
    }
    if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} })
    if (method === 'tools/list') { const r = await drift('GET', '/tools'); return out({ jsonrpc: '2.0', id, result: { tools: r.tools || [] } }) }
    if (method === 'tools/call') {
      const r = await drift('POST', '/call', { name: params.name, arguments: params.arguments })
      if (r.error) return out({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: r.error }] } })
      return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2) }] } })
    }
    out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
  } catch (e) {
    if (method === 'tools/list') return out({ jsonrpc: '2.0', id, result: { tools: [] } })
    out({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message } ] } })
  }
})
