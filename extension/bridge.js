// Runs on the dashboard site only (see manifest "matches"). Relays sync requests from the
// dashboard page to the extension, and results back. It never runs on any other site.
;(() => {
  const VERSION = chrome.runtime.getManifest().version
  const announce = () => window.postMessage({ type: 'vitdash-ext-ready', version: VERSION }, location.origin)

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin) return
    const msg = e.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'vitdash-ext-ping') return announce()
    if (msg.type !== 'vitdash-sync-request' && msg.type !== 'vitdash-alloc-request') return
    const kind = msg.type === 'vitdash-alloc-request' ? 'alloc' : 'sync'
    const done = kind === 'alloc' ? 'vitdash-alloc-result' : 'vitdash-sync-result'
    try {
      const result = await chrome.runtime.sendMessage({ type: kind, preferTerm: typeof msg.preferTerm === 'string' ? msg.preferTerm.slice(0, 80) : '' })
      window.postMessage({ type: done, result }, location.origin)
    } catch (err) {
      window.postMessage({ type: done, result: { ok: false, error: String(err?.message || err) } }, location.origin)
    }
  })

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'progress') window.postMessage({ type: 'vitdash-sync-progress', text: msg.text }, location.origin)
  })

  announce()
  document.addEventListener('DOMContentLoaded', announce)
})()
