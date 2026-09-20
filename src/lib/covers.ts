// 渐变封面系统：不依赖外部图片，用确定性渐变 + 首字生成封面
import { cn } from '@/lib/utils'

export const GRADIENT_CLASSES: Record<string, string> = {
  g1: 'from-rose-500 to-orange-400',
  g2: 'from-emerald-600 to-teal-400',
  g3: 'from-sky-600 to-cyan-400',
  g4: 'from-amber-600 to-yellow-400',
  g5: 'from-violet-600 to-fuchsia-400',
  g6: 'from-red-700 to-rose-500',
  g7: 'from-teal-700 to-emerald-400',
  g8: 'from-indigo-600 to-sky-400',
  g9: 'from-orange-600 to-amber-400',
  g10: 'from-cyan-700 to-blue-500',
  g11: 'from-fuchsia-600 to-pink-400',
  g12: 'from-lime-600 to-green-400',
}

/** 合法渐变 token 列表（g1-g12；入库校验/随机兜底与渲染层共用同一来源，防止两处清单漂移） */
export const COVER_TOKENS = Object.keys(GRADIENT_CLASSES)

export function gradientClass(token: string): string {
  return GRADIENT_CLASSES[token] ?? GRADIENT_CLASSES.g1
}

/** 封面容器 class：linear 渐变背景 */
export function coverBgClass(token: string): string {
  return cn('bg-gradient-to-br', gradientClass(token))
}
