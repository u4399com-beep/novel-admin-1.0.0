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

/** 点分 IPv4（含变体粗防）是否私有/保留段。调用方须保证 h 为点分四段形态或先判别。 */
function isPrivateV4(h: string): boolean {
  const v4m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!v4m) return false // 非点分形态交由调用方处理（域名字面量放行，DNS 结果层再校验实际 IP）
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

/**
 * IPv6 是否私有/保留段：环回(::1)/未指定(::)/ULA(fc00::/7)/链路本地(fe80::/10)，
 * 以及内嵌 IPv4 的映射地址（::ffff:x.x.x.x 等，按 v4 规则复检）。
 * 公网 IPv6（CDN 双栈图床普遍有 AAAA 记录）不在拒绝之列。
 */
function isPrivateV6(raw: string): boolean {
  const a = raw.toLowerCase().replace(/^\[|\]$/g, '')
  if (a === '::1' || a === '::') return true
  if (a.startsWith('fc') || a.startsWith('fd')) return true // ULA fc00::/7
  if (/^fe[89ab]/.test(a)) return true // 链路本地 fe80::/10
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a)
  if (mapped) return isPrivateV4(mapped[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isPrivateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  return false
}

/** 私有/环回/链路本机地址校验（主机名字面量与 DNS 解析结果共用）：私有段/内网变体拒绝，公网 v4/v6 放行 */
function isPrivateIp(host: string): boolean {
  if (!host) return true
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h.includes(':')) return isPrivateV6(h) // IPv6 字面量/解析地址
  return isPrivateV4(h)
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
 * 站点级代理池（与引擎同语义：逗号分隔多代理，取全部 http(s) 代理按序尝试）。
 * 图床通常与目标站同域/同一封锁策略：站点经代理采集时，封面下载也必须经同一出口。
 * 免费公共代理单点易失效：池内逐个轮试，单个代理抖动不致整个封面落盘失败。
 */
function pickCoverProxies(proxy: string | null | undefined): string[] {
  if (!proxy) return []
  return proxy
    .split(',')
    .map((s) => s.trim())
    .filter((p) => p.startsWith('http://') || p.startsWith('https://'))
}

/**
 * 下载远程封面并落盘为 webp。
 * 返回本地路径（`/covers/{novelId}.webp`）；任何失败返回 null（调用方保持渐变 token）。
 * 已存在本地文件时幂等复用（不重复下载）。
 * proxy：站点级出口代理池（规则配置，逗号分隔 http(s)）——被封锁站点的图床也需经同一出口访问，
 * 池内代理逐个轮试（免费公共代理单点易失效）。
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

    // 下载（含代理池轮试）：无代理配置时单次直连；配置了代理则仅经代理出口（图床与站点同封锁策略，
    // 直连大概率同样不可达，且多一次无谓暴露）；https 经代理失败时不降级 http——图床 URL 通常
    // 同站双协议可达，降级交给上层回填端点用原始 remoteCoverUrl 重试即可。
    const proxies = pickCoverProxies(proxy)
    const buf = await downloadCoverBytes(url, proxies)
    if (!buf) return null

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

/**
 * 下载封面二进制（代理池轮试）：无代理时直连单次；有代理时逐个出口尝试。
 * 全部失败返回 null（不区分错误原因，调用方仅关心结果）。
 */
async function downloadCoverBytes(url: URL, proxies: string[]): Promise<Buffer | null> {
  const attempts: Array<string | null> = proxies.length > 0 ? proxies : [null]
  for (const proxyUrl of attempts) {
    // http 目标走绝对 URI（proxyTunnel:false，与 curl 行为一致；不少廉价代理拒绝 CONNECT 隧道）；
    // https 目标经 undici ProxyAgent 转发（实测常见免费 http 代理对图片 https 目标同样可达）
    const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, proxyTunnel: false }) : undefined
    try {
      const res = await undiciFetch(url, {
        headers: {
          'user-agent': UA,
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          referer: `${url.protocol}//${url.host}/`,
        },
        signal: AbortSignal.timeout(DL_TIMEOUT_MS),
        redirect: 'follow',
        ...(dispatcher ? { dispatcher } : {}),
      } as Parameters<typeof undiciFetch>[1])
      if (!res || !res.ok) continue
      const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
      if (ctype && !ctype.startsWith('image/') && !ctype.includes('octet-stream')) continue

      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.byteLength || buf.byteLength > MAX_COVER_BYTES) continue
      return buf
    } catch {
      continue // 本出口失败（超时/拒绝/网络错误）→ 尝试下一个代理
    }
  }
  return null
}

/** 派生渐变 token（无封面时的确定性回退）：以书名+作者 hash 均匀分布到 g1-g12 */
export function gradientTokenFor(title: string, author: string): string {
  const h = createHash('md5').update(`${title}\u0000${author}`).digest()
  return `g${(h[0] % 12) + 1}`
}
