/**
 * 采集封面落盘（服务端专用）：下载远程封面 → sharp 规范化 → 转存 webp 到 public/covers/。
 *
 * 存储契约（与渲染层 src/components/novel-cover.tsx 约定）：
 * - Novel.cover = 渐变 token（g1-g12，无图时的确定性渐变封面）或
 *   本地封面路径（`/covers/{novelId}.webp`，采集到远程封面后落盘）
 *
 * 安全与健壮性：
 * - SSRF 防护：仅 http/https；拒绝内网/环回/链路本机地址（文本层 + DNS 尽力解析）
 * - 内容校验：Content-Type 以 image/ 开头（octet-stream 交由 sharp 解码兜底），
 *   体积上限 MAX_COVER_BYTES；sharp 解码失败即拒绝
 * - 规范化输出：最长边 ≤ 512、webp q80（封面显示尺寸远小于此，兼顾清晰与体积）
 * - 幂等：目标文件已存在直接复用（重复采集同一本书不重复下载）
 * - 失败一律返回 null，绝不阻塞采集主流程（书籍仍以渐变 token 封面入库）
 */
import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'
import sharp from 'sharp'
import { fetch as undiciFetch, ProxyAgent } from 'undici' // undici 8：ProxyAgent 支持 proxyTunnel:false（绝对 URI 形态，兼容免费代理）

const PUBLIC_DIR = path.join(process.cwd(), 'public')
const COVERS_DIR = path.join(PUBLIC_DIR, 'covers')
const LOCAL_PREFIX = '/covers/'

const MAX_COVER_BYTES = 5 * 1024 * 1024
const DL_TIMEOUT_MS = 12_000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 判断 cover 值是否为本地封面路径（渲染层与入库层共用） */
export function isLocalCoverPath(cover: string | null | undefined): boolean {
  return typeof cover === 'string' && cover.startsWith(LOCAL_PREFIX)
}

/** 私有/环回/链路本机地址文本层校验（含十进制、八进制、点分变体的粗防） */
function isPrivateIp(host: string): boolean {
  if (!host) return true
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  const v4m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4m) {
    const [a, b, c, d] = v4m.slice(1).map(Number)
    if ([a, b, c, d].some((n) => n > 255)) return true
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    return false
  }
  // IPv6 一般形态：全部拒绝（小说封面图床均为公网 v4/域名）
  if (h.includes(':')) return true
  return false
}

/** SSRF 校验：文本层 + DNS 尽力解析（解析失败视为不可达拒绝） */
async function assertPublicHttpUrl(rawUrl: string): Promise<URL | null> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (isPrivateIp(u.hostname)) return null
  try {
    const recs = await dnsLookup(u.hostname, { all: true, verbatim: true })
    if (!recs.length) return null
    for (const r of recs) {
      if (isPrivateIp(r.address)) return null
    }
  } catch {
    return null // DNS 解析失败：域名不可达，放弃下载
  }
  return u
}

/**
 * 站点级代理池（与引擎同语义：逗号分隔多代理，取首个 http(s) 代理；socks 形态由 undici ProxyAgent 不支持而忽略）。
 * 图床通常与目标站同域/同一封锁策略：站点经代理采集时，封面下载也必须经同一出口。
 */
function pickCoverProxy(proxy: string | null | undefined): string | null {
  if (!proxy) return null
  for (const p of proxy.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (p.startsWith('http://') || p.startsWith('https://')) return p
  }
  return null
}

/**
 * 下载远程封面并落盘为 webp。
 * 返回本地路径（`/covers/{novelId}.webp`）；任何失败返回 null（调用方保持渐变 token）。
 * 已存在本地文件时幂等复用（不重复下载）。
 * proxy：站点级出口代理（规则配置，http(s) 形态）——被封锁站点的图床也需经同一出口访问。
 */
export async function fetchAndStoreCover(
  novelId: number,
  remoteUrl: string,
  proxy?: string | null,
): Promise<string | null> {
  const localAbs = path.join(COVERS_DIR, `${novelId}.webp`)
  const localPath = `${LOCAL_PREFIX}${novelId}.webp`
  try {
    const existing = await stat(localAbs).catch(() => null)
    if (existing && existing.isFile() && existing.size > 0) return localPath

    const url = await assertPublicHttpUrl(remoteUrl)
    if (!url) return null

    const proxyUrl = pickCoverProxy(proxy)
    // http 目标走绝对 URI（proxyTunnel:false，与 curl 行为一致；不少廉价代理拒绝 CONNECT 隧道）；
    // https 目标仍走 CONNECT 隧道（代理拒绝时封面下载失败，回落渐变封面，不阻塞采集）
    const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, proxyTunnel: false }) : undefined
    const res = await undiciFetch(url, {
      headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', referer: `${url.protocol}//${url.host}/` },
      signal: AbortSignal.timeout(DL_TIMEOUT_MS),
      redirect: 'follow',
      ...(dispatcher ? { dispatcher } : {}),
    } as Parameters<typeof undiciFetch>[1]).catch(() => null)
    if (!res || !res.ok) return null
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
    if (ctype && !ctype.startsWith('image/') && !ctype.includes('octet-stream')) return null

    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.byteLength || buf.byteLength > MAX_COVER_BYTES) return null

    // sharp 解码 + 规范化：解码失败（伪装成图片的 HTML/攻击载荷）在此拒绝
    const webp = await sharp(buf, { failOn: 'error' })
      .rotate() // 依 EXIF 方向归正
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()
      .catch(() => null)
    if (!webp || webp.byteLength < 64) return null

    await mkdir(COVERS_DIR, { recursive: true })
    const tmpAbs = path.join(COVERS_DIR, `.${createHash('md5').update(String(novelId)).digest('hex').slice(0, 8)}.tmp`)
    await writeFile(tmpAbs, webp)
    // rename 覆盖：避免并发采集写一半被读到坏图
    const { rename } = await import('node:fs/promises')
    await rename(tmpAbs, localAbs).catch(async () => {
      await writeFile(localAbs, webp)
    })
    return localPath
  } catch {
    return null
  }
}

/** 派生渐变 token（无封面时的确定性回退）：以书名+作者 hash 均匀分布到 g1-g12 */
export function gradientTokenFor(title: string, author: string): string {
  const h = createHash('md5').update(`${title}\u0000${author}`).digest()
  return `g${(h[0] % 12) + 1}`
}
