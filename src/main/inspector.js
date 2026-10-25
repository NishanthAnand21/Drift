'use strict'
// Site Inspector: certificate, security headers (graded), cookies, tech stack,
// blocked requests and permissions for the current page.

const certs = new Map() // hostname -> { cert, verificationResult, at }
const mainResponses = new Map() // webContentsId -> { url, status, headers, ip }

function recordCert (req) {
  certs.set(req.hostname, { cert: req.certificate, verificationResult: req.verificationResult, at: Date.now() })
  if (certs.size > 500) certs.delete(certs.keys().next().value)
}
function recordResponse (details) {
  if (details.resourceType !== 'mainFrame' || details.webContentsId == null) return
  const headers = {}
  for (const [k, v] of Object.entries(details.responseHeaders || {})) headers[k.toLowerCase()] = [].concat(v).join(', ')
  mainResponses.set(details.webContentsId, { url: details.url, status: details.statusCode, headers, ip: details.ip })
}
function recordIp (details) {
  if (details.resourceType !== 'mainFrame') return
  const r = mainResponses.get(details.webContentsId); if (r && details.ip) r.ip = details.ip
}
function forget (wcId) { mainResponses.delete(wcId) }

const HEADER_CHECKS = [
  ['strict-transport-security', 'HSTS', 20, (v) => /max-age=(\d+)/.test(v) && +v.match(/max-age=(\d+)/)[1] >= 15552000 ? 'ok' : 'weak'],
  ['content-security-policy', 'Content-Security-Policy', 25, (v) => /unsafe-inline|unsafe-eval|\*/.test(v) && !/strict-dynamic|nonce-|sha256-/.test(v) ? 'weak' : 'ok'],
  ['x-frame-options', 'Clickjacking protection', 15, () => 'ok'],
  ['x-content-type-options', 'X-Content-Type-Options', 10, (v) => (/nosniff/i.test(v) ? 'ok' : 'weak')],
  ['referrer-policy', 'Referrer-Policy', 10, (v) => (/unsafe-url/.test(v) ? 'weak' : 'ok')],
  ['permissions-policy', 'Permissions-Policy', 10, () => 'ok'],
  ['cross-origin-opener-policy', 'Cross-Origin-Opener-Policy', 5, () => 'ok'],
  ['cross-origin-resource-policy', 'Cross-Origin-Resource-Policy', 5, () => 'ok']
]

function gradeHeaders (h, isHttps) {
  let score = 0; const rows = []
  for (const [name, label, pts, check] of HEADER_CHECKS) {
    let v = h[name]
    if (name === 'x-frame-options' && !v && /frame-ancestors/.test(h['content-security-policy'] || '')) v = 'CSP frame-ancestors'
    if (!v) { rows.push([label, 'missing', 'bad']); continue }
    const st = check(v)
    score += st === 'ok' ? pts : pts / 2
    rows.push([label, v.length > 90 ? v.slice(0, 90) + '…' : v, st])
  }
  if (!isHttps) score = Math.min(score, 20)
  const grade = score >= 90 ? 'A+' : score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : score >= 30 ? 'D' : 'F'
  return { grade, score: Math.round(score), rows }
}

