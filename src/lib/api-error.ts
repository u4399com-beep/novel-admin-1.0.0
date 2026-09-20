/**
 * API 路由共用的错误处理工具（服务端专用，勿在客户端 import）。
 */

/**
 * Prisma/底层错误的 message 首行（多行 message 的首行不含调用点源码路径，
 * 截断后放入响应 detail 可避免把 /home/z/... 服务器内部路径泄露给客户端）。
 */
export function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200)
}
