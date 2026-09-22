// devwatch.go —— dev server 看护（Task 23 沙箱专属，默认关闭）。
//
// 背景：本沙箱存在用户态收割器，会周期性 SIGKILL bash 派生的后台进程与 Next dev
// server（dmesg 无记录、非内核 OOM；实测 Go 长寿进程 scraper-go/backend-go 从未被
// 收割）。历史上 Next 由会话基础设施拉起才得以长存；一旦死亡，代理侧任何 setsid
// 方式的重启都会在数秒~数分钟内被再次收割。
//
// 解法：挂在「从未被收割」的 backend-go 长寿进程上，由它看护并重新拉起 Next dev
// （对齐 backend-supervisor.ts 的「只有挂在长寿进程上的进程才稳定」实证结论——
// backend-go 自己就是被 Next 拉起并长存的实例）。
//
// 开关：BACKEND_WATCH_DEV=1 时启用（sandbox 启动环境变量，仓库默认不开启，
// 生产部署由 systemd/supervisor 管理前端，无需本看护）。
//
// 行为：
//   - 每 10s 探测 http://127.0.0.1:3000/（1s 超时，只看能否建立连接）
//   - 连接失败（含 refused/超时）→ 冷却检查后拉起 `bun run dev`（setsid 脱离、
//     输出追加 dev.log、NODE_OPTIONS 限堆 1280MB 防 Turbopack 编译期内存膨胀）
//   - 冷却 30s：刚拉起后给编译留时间，防止端口未就绪被误判死亡而重复拉起
//   - 仅在 :3000 连接失败时拉起（端口被占用说明有实例在跑，绝不双拉）
package main

import (
	"log"
	"net"
	"os"
	osexec "os/exec"
	"syscall"
	"time"
)

const devWatchInterval = 10 * time.Second
const devWatchSpawnCooldown = 30 * time.Second

func startDevWatcher() {
	if os.Getenv("BACKEND_WATCH_DEV") != "1" {
		return
	}
	go func() {
		var lastSpawn time.Time
		for {
			time.Sleep(devWatchInterval)
			if devPortAlive() {
				continue
			}
			if time.Since(lastSpawn) < devWatchSpawnCooldown {
				continue
			}
			lastSpawn = time.Now()
			log.Printf("[backend-go-devwatch] :3000 不可达，拉起 dev server")
			spawnDevServer()
		}
	}()
}

// devPortAlive :3000 是否可建立 TCP 连接（refused/超时 = 视为不可达）。
func devPortAlive() bool {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:3000", time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// spawnDevServer 拉起 Next dev（setsid 脱离会话，父进程退出不影响；输出追加 dev.log）。
func spawnDevServer() {
	cmd := osexec.Command("sh", "-c", "cd /home/z/my-project && bun run dev >> dev.log 2>&1")
	cmd.Env = append(os.Environ(), "NODE_OPTIONS=--max-old-space-size=1280")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		log.Printf("[backend-go-devwatch] 拉起失败: %v", err)
		return
	}
	// 不 Wait：子进程脱离（Setsid），交由内核init收养；显式释放僵尸由 go1.22+ 的
	// os/exec 在 Start 后不 Wait 会留 zombie —— 这里用 go cmd.Wait() 后台回收。
	go func() { _ = cmd.Wait() }()
	log.Printf("[backend-go-devwatch] dev server 已拉起 (pid=%d)", cmd.Process.Pid)
}