// Runs in the page's main world; returns technology fingerprints.
const DETECT = `(() => {
  const w = window, d = document, out = new Set()
  const has = (s) => { try { return !!d.querySelector(s) } catch { return false } }
  const src = [...d.scripts].map(s => s.src).join(' ')
  const gen = d.querySelector('meta[name=generator]')?.content || ''
  if (gen) out.add('Generator: ' + gen.slice(0, 60))
  if (w.React || has('[data-reactroot]') || [...d.querySelectorAll('body *')].slice(0, 300).some(e => Object.keys(e).some(k => k.startsWith('__react')))) out.add('React')
  if (w.__NEXT_DATA__ || has('#__next') || /\\/_next\\//.test(src)) out.add('Next.js')
  if (w.Vue || w.__VUE__ || has('[data-v-app]')) out.add('Vue.js')
  if (w.__NUXT__ || w.$nuxt) out.add('Nuxt')
  if (w.ng || has('[ng-version]')) out.add('Angular' + (d.querySelector('[ng-version]') ? ' ' + d.querySelector('[ng-version]').getAttribute('ng-version') : ''))
  if (has('[class*="svelte-"]') || w.__svelte) out.add('Svelte')
  if (w.__remixContext) out.add('Remix')
  if (has('astro-island')) out.add('Astro')
  if (w.___gatsby || has('#___gatsby')) out.add('Gatsby')
  if (w.jQuery) out.add('jQuery ' + (w.jQuery.fn?.jquery || ''))
  if (w.wp || /wp-content|wp-includes/.test(src + d.head.innerHTML.slice(0, 20000))) out.add('WordPress')
  if (w.Shopify) out.add('Shopify')
  if (w.Drupal) out.add('Drupal')
  if (w.Joomla) out.add('Joomla')
  if (/wix\\.com|wixstatic/.test(src)) out.add('Wix')
  if (w.Squarespace || /squarespace/.test(src)) out.add('Squarespace')
  if (has('html[data-wf-site]')) out.add('Webflow')
  if (w.Ghost || /ghost/i.test(gen)) out.add('Ghost')
  if (has('link[href*="bootstrap"]') || w.bootstrap) out.add('Bootstrap')
  if ([...d.querySelectorAll('[class]')].slice(0, 400).filter(e => /\\b(flex|px-\\d|py-\\d|text-(sm|lg|xl)|bg-[a-z]+-\\d{3})\\b/.test(e.className)).length > 25) out.add('Tailwind CSS (likely)')
  if (w.gtag || w.ga || /google-analytics|googletagmanager/.test(src)) out.add('Google Analytics / Tag Manager')
  if (w.fbq) out.add('Meta Pixel')
  if (w.Intercom) out.add('Intercom')
  if (w.Stripe || /js\\.stripe\\.com/.test(src)) out.add('Stripe')
  if (w.Sentry || w.__SENTRY__) out.add('Sentry')
  if (w.hj) out.add('Hotjar')
  if (w.mixpanel) out.add('Mixpanel')
  if (w.posthog) out.add('PostHog')
  if (w.Alpine) out.add('Alpine.js')
  if (w.htmx) out.add('htmx')
  if (/recaptcha/.test(src) || w.grecaptcha) out.add('reCAPTCHA')
  if (/challenges\\.cloudflare\\.com\\/turnstile/.test(src)) out.add('Cloudflare Turnstile')
  if (/fonts\\.googleapis/.test(d.head.innerHTML)) out.add('Google Fonts')
  const mixed = location.protocol === 'https:' && [...d.querySelectorAll('img[src^="http:"],script[src^="http:"],iframe[src^="http:"],link[href^="http:"]')].length
  return { tech: [...out], mixed, thirdParty: [...new Set([...d.scripts].map(s => { try { return new URL(s.src).host } catch { return '' } }).filter(h => h && h !== location.host))].slice(0, 30) }
})()`

function techFromHeaders (h) {
  const t = []
  if (h.server) t.push('Server: ' + h.server)
  if (h['x-powered-by']) t.push('Powered by: ' + h['x-powered-by'])
  if (h['cf-ray']) t.push('Cloudflare')
  if (h['x-vercel-id']) t.push('Vercel')
  if (h['x-nf-request-id']) t.push('Netlify')
  if (h['x-amz-cf-id']) t.push('Amazon CloudFront')
  if (h['x-served-by'] && /cache-/.test(h['x-served-by'])) t.push('Fastly')
  if (h['x-akamai-transformed'] || /akamai/i.test(h.server || '')) t.push('Akamai')
  if (h['x-github-request-id']) t.push('GitHub Pages')
  if (h['x-shopify-stage'] || h['x-shopid']) t.push('Shopify')
  if (h['x-aspnet-version'] || h['x-aspnetmvc-version']) t.push('ASP.NET')
  if (/PHPSESSID/.test(h['set-cookie'] || '')) t.push('PHP')
  if (h['alt-svc'] && /h3/.test(h['alt-svc'])) t.push('HTTP/3 available')
  return t
}

const fmtDate = (s) => new Date(s * 1000).toISOString().slice(0, 10)

