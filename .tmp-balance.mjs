import { readFileSync } from 'node:fs'
const lines = readFileSync('src/renderer/src/App.tsx', 'utf8').split('\n')
let paren = 0, brace = 0, bracket = 0
let inStr = null, inTpl = false
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  for (let c = 0; c < line.length; c++) {
    const ch = line[c]
    if (inStr) { if (ch === '\\') { c++; continue } if (ch === inStr) inStr = null; continue }
    if (inTpl) { if (ch === '`') inTpl = false; continue }
    if (ch === '"' || ch === "'") { inStr = ch; continue }
    if (ch === '`') { inTpl = true; continue }
    if (ch === '/' && line[c + 1] === '/') break
    if (ch === '(') paren++
    else if (ch === ')') paren--
    else if (ch === '{') brace++
    else if (ch === '}') brace--
    else if (ch === '[') bracket++
    else if (ch === ']') bracket--
  }
  if (paren < 0 || brace < 0 || bracket < 0) console.log('NEGATIVE at line', i + 1, { paren, brace, bracket })
}
console.log('FINAL', { paren, brace, bracket })
