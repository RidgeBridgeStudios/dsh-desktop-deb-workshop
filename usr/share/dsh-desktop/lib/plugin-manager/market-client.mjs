import {
  INSTALL_PATH,
  LOCALES_PATH,
  STATUS_PATH,
  UNINSTALL_PATH
} from './market-constants.mjs'

export const MARKET_REPOSITORY = 'https://github.com/dsh-market/dsh-market'

export const CLIENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Desktop</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .dsh-market { box-sizing: border-box; max-width: 720px; margin: 0 auto; padding: 28px 20px; display: flex; flex-direction: column; gap: 16px; }
  .dsh-market h2 { margin: 0; font-size: 20px; font-weight: 600; }
  .dsh-market h3 { margin: 0; font-size: 16px; font-weight: 600; }
  .dsh-market p { margin: 0; }
  .dsh-market .card { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 14px; padding: 22px; display: flex; flex-direction: column; gap: 16px; }
  .dsh-market .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .dsh-market .muted { opacity: .72; }
  .dsh-market .error { color: #c0392b; }
  .dsh-market button { font: inherit; padding: 8px 16px; border-radius: 18px; border: 1px solid transparent; cursor: pointer; }
  .dsh-market button.primary { background: #3a6df0; color: #fff; }
  .dsh-market button.secondary { background: transparent; border-color: color-mix(in srgb, currentColor 28%, transparent); color: inherit; }
  .dsh-market button:disabled { opacity: .5; cursor: default; }
  .dsh-market a { color: inherit; }
  .dsh-market .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: grid; place-items: center; padding: 24px; }
  .dsh-market .modal { max-width: 440px; background: Canvas; color: CanvasText; border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
</style>
</head>
<body>
<main id="dsh-market-root" class="dsh-market" hidden></main>
<div id="dsh-market-modal"></div>
<script src="./client.js"></script>
</body>
</html>`

export const CLIENT_SCRIPT = `(function () {
  'use strict'
  var STATUS_PATH = '${STATUS_PATH}'
  var INSTALL_PATH = '${INSTALL_PATH}'
  var UNINSTALL_PATH = '${UNINSTALL_PATH}'
  var LOCALES_PATH = '${LOCALES_PATH}'
  var REPOSITORY = '${MARKET_REPOSITORY}'

  var root = document.getElementById('dsh-market-root')
  var modal = document.getElementById('dsh-market-modal')
  var dictionaries = null
  var status = null
  var error = null
  var restarting = false
  var confirming = false
  var timer = null

  function resolveLocale(preference) {
    return preference && String(preference).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
  }
  function t(key) {
    var language = resolveLocale(navigator.language)
    var chosen = dictionaries && (dictionaries[language] || dictionaries.en)
    return (chosen && chosen[key]) || (dictionaries && dictionaries.en && dictionaries.en[key]) || key
  }
  function el(tag, options, children) {
    var node = document.createElement(tag)
    options = options || {}
    if (options.text) node.textContent = options.text
    if (options.className) node.className = options.className
    if (options.disabled) node.disabled = true
    if (options.onClick) node.addEventListener('click', options.onClick)
    ;(children || []).forEach(function (child) { node.appendChild(child) })
    return node
  }
  function readStatus() {
    return fetch(STATUS_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) throw new Error((payload && payload.error) || 'HTTP ' + response.status)
        return payload
      })
    })
  }
  function post(path) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok && response.status !== 409) throw new Error((payload && payload.error) || 'HTTP ' + response.status)
        return payload
      })
    })
  }
  function restart() {
    var bridge = globalThis.dshDesktop
    if (bridge && typeof bridge.restartHarness === 'function') {
      return Promise.resolve(bridge.restartHarness())
    }
    return Promise.resolve('restart-required')
  }
  function install() {
    error = null
    status = Object.assign({}, status, { phase: 'installing' })
    render()
    post(INSTALL_PATH).then(function (payload) {
      status = payload
      render()
      schedule()
    }).catch(function (failure) {
      error = failure && failure.message ? failure.message : String(failure)
      render()
      schedule()
    })
  }
  function uninstall() {
    confirming = false
    error = null
    status = Object.assign({}, status, { phase: 'uninstalling' })
    render()
    post(UNINSTALL_PATH).then(function (payload) {
      status = payload
      render()
      schedule()
    }).catch(function (failure) {
      error = failure && failure.message ? failure.message : String(failure)
      render()
      schedule()
    })
  }
  function doRestart() {
    restarting = true
    render()
    restart().catch(function (failure) {
      restarting = false
      error = failure && failure.message ? failure.message : String(failure)
      render()
    })
  }
  function repoLink() {
    var link = el('a', { text: t('repository') })
    link.href = REPOSITORY
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    return link
  }
  function statusBlock() {
    var phase = status && status.phase
    if (phase === 'installing' || phase === 'uninstalling') {
      return el('p', { className: 'muted', text: (status && status.detail) || (phase === 'installing' ? t('installingHint') : t('uninstallingHint')) })
    }
    if (phase === 'installed') return el('p', { className: 'muted', text: t('installedHint') })
    if (phase === 'uninstalled' || phase === 'absent') return el('p', { className: 'muted', text: t('removedHint') })
    if (phase === 'incomplete') return el('p', { className: 'error', text: t('incomplete') })
    if (phase === 'error' || error) return el('p', { className: 'error', text: error || (status && status.detail) || t('failed') })
    return el('p', { className: 'muted', text: t('installingHint') })
  }
  function managementTab() {
    var card = el('div', { className: 'card' })
    card.appendChild(el('h3', { text: 'dsh-market' }))
    card.appendChild(el('p', { className: 'muted', text: t('installedVersion') + ' · ' + (status.installedVersion || '') }))
    card.appendChild(statusBlock())
    var actions = el('div', { className: 'row' })
    actions.appendChild(el('button', {
      className: 'secondary',
      text: t('uninstall'),
      disabled: status.phase === 'uninstalling',
      onClick: function () { confirming = true; render() }
    }))
    actions.appendChild(repoLink())
    card.appendChild(actions)
    return card
  }
  function settingsEntry() {
    var card = el('div', { className: 'card' })
    card.appendChild(el('h3', { text: 'dsh-market' }))
    card.appendChild(el('p', { className: 'muted', text: t('version') + ' · ' + (status.recommendedVersion || 'latest') }))
    card.appendChild(statusBlock())
    var actions = el('div', { className: 'row' })
    actions.appendChild(el('button', {
      className: 'primary',
      text: status.phase === 'installed' ? (restarting ? t('restarting') : t('restart')) : t('install'),
      disabled: restarting || status.phase === 'installing',
      onClick: function () { status.phase === 'installed' ? doRestart() : install() }
    }))
    actions.appendChild(repoLink())
    card.appendChild(actions)
    return card
  }
  function confirmDialog() {
    var backdrop = el('div', { className: 'modal-backdrop' })
    var dialog = el('div', { className: 'modal' })
    dialog.appendChild(el('h3', { text: t('uninstallConfirmTitle') }))
    dialog.appendChild(el('p', { text: t('uninstallConfirmDesc') }))
    dialog.appendChild(el('p', { className: 'muted', text: t('uninstallConfirmNote') }))
    var actions = el('div', { className: 'row' })
    actions.appendChild(el('button', { className: 'secondary', text: t('cancel'), onClick: function () { confirming = false; render() } }))
    actions.appendChild(el('button', { className: 'primary', text: t('uninstall'), onClick: uninstall }))
    dialog.appendChild(actions)
    backdrop.appendChild(dialog)
    return backdrop
  }
  function render() {
    if (!status) { root.hidden = true; return }
    root.hidden = false
    root.textContent = ''
    root.appendChild(el('h2', { text: t('title') }))
    if (status.phase === 'installed') {
      root.appendChild(el('p', { className: 'muted', text: t('managementIntro') }))
      root.appendChild(managementTab())
    } else {
      root.appendChild(el('p', { className: 'muted', text: t('intro') }))
      root.appendChild(settingsEntry())
      root.appendChild(el('p', { className: 'muted', text: t('community') }))
    }
    if (status.restartRequired) root.appendChild(el('p', { text: t('restartRequired') + ' — ' + t('restartRequiredHint') }))
    modal.textContent = ''
    if (confirming) modal.appendChild(confirmDialog())
  }
  function schedule() {
    if (timer) clearTimeout(timer)
    var phase = status && status.phase
    if (phase === 'installing' || phase === 'uninstalling') timer = setTimeout(refresh, 850)
    else if (error) timer = setTimeout(refresh, 1500)
  }
  function refresh() {
    readStatus().then(function (next) {
      status = next
      error = null
      render()
      schedule()
    }).catch(function (failure) {
      error = failure && failure.message ? failure.message : String(failure)
      render()
      schedule()
    })
  }
  fetch(LOCALES_PATH, { credentials: 'same-origin' }).then(function (response) { return response.json() }).then(function (all) {
    dictionaries = all
    refresh()
  }).catch(function () {
    dictionaries = {}
    refresh()
  })
})()
`
