// 检查 web/app.js 里 $('id') 引用的元素，在 index.html 里是否都存在。
// 这类错在浏览器里只表现为 null.addEventListener 崩掉，页面白屏，很难查。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')

const html = fs.readFileSync(path.join(REPO, 'web', 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(REPO, 'web', 'app.js'), 'utf8')

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))

const missing = [...used].filter((u) => !ids.has(u))
if (missing.length) {
  console.error(`✗ app.js 引用了不存在的元素 id（${missing.length} 个）：${missing.join(', ')}`)
  process.exit(1)
}

// 反过来：HTML 里有、没人用的 id 只提示，不算错
const unused = [...ids].filter((i) => !used.has(i))
console.log(`✓ app.js 引用的 ${used.size} 个 id 都存在`)
if (unused.length) console.log(`· HTML 里未被 app.js 使用的 id（可能由 CSS/其它脚本用）：${unused.join(', ')}`)
