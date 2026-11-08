/**
 * backupx.go —— 数据库自动备份（R135 P1 运营整改，operations-readiness §G 第一件）。
 *
 * 背景：deployment.md §备份有现成 cron 命令但从未启用（沙箱无 crontab；
 * 新服务器需手工配）——有备份方案≠有备份。此处内建循环，进程自包含零依赖，
 * 与 fleetkeeper/rulehealth 同模式；新服务器可二选一（cron 或本循环）。
 *
 * 机制：
 *   - VACUUM INTO 'file'：SQLite 3.27+ 原子快照导出（一致性+压缩+免锁复制三合一，
 *     比 .backup 简单，比裸 cp 三件套安全——WAL 复制窗口的撕裂风险不存在）
 *   - 12h/轮（BACKUP_INTERVAL_H 可调 [1,168]；BACKUP_OFF=1 停用）
 *   - boot 后 90s 跑首轮（重启即有当日备份兜底），之后按间隔循环
 *   - 保留最近 BACKUP_KEEP（默认 7）份，超出删最旧
 *   - 目录 DB_BACKUP_DIR（缺省 <db 目录>/backups），文件名 novel-YYYYMMDD-HHMMSS.db
 *   - 单飞闸防重叠；失败只记日志不告警退出（备份失败不应拖垮主服务；
 *     运营态可由告警 webhook 消费该日志——P1 联动点已留 audit 注释）
 *
 * 恢复演练口径（deployment.md §备份）：备份是普通 SQLite 文件，停服后
 * cp 覆盖 custom.db（或改名)即可；VACUUM INTO 产物无 WAL 伴生文件。
 */
package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"
)

// backupOnce 单飞闸（防上轮未完成下轮又启动）
var backupRunning atomic.Bool

// startBackupLoop 备份循环（main.go runner/all 模式挂载）
func startBackupLoop() {
	if strings.TrimSpace(os.Getenv("BACKUP_OFF")) != "" {
		log.Printf("[backup] BACKUP_OFF=1，自动备份停用（deployment.md §备份 cron 方案可替代）")
		return
	}
	intervalH := envInt("BACKUP_INTERVAL_H", 12)
	if intervalH < 1 {
		intervalH = 1
	}
	if intervalH > 168 {
		intervalH = 168
	}
	go func() {
		// boot 后 90s 首轮（避开启动风暴：播种/巡检/舰队重建都挤在 0-60s）
		time.Sleep(90 * time.Second)
		runBackupCycle("boot")
		for {
			time.Sleep(time.Duration(intervalH) * time.Hour)
			runBackupCycle("cycle")
		}
	}()
	log.Printf("[backup] 自动备份已启用：间隔 %dh，保留 %d 份，目录 %s",
		intervalH, envInt("BACKUP_KEEP", 7), backupDir())
}

// backupDir 备份目录（缺省 <db 目录>/backups）
func backupDir() string {
	if v := strings.TrimSpace(os.Getenv("DB_BACKUP_DIR")); v != "" {
		return v
	}
	return filepath.Join(filepath.Dir(dbPath()), "backups")
}

// runBackupCycle 单轮备份：VACUUM INTO 原子快照 + 老份清理。
// trigger 仅用于日志区分 boot/cycle。
// 快照用独立连接（不走共享池）：①VACUUM INTO 导出期间独占连接数百 ms～秒级，
// 共享池仅 4 连接，占用会挤压 runner/查询面；②测试环境 getDB 已缓存他库连接，
// 独立连接以 dbPath() 实时解析，语义「备份 dbPath 指向的库」更精确。
func runBackupCycle(trigger string) {
	if !backupRunning.CompareAndSwap(false, true) {
		return
	}
	defer backupRunning.Store(false)
	start := time.Now()
	dir := backupDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[backup] 建目录失败 %s: %v", dir, err)
		return
	}
	name := fmt.Sprintf("novel-%s.db", time.Now().Format("20060102-150405"))
	dest := filepath.Join(dir, name)
	// R136 吸收：先写 .tmp 再原子 rename——快照失败/中途崩溃不残留半成品，
	// 恢复演练方（scripts/verify-backup-r136.sh）永远不会捡到撕裂副本。
	// .db.tmp 不匹配 pruneOldBackups 的 novel-*.db 前缀过滤，天然免于误清理。
	tmp := dest + ".tmp"
	_ = os.Remove(tmp)
	// VACUUM INTO：目标文件必须不存在（SQLite 语义），原子完成快照。
	// 源侧只读快照：journal_mode 保持默认（导出连接不做写者）、busy_timeout 5s 与主连接同口径
	src := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)", dbPath())
	sdb, err := sql.Open("sqlite", src)
	if err != nil {
		log.Printf("[backup] 快照连接失败（%s）: %v", trigger, err)
		return
	}
	_, err = sdb.Exec("VACUUM INTO ?", tmp)
	_ = sdb.Close()
	if err != nil {
		log.Printf("[backup] 快照失败（%s）: %v", trigger, err)
		os.Remove(tmp)
		return
	}
	if err := os.Rename(tmp, dest); err != nil {
		log.Printf("[backup] 快照原子改名失败（%s → %s）: %v", tmp, dest, err)
		return
	}
	sz, _ := os.Stat(dest)
	removed := pruneOldBackups(dir, envInt("BACKUP_KEEP", 7))
	log.Printf("[backup] 快照完成（%s）: %s（%.1f MB，耗时 %s，清理旧份 %d 个）",
		trigger, dest, float64(sz.Size())/1024/1024, time.Since(start).Round(time.Millisecond), removed)
}

// pruneOldBackups 按保留数清理最旧备份；返回清理个数。
// 文件名 novel-*.db 字典序=时间序（时间戳零填充），直接排序即年龄序。
func pruneOldBackups(dir string, keep int) int {
	if keep <= 0 {
		keep = 7
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "novel-") && strings.HasSuffix(e.Name(), ".db") {
			files = append(files, e.Name())
		}
	}
	if len(files) <= keep {
		return 0
	}
	sort.Strings(files) // 字典序升序=最旧在前
	removed := 0
	for _, f := range files[:len(files)-keep] {
		if err := os.Remove(filepath.Join(dir, f)); err == nil {
			removed++
		}
	}
	return removed
}
