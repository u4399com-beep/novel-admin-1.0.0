/**
 * audit_r116_test.go —— R116 稳定性三轮改造的回归锁：
 *   ① gLaneFloor 落盘持久化（重启不再清零：降档记忆 store→persist→清空内存→restore 复原）
 *   ② 只降不升语义在持久化路径保持（restore 只补空缺不覆盖更小值；store 取历史最小）
 *   ③ watchdog-services.sh 反脆弱静态护栏（连败闸/防抖/fd 泄漏修复在脚本文本层断言——
 *      bash 脚本无单测框架，以关键行为行存在性作最低限度防回归）
 *
 * 背景：R116 实测两大稳定性漏洞——
 *   a) backend 重启后 gLaneFloor（内存 sync.Map）清零 → 全部任务回软起步 4 车道重爬；
 *   b) watchdog flock fd 9 被 nohup 子进程继承，旧 watchdog 死亡后锁被存活的 backend-go
 *      长期持有 → 新 watchdog 永远拿不到锁 = 看护静默失效（本轮实证）。
 */
package main

import (
        "os"
        "path/filepath"
        "strings"
        "testing"
)

// ---------- ① gLaneFloor 落盘持久化 ----------

func TestLaneFloorPersistRoundtrip_R116(t *testing.T) {
        dir := t.TempDir()
        path := filepath.Join(dir, "lane-floors.json")
        t.Setenv("LANE_FLOOR_PATH", path)
        laneFloorPersistPath = path // init 时已按旧 env 求值，测试内显式对齐
        t.Cleanup(func() { laneFloorPersistPath = "/tmp/backend-lane-floors.json" })

        // 降档写入（脏标记置位）
        laneFloorStore(991001, 4)
        laneFloorStore(991002, 2)
        if !laneFloorDirty.Load() {
                t.Fatal("laneFloorStore 成功写入后 laneFloorDirty 应置位（持久化循环依赖）")
        }
        // 落盘（清脏是 laneFloorPersistLoop 的职责；本测直调只验证快照写盘）
        if n := persistLaneFloors(); n != 2 {
                t.Fatalf("persistLaneFloors = %d, want 2", n)
        }
        if _, err := os.Stat(path); err != nil {
                t.Fatalf("落盘文件不存在: %v", err)
        }

        // 模拟重启：清空内存态 + 脏标记复位
        gLaneFloor.Delete(991001)
        gLaneFloor.Delete(991002)
        laneFloorDirty.Store(false)

        // 恢复
        if n := restoreLaneFloors(); n != 2 {
                t.Fatalf("restoreLaneFloors = %d, want 2", n)
        }
        if got := laneFloorLoad(991001); got != 4 {
                t.Fatalf("恢复后 laneFloorLoad(991001) = %d, want 4", got)
        }
        if got := laneFloorLoad(991002); got != 2 {
                t.Fatalf("恢复后 laneFloorLoad(991002) = %d, want 2", got)
        }
        // 清理测试键，防泄漏到同进程其他测试
        gLaneFloor.Delete(991001)
        gLaneFloor.Delete(991002)
}

// ---------- ② 持久化与只降不升语义协同 ----------

func TestLaneFloorPersistMinSemantics_R116(t *testing.T) {
        dir := t.TempDir()
        path := filepath.Join(dir, "lane-floors-min.json")
        old := laneFloorPersistPath
        laneFloorPersistPath = path
        t.Cleanup(func() { laneFloorPersistPath = old })

        // 降档到 2 → 试图升回 4（应被拒，保持 2）
        laneFloorStore(991003, 2)
        laneFloorStore(991003, 4)
        if got := laneFloorLoad(991003); got != 2 {
                t.Fatalf("只降不升被破坏: laneFloorLoad = %d, want 2", got)
        }
        if n := persistLaneFloors(); n != 1 {
                t.Fatalf("persistLaneFloors = %d, want 1", n)
        }
        // restore 到已有更小值的键：LoadOrStore 语义=不覆盖（仍是 2）
        if n := restoreLaneFloors(); n != 0 {
                t.Fatalf("对已存在键 restore 不应计数，got %d", n)
        }
        if got := laneFloorLoad(991003); got != 2 {
                t.Fatalf("restore 不覆盖语义被破坏: laneFloorLoad = %d, want 2", got)
        }
        // 空快照（无文件）恢复 = 0，冷启动正常路径
        if n := restoreLaneFloorsAt(filepath.Join(dir, "nonexistent.json")); n != 0 {
                t.Fatalf("无快照文件 restore = %d, want 0", n)
        }
        gLaneFloor.Delete(991003)
}

// ---------- ③ watchdog 反脆弱静态护栏 ----------

func TestWatchdogScriptAntiFragility_R116(t *testing.T) {
        data, err := os.ReadFile("../../scripts/watchdog-services.sh")
        if err != nil {
                t.Skipf("watchdog 脚本不可读（工作树外运行）: %v", err)
        }
        s := string(data)
        for _, kw := range []string{
                "FAIL_STRIKES=2",               // 连败闸（一次超时不再立即重启）
                "RESTART_COOLDOWN_S=60",        // 重启防抖
                "PROBE_TIMEOUT_STEALTH=8",      // stealth 探活 8s（GIL/浏览器忙时 /health 慢）
                "watchdog-services-v2.lock",    // 锁文件 v2（旧锁被存量进程继承 fd 钉死）
                "9>&-",                         // spawn 子进程关闭 flock fd（fd 泄漏根修）
                "MemAvailable",                 // 内存水位观测（OOM 取证）
        } {
                if !strings.Contains(s, kw) {
                        t.Errorf("watchdog 脚本缺少 R116 反脆弱关键要素 %q（防回归护栏）", kw)
                }
        }
}

// ---------- ④ engineEnvPrefix 引擎 env 单一来源 ----------

func TestEngineEnvPrefix_R116(t *testing.T) {
        dir := t.TempDir()
        oldRoot := engineEnvRootForTest
        engineEnvRootForTest = func() string { return dir }
        t.Cleanup(func() { engineEnvRootForTest = oldRoot })
        envPath := filepath.Join(dir, "scripts", "engine.env")
        if err := os.MkdirAll(filepath.Dir(envPath), 0o700); err != nil {
                t.Fatal(err)
        }

        // 正常文件：注释/空行跳过，合法行拼接为 env 前缀
        if err := os.WriteFile(envPath, []byte(
                "# 注释行\n\nSCRAPE_PROXY_BUCKET_HOSTS=www.trxsw.com:3,www.biqutu.info:4\n"), 0o600); err != nil {
                t.Fatal(err)
        }
        got := engineEnvPrefix()
        if got != "env SCRAPE_PROXY_BUCKET_HOSTS=www.trxsw.com:3,www.biqutu.info:4 " {
                t.Fatalf("engineEnvPrefix = %q", got)
        }

        // 注入防线：值含空格/引号/分号的行整行拒用
        if err := os.WriteFile(envPath, []byte(
                "FOO=aa; rm -rf /\nBAR=has space\nOK=value_ok\n"), 0o600); err != nil {
                t.Fatal(err)
        }
        if got := engineEnvPrefix(); got != "env OK=value_ok " {
                t.Fatalf("注入防线失效: engineEnvPrefix = %q", got)
        }

        // 文件缺失：空前缀（回退旧行为，不阻塞拉起）
        if err := os.Remove(envPath); err != nil {
                t.Fatal(err)
        }
        if got := engineEnvPrefix(); got != "" {
                t.Fatalf("无文件应得空前缀，got %q", got)
        }
}