async function report ({ wc, url, ses, blocked, permissions }) {
  let u; try { u = new URL(url) } catch { return { title: 'Site Inspector', sections: [{ title: 'Nothing to inspect', rows: [] }] } }
  const isHttps = u.protocol === 'https:'
  const sections = []
  const resp = mainResponses.get(wc.id)
  const h = resp?.headers || {}

  // Connection & certificate
  const c = certs.get(u.hostname)
  const conn = [['Protocol', isHttps ? 'HTTPS (TLS 1.2+/1.3)' : 'HTTP — not encrypted', isHttps ? 'ok' : 'bad']]
  if (resp?.ip) conn.push(['Server IP', resp.ip, ''])
  if (resp?.status) conn.push(['Status', String(resp.status), ''])
  if (isHttps && c) {
    const cert = c.cert; const now = Date.now() / 1000
    const days = Math.round((cert.validExpiry - now) / 86400)
    conn.push(
      ['Certificate', c.verificationResult === 'net::OK' ? 'Valid — trusted by macOS / Chromium' : c.verificationResult, c.verificationResult === 'net::OK' ? 'ok' : 'bad'],
      ['Issued to', cert.subject?.commonName || cert.subjectName, ''],
      ['Issued by', [cert.issuer?.commonName, cert.issuer?.organizations?.[0]].filter(Boolean).join(' · ') || cert.issuerName, ''],
      ['Valid', `${fmtDate(cert.validStart)} → ${fmtDate(cert.validExpiry)} (${days} days left)`, days < 14 ? 'weak' : 'ok'],
      ['SHA-256 fingerprint', (cert.fingerprint || '').replace(/^sha256\//, ''), '']
    )
    if (cert.issuerCert) conn.push(['Chain', chain(cert).join(' → '), ''])
  } else if (isHttps) conn.push(['Certificate', 'Reload the page to capture certificate details', ''])
  sections.push({ title: 'Connection', rows: conn })

  // Security headers
  if (resp) {
    const g = gradeHeaders(h, isHttps)
    sections.push({ title: `Security headers — grade ${g.grade} (${g.score}/100)`, grade: g.grade, rows: g.rows })
  } else sections.push({ title: 'Security headers', rows: [['Headers', 'Reload the page to capture response headers', '']] })

  // Cookies
  try {
    const list = await ses.cookies.get({ url })
    const rows = list.slice(0, 60).map(k => {
      const flags = [k.secure ? 'Secure' : 'not Secure', k.httpOnly ? 'HttpOnly' : 'JS-readable', 'SameSite=' + (k.sameSite || 'unspecified'), k.session ? 'session' : 'expires ' + fmtDate(k.expirationDate)]
      const st = k.secure && k.httpOnly ? 'ok' : (!k.secure && isHttps) ? 'bad' : 'weak'
      return [k.name + (k.domain && !k.domain.endsWith(u.hostname) ? ` (${k.domain})` : ''), flags.join(' · '), st]
    })
    sections.push({ title: `Cookies (${list.length})`, rows: rows.length ? rows : [['None', 'This site has set no cookies', 'ok']] })
  } catch {}

  // Tech stack
  let page = { tech: [], mixed: 0, thirdParty: [] }
  try { page = await wc.executeJavaScript(DETECT) } catch {}
  const tech = [...new Set([...techFromHeaders(h), ...page.tech])]
  sections.push({ title: 'Tech stack', rows: tech.length ? tech.map(t => [t, '', '']) : [['Nothing detected', '', '']] })

  // Privacy
  sections.push({
    title: 'Privacy',
    rows: [
      ['Blocked by Drift', `${blocked} ads & trackers on this page`, blocked ? 'ok' : ''],
      ['Mixed content', page.mixed ? `${page.mixed} insecure resources` : 'None', page.mixed ? 'bad' : 'ok'],
      ['Third-party scripts', page.thirdParty.length ? page.thirdParty.join(', ') : 'None', ''],
      ['Permissions granted', Object.entries(permissions || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || 'None', '']
    ]
  })
  return { title: u.host, sections }
}

function chain (cert) {
  const names = []
  for (let c = cert; c && names.length < 5; c = c.issuerCert) {
    names.push(c.subject?.commonName || c.subjectName)
    if (c.issuerCert === c) break
  }
  return names
}

module.exports = { recordCert, recordResponse, recordIp, forget, report, gradeHeaders, techFromHeaders }
