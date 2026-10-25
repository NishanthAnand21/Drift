'use strict'
// Built-in tracker & ad blocker: blocks sub-resources from well-known
// advertising / cross-site tracking hosts (and all of their subdomains).
const DOMAINS = `
doubleclick.net googlesyndication.com googleadservices.com google-analytics.com
googletagmanager.com googletagservices.com adservice.google.com pagead2.googlesyndication.com
analytics.google.com app-measurement.com 2mdn.net adnxs.com adsrvr.org amazon-adsystem.com
criteo.com criteo.net taboola.com outbrain.com scorecardresearch.com quantserve.com
quantcount.com moatads.com pubmatic.com rubiconproject.com openx.net casalemedia.com
smartadserver.com teads.tv sharethrough.com adform.net bidswitch.net demdex.net
omtrdc.net everesttech.net krxd.net chartbeat.com chartbeat.net hotjar.com hotjar.io
clarity.ms fullstory.com mouseflow.com crazyegg.com luckyorange.com inspectlet.com
ads-twitter.com analytics.twitter.com static.ads-twitter.com bat.bing.com ads.linkedin.com
px.ads.linkedin.com analytics.tiktok.com ads.yahoo.com advertising.com media.net
yieldmo.com zedo.com serving-sys.com mathtag.com rlcdn.com agkn.com bluekai.com
exelator.com tapad.com adsymptotic.com 3lift.com triplelift.com indexww.com
contextweb.com lijit.com sovrn.com gumgum.com districtm.io adition.com
yandex.ru/metrika mc.yandex.ru top-fwz1.mail.ru hm.baidu.com cnzz.com
newrelic.com nr-data.net mixpanel.com segment.io cdn.segment.com amplitude.com
branch.io adjust.com appsflyer.com kochava.com onesignal.com
`.split(/\s+/).filter(Boolean)

const SET = new Set(DOMAINS)

function isBlockedHost (host) {
  if (!host) return false
  const parts = host.toLowerCase().split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    if (SET.has(parts.slice(i).join('.'))) return true
  }
  return false
}

module.exports = { isBlockedHost }
