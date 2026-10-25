'use strict'
const fs = require('fs')
const path = require('path')

// Small JSON store with atomic, debounced writes.
class Store {
  constructor (file, defaults) {
    this.file = file
    this.timer = null
    let data = {}
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    this.state = { ...structuredClone(defaults), ...data }
    this.state.settings = { ...defaults.settings, ...(data.settings || {}) }
  }

  save () {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), 400)
  }

  saveNow () {
    clearTimeout(this.timer)
    const tmp = this.file + '.tmp'
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

module.exports = { Store }
