/**
 * API 路由共用的错误消息工具。
 */

/**
 * 取错误消息首行并 200 字截断。
 * Prisma 错误的 message 首行不含调用点源码路径（后续行才含 /home/... 等内部路径），
 * 把完整 message 原样返回客户端会泄露服务器内部路径——所有 5xx 的 detail 均应过本函数。
 */
export function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200)
}
