/**
 * backend-go 进程看护（Go 迁移 Task 18）。
 *
 * 环境实证（Task 16-b / watchdog.ts）：本沙箱会周期性静默回收「由 bash 会话直接派生」
 * 的后台进程（setsid 也不保险），只有挂在长寿进程上的进程才稳定。Next dev server 由
 * dev-supervisor 循环守护、被实证长寿——因此 backend-go 的生命周期挂在这里：
 *
 * - ensureBackendGo()：模块级幂等拉起（首次 API 请求时自动执行；进程消失后由代理层
 *   502 兜底重拉，见 catch-all route.ts）
 * - 拉起方式：node child_process spawn detached + unref（与 runner 互监护同款托孤语义）
 * - BACKEND_MODE=all：API + 采集 runner 同进程（runner 轮询/心跳/引擎互监护内置），
 *   只需看护一个进程
 *
 * 注意：本文件只在服务端运行（route handler 内调用），不会进入客户端 bundle。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'

const gSup = globalThis as unknown as {
  __backendGoPid?: number
  __backendGoLastSpawn?: number
}

const BACKEND_DIR = '/home/z/my-project/mini-services/backend-go'
const RESPAWN_COOLDOWN_MS = 5_000

/** runner 心跳文件（与 TS runner / backend-go runner 三代共用同一路径） */
const HEARTBEAT_FILE = '/tmp/scrape-runner-heartbeat'

/**
 * 确认 backend-go 进程存活；不存活则重新拉起（带冷却）。
 * 存活判据：/proc/{pid} 存在且 cmdline 含 backend-go.bin；pid 未知时退化用心跳+端口探测。
 */
export function ensureBackendGo(): void {
  if (gSup.__backendGoPid && backendAlive(gSup.__backendGoPid)) return
  const now = Date.now()
  if (gSup.__backendGoLastSpawn && now - gSup.__backendGoLastSpawn < RESPAWN_COOLDOWN_MS) return
  gSup.__backendGoLastSpawn = now

  const pid = spawnBackendGo()
  if (pid > 0) gSup.__backendGoPid = pid
}

function backendAlive(pid: number): boolean {
  return readCmdline(pid).includes('backend-go.bin')
}

function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
  } catch {
    return ''
  }
}

/**
 * 拉起 backend-go（detached 托孤）。返回子进程 pid（失败返回 0）。
 * all 模式：API(:3005) + 采集 runner（轮询/心跳/引擎互监护/慢速归类）同进程。
 */
function spawnBackendGo(): number {
  try {
    // 启动前刷新心跳文件：防止下一轮 watchdog/ensure-services 误判 runner 已死而拉起 TS 旧 runner
    const now = new Date()
    if (existsSync(HEARTBEAT_FILE)) utimesSync(HEARTBEAT_FILE, now, now)
    else writeFileSync(HEARTBEAT_FILE, now.toISOString())

    const child = spawn(
      'bash',
      ['-c', `cd ${BACKEND_DIR} && exec ./backend-go.bin`],
      {
        env: { ...process.env, BACKEND_PORT: '3005', BACKEND_MODE: 'all' },
        detached: true,
        stdio: 'ignore',
      },
    )
    child.unref()
    return child.pid ?? 0
  } catch {
    return 0
  }
}
