/**
 * 临时验证用假小说站（端口 3999）—— 仅在 13-b 验证脚本内启动，测完即删。
 * 提供一本书（12 章）+ 单章正文页，结构与规则选择器对应。
 */
const BOOK = `<!doctype html><html><head><meta charset="utf-8"><title>沙盒测试之书 - 假站</title></head><body>
<div id="info">
  <h1>沙盒测试之书</h1>
  <p class="author">作者：测试作者</p>
  <div id="intro">这是一本用于验证采集管线的测试书籍，内容全部为占位文字。</div>
</div>
<dl id="list">${Array.from({ length: 12 }, (_, i) => `<dd><a href="/chapter/${i + 1}">第${i + 1}章 测试章节${i + 1}</a></dd>`).join('')}</dl>
</body></html>`

function chapter(n: number): string {
  const paras = Array.from(
    { length: 5 },
    (_, i) => `<p>这是第${n}章的第${i + 1}个段落，内容用于字数统计与清洗验证。</p>`,
  ).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>第${n}章 - 假站</title></head><body>
<h1>第${n}章 测试章节${n}</h1>
<div id="content">${paras}<br>本书来自假站测试服务器，请记住本站 www.fake-novel.test。</div>
</body></html>`
}

Bun.serve({
  port: 3999,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/book/1') {
      return new Response(BOOK, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const m = /^\/chapter\/(\d+)$/.exec(url.pathname)
    if (m) {
      return new Response(chapter(Number(m[1])), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    return new Response('not found', { status: 404 })
  },
})
console.log('[fake-site] listening on http://127.0.0.1:3999')
