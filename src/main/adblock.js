'use strict'
// Filter-list ad & tracker blocker (EasyList / EasyPrivacy / uBlock lists via
// @ghostery/adblocker). Lists are downloaded once, cached on disk, refreshed weekly.
// Until they load, the built-in domain list in blocker.js is used.
const fs = require('fs')
const path = require('path')
const { net } = require('electron')
const { FiltersEngine, Request } = require('@ghostery/adblocker')
const { parse: parseDomain } = require('tldts-experimental')

const TYPES = { mainFrame: 'main_frame', subFrame: 'sub_frame', xhr: 'xmlhttprequest', cspReport: 'csp_report', webSocket: 'websocket' }
const WEEK = 7 * 24 * 3600e3

let engine = null
let strict = false

async function load (dir, { strictMode = false } = {}) {
  strict = strictMode
  const file = path.join(dir, `adblock-${strict ? 'full' : 'ads-tracking'}.bin`)
  const fetchImpl = (url, opts) => net.fetch(url, opts)
  try {
    const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < WEEK
    if (fresh) { engine = FiltersEngine.deserialize(fs.readFileSync(file)); return 'cache' }
    const e = strict ? await FiltersEngine.fromPrebuiltFull(fetchImpl) : await FiltersEngine.fromPrebuiltAdsAndTracking(fetchImpl)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, e.serialize())
    engine = e
    return 'network'
  } catch (err) {
    if (fs.existsSync(file)) { try { engine = FiltersEngine.deserialize(fs.readFileSync(file)); return 'stale-cache' } catch {} }
    return 'unavailable: ' + err.message
  }
}

// For tests and custom rules
function useFilters (text) { engine = FiltersEngine.parse(text) }

function match (details, pageUrl) {
  if (!engine) return null
  const r = Request.fromRawDetails({ url: details.url, type: TYPES[details.resourceType] || details.resourceType || 'other', sourceUrl: pageUrl || details.referrer || '' })
  const { match: blocked, redirect } = engine.match(r)
  if (redirect) return { redirectURL: redirect.dataUrl }
  return blocked ? { cancel: true } : null
}

// Element-hiding CSS for a page (cookie banners in strict mode, ad slots, …)
function cosmeticCss (url) {
  if (!engine) return ''
  try {
    const { hostname, domain } = parseDomain(url)
    if (!hostname) return ''
    const { styles } = engine.getCosmeticsFilters({ url, hostname, domain: domain || '', getBaseRules: true, getInjectionRules: false, getExtendedRules: false, getRulesFromHostname: true })
    return styles || ''
  } catch { return '' }
}

module.exports = { load, match, cosmeticCss, useFilters, get ready () { return !!engine }, get strict () { return strict } }
