/**
 * 简/繁转换单例（基于 opencc-js）。
 * - 按方向动态 import 独立子包（opencc-js/cn2t 与 opencc-js/t2cn），只在首次使用时加载字典
 * - Converter 实例按方向缓存，全局单例复用
 * - 仅限客户端使用（DOM 翻译引擎在浏览器内运行）
 */

export type TradScript = 't' | 's'

type ConverterFn = (text: string) => string
type OpenCCLike = { Converter: (options: { from: string; to: string }) => ConverterFn }

const modules: Partial<Record<TradScript, Promise<OpenCCLike>>> = {}
const converters: Partial<Record<TradScript, ConverterFn>> = {}

function loadModule(target: TradScript): Promise<OpenCCLike> {
  if (!modules[target]) {
    const p =
      target === 't'
        ? import('opencc-js/cn2t') // 简 → 繁
        : import('opencc-js/t2cn') // 繁 → 简
    modules[target] = p.then((m: unknown) => {
      const mod = m as Partial<OpenCCLike> & { default?: OpenCCLike }
      const impl = typeof mod.Converter === 'function' ? mod : mod.default
      if (!impl || typeof impl.Converter !== 'function') {
        throw new Error('opencc-js 模块加载失败：未找到 Converter 导出')
      }
      return impl as OpenCCLike
    })
  }
  return modules[target]
}

/** 简体 → 繁体（OpenCC 基础词典 cn → t） */
export async function toTraditional(text: string): Promise<string> {
  const conv = await getConverter('t')
  return conv(text)
}

/** 简体 → 繁体（OpenCC 基础词典 t → cn） */
export async function toSimplified(text: string): Promise<string> {
  const conv = await getConverter('s')
  return conv(text)
}

/**
 * 获取（并缓存）指定方向的转换器。
 * 引擎在切换语言前会 await 此函数，保证字典就绪后再遍历 DOM。
 */
export async function getConverter(target: TradScript): Promise<ConverterFn> {
  const cached = converters[target]
  if (cached) return cached
  const mod = await loadModule(target)
  const conv =
    target === 't'
      ? mod.Converter({ from: 'cn', to: 't' })
      : mod.Converter({ from: 't', to: 'cn' })
  converters[target] = conv
  return conv
}

/** 读取已就绪的转换器（未加载返回 null），restore 阶段同步使用 */
export function peekConverter(target: TradScript): ConverterFn | null {
  return converters[target] ?? null
}
