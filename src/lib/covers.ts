/**
 * 渐变封面 token 表（g1-g12）—— Tailwind 构建的内容源。
 *
 * 本文件已无运行时角色（React 前端随 Task 24 退役），保留唯一原因：
 * mini-services/backend-go/web-src/tw-input.css 通过 @source 指向本文件，
 * build:css 扫描下表字符串生成 from-xx/to-xx 渐变工具类。
 * Go 侧实际用法：web.go gradientTokenClass 产出 g1-g12 类名，实体样式在
 * web/static/css/cover-gradients.css（色值与下表一一对应，改动需双侧同步）。
 */
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

export function gradientClass(token: string): string {
  return GRADIENT_CLASSES[token] ?? GRADIENT_CLASSES.g1
}
