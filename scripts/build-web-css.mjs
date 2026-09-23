/**
 * build-web-css.mjs —— Tailwind CSS 构建管线（Go 页面层的样式来源）。
 *
 * 输入：mini-services/backend-go/web-src/tw-input.css
 *   - @import "tailwindcss"
 *   - @source 指向 Go 模板目录（web/templates/**）、静态资源（web/static/**）
 *     与渐变 token 表（web-src/gradient-tokens.txt，Task 27 起替代已删除的 src/lib/covers.ts）
 *     —— Tailwind v4 扫描这些文本文件里出现的类名生成最终 CSS
 * 输出：mini-services/backend-go/web/static/css/tw.css
 *
 * 运行：bun run build:css（模板或 JS 类名变更后需重新构建；scripts/build-go.sh 已内置本步）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'

const root = resolve(import.meta.dir, '..')
const IN = resolve(root, 'mini-services/backend-go/web-src/tw-input.css')
const OUT = resolve(root, 'mini-services/backend-go/web/static/css/tw.css')

const css = readFileSync(IN, 'utf8')
const result = await postcss([tailwindcss()]).process(css, { from: IN })
if (result.messages?.some((m) => m.type === 'dependency')) {
  // v4 插件可能声明依赖，忽略即可
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, result.css, 'utf8')
const kb = (Buffer.byteLength(result.css) / 1024).toFixed(1)
console.log(`[build-css] ${IN} → ${OUT} (${kb} KB)`)
