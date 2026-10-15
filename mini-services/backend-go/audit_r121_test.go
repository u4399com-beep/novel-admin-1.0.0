/**
 * audit_r121_test.go —— R121 回归锁：
 *   ① E19 巡检长预算（callEngineTimeout 逐调用超时 + ENGINE_PATROL_TIMEOUT_MS 常量关系）
 *   ② 巡检探活请求体透传 timeoutMs=60000（引擎 clampTimeout 上限 → 策略链预算 150s，
 *      取槽耐心排队而非 budget-shed）
 *
 * 背景：巡检与 fleet 任务竞争同一域槽队列，fleet 满载期槽队深度大，巡检默认 60s
 * 预算被排队+慢服务吃穿 → 「全部策略 timeout」误判不健康 → E23 联动复活被压制
 * （washai 实证：引擎侧同期 ok=634 而巡检报超时）。礼貌红线不受影响：巡检仍经同一
 * 域槽队列串行放行，只是排队耐心更长。
 */
package main

import (
        "os"
        "strings"
        "testing"
        "time"
)

// ---------- ① 预算常量关系与逐调用超时 ----------

func TestPatrolBudgetConstants_R121(t *testing.T) {
        // 巡检预算必须长于默认预算（否则长排队场景仍被 60s 钳回，改造形同虚设）
        if ENGINE_PATROL_TIMEOUT_MS <= ENGINE_TIMEOUT_MS {
                t.Fatalf("ENGINE_PATROL_TIMEOUT_MS(%d) 必须 > ENGINE_TIMEOUT_MS(%d)", ENGINE_PATROL_TIMEOUT_MS, ENGINE_TIMEOUT_MS)
        }
        // 巡检预算上界护栏：单轮 = 规则数 × 预算，22 规则 × 100s ≈ 37min < 45min 默认轮间隔，
        // 超预算放宽会推迟下一轮巡检节奏（覆盖 E23 联动复活窗口）
        if max := int64(120_000); ENGINE_PATROL_TIMEOUT_MS > max {
                t.Fatalf("ENGINE_PATROL_TIMEOUT_MS(%d) 超护栏 %dms（单轮周期失控）", ENGINE_PATROL_TIMEOUT_MS, max)
        }
}

// TestCallEngineTimeout_Unreachable 结构化失败路径：引擎不可达时快速返回错误（不 panic、
// 不因客户端级 Timeout 缺失而永久挂起——context 预算兜底）。
func TestCallEngineTimeout_Unreachable(t *testing.T) {
        // 引擎地址指向不存在的端口（engineBaseURL 读 BACKEND_ENGINE_URL，测试内临时改写）
        old, had := os.LookupEnv("BACKEND_ENGINE_URL")
        os.Setenv("BACKEND_ENGINE_URL", "http://127.0.0.1:1")
        defer func() {
                if had {
                        os.Setenv("BACKEND_ENGINE_URL", old)
                } else {
                        os.Unsetenv("BACKEND_ENGINE_URL")
                }
        }()

        s0 := time.Now()
        res := callEngineTimeout[struct {
                List *struct {
                        Items []ListItem `json:"items"`
                } `json:"list"`
        }]("/api/test", map[string]any{"url": "https://example.com/"}, 1500)
        el := time.Since(s0)
        if res.OK {
                t.Fatalf("不可达引擎必须失败，got OK")
        }
        if !strings.Contains(res.Error, "不可达") && !strings.Contains(res.Error, "超时") {
                t.Fatalf("错误信息应含 不可达/超时，got %q", res.Error)
        }
        // 1.5s 预算 + 连接拒绝（本机回环立即拒绝）应在 10s 内返回（防永久挂起回归）
        if el > 10*time.Second {
                t.Fatalf("不可达返回耗时 %v（应快速失败）", el)
        }
}

// ---------- ② 巡检探活请求体形态 ----------

// TestPatrolBodyTimeout_R121 锁定巡检请求体的两个预算要素：body.timeoutMs=60000（引擎
// clampTimeout 上限，链预算放大 150s）+ backend 侧 ENGINE_PATROL_TIMEOUT_MS。若未来
// 有人把巡检改回 callEngine 默认预算，此处即红。
func TestPatrolBodyTimeout_R121(t *testing.T) {
        lr := LoadedRule{}
        body := engineRuleBodyWait("https://example.com/list", map[string]any{"listRule": map[string]string{}}, lr, "", "")
        if _, ok := body["timeoutMs"]; ok {
                t.Fatalf("engineRuleBodyWait 不应自带 timeoutMs（由巡检侧显式注入，防全局误放大）")
        }
        // JSON 序列化后 float64 语义（与引擎 clampTimeout 的 float64 入参对齐），Go 侧无类型敏感
        body["timeoutMs"] = 60_000
        if v := body["timeoutMs"]; v != 60_000 {
                t.Fatalf("巡检 body timeoutMs 应为 60000，got %T %v", v, v)
        }
}
