package main

// audit59d_test.go —— Task 59-R5 种子基建知识固化测试。
//
// 病灶：Task 58 为直连 SYN 黑洞站（huangjinwu/xinjianpan）PUT 的代理出口池只存 DB，
// 沙箱回收/DB 重建后 seed 重新播种 proxy='' → 黑洞站规则断链，需人工重建出口池。
// 锁定契约：seed.json 中黑洞站规则必须携带非空代理池（基建知识随二进制分发，
// 重建设置自动恢复采集能力）。
import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSeedBlackholeRulesCarryProxyPool(t *testing.T) {
	raw := seedBlob
	if len(raw) == 0 {
		t.Fatal("seed.json 为空")
	}
	var seed struct {
		Rules []struct {
			ID    int64  `json:"id"`
			Name  string `json:"name"`
			Proxy string `json:"proxy"`
		} `json:"rules"`
	}
	if err := json.Unmarshal(raw, &seed); err != nil {
		t.Fatalf("unmarshal seed.json: %v", err)
	}
	// 直连 SYN 黑洞站（沙箱网络拓扑实证，见 docs/anti-anti-crawl.md）：seed 必须携带代理池
	blackhole := map[int64]string{13: "huangjinwu", 15: "xinjianpan"}
	found := map[int64]bool{}
	for _, r := range seed.Rules {
		if want, ok := blackhole[r.ID]; ok {
			found[r.ID] = true
			if r.Name != want {
				t.Fatalf("seed 规则 #%d 名称漂移: got %q want %q", r.ID, r.Name, want)
			}
			if strings.TrimSpace(r.Proxy) == "" {
				t.Fatalf("seed 规则 #%d (%s) proxy 为空——黑洞站基建知识丢失，DB 重建后规则将断链", r.ID, want)
			}
			for _, p := range strings.Split(r.Proxy, ",") {
				if !strings.Contains(p, "://") {
					t.Fatalf("seed 规则 #%d 代理形态缺 scheme: %q（规则 API 会 400）", r.ID, p)
				}
			}
		}
	}
	for id, name := range blackhole {
		if !found[id] {
			t.Fatalf("seed 缺失黑洞站规则 #%d (%s)", id, name)
		}
	}
}
