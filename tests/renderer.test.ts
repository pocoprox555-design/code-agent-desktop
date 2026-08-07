import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { App } from '../src/renderer/src/App'

function renderAtWidth(width: number): string {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: width } })
  try { return renderToStaticMarkup(createElement(App)) }
  finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') }
}

test('renderer starts with the sidebar open on desktop', () => {
  const html = renderAtWidth(1200)
  assert.match(html, /id="app-sidebar"/)
  assert.doesNotMatch(html, /aria-label="فتح الشريط الجانبي"/)
})

test('renderer starts with the sidebar closed on narrow screens', () => {
  const html = renderAtWidth(600)
  assert.doesNotMatch(html, /id="app-sidebar"/)
  assert.match(html, /aria-label="فتح الشريط الجانبي"/)
})
