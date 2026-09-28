/**
 * ruletest —— 采集规则三段试测工具（Go 版，Task 58 起替代已拆除的 engine-rule-test.mjs）。
 *
 * 从 backend（:3000 /api/scrape-rules）读指定规则，按 engineRuleBody 同构契约
 * （url/rule.{list|book|chapter}Rule/charset/proxy/insecureTLS/cookies）向引擎
 * （:3030 /api/test）发抓取请求并打印提取摘要，用于规则校准/排障（对齐
 * docs/scrape-rules.md 的三段实测流程）。
 *
 * 用法：
 *   cd mini-services/scraper-go && go run ./cmd/ruletest <规则名或ID> <URL> [list|book|chapter]
 * 例：
 *   go run ./cmd/ruletest aijjxs "https://aijjxs.com" list
 * 前置：backend :3000 在线；引擎 :3030 在线（BACKEND_URL/ENGINE_URL 可覆盖默认值）。
 */
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

type rule struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	SiteURL     string `json:"siteUrl"`
	Enabled     bool   `json:"enabled"`
	Charset     string `json:"charset"`
	Proxy       string `json:"proxy"`
	InsecureTLS bool   `json:"insecureTLS"`
	Cookies     string `json:"cookies"`
	ListRule    any    `json:"listRule"`
	BookRule    any    `json:"bookRule"`
	ChapterRule any    `json:"chapterRule"`
}

type segKey string

const (
	segList    segKey = "list"
	segBook    segKey = "book"
	segChapter segKey = "chapter"
)

type attempt struct {
	Strategy string `json:"strategy"`
	Profile  string `json:"profile"`
	OK       bool   `json:"ok"`
	Status   int    `json:"status"`
	Note     string `json:"note"`
}

type testResp struct {
	OK        bool              `json:"ok"`
	Error     string            `json:"error"`
	Detail    string            `json:"detail"`
	Strategy  string            `json:"strategy"`
	Warnings  []string          `json:"warnings"`
	Attempts  []attempt         `json:"attempts"`
	Data      map[string]any    `json:"data"`
	FinalURL  string            `json:"finalURL"`
	Challenge bool              `json:"softBlock"`
	Raw       map[string]string `json:"-"`
}

func main() {
	backend := envOr("BACKEND_URL", "http://127.0.0.1:3000")
	engine := envOr("ENGINE_URL", "http://127.0.0.1:3030")

	args := os.Args[1:]
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "用法: go run ./cmd/ruletest <规则名或ID> <URL> [list|book|chapter]")
		os.Exit(2)
	}
	name, u := args[0], args[1]
	seg := segList
	if len(args) >= 3 {
		seg = segKey(args[2])
	}
	if seg != segList && seg != segBook && seg != segChapter {
		fmt.Fprintf(os.Stderr, "段位必须是 list|book|chapter，得到 %q\n", seg)
		os.Exit(2)
	}

	rules, err := fetchRules(backend)
	if err != nil {
		fmt.Fprintf(os.Stderr, "规则读取失败: %v\n", err)
		os.Exit(1)
	}
	rule, err := pickRule(rules, name)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	segRule := map[segKey]any{
		"list": rule.ListRule, "book": rule.BookRule, "chapter": rule.ChapterRule,
	}[seg]
	if segRule == nil {
		segRule = map[string]any{}
	}
	body := map[string]any{
		"url":  u,
		"rule": map[string]any{string(seg) + "Rule": segRule},
	}
	if s := strings.TrimSpace(rule.Charset); s != "" {
		body["charset"] = s
	}
	if s := strings.TrimSpace(rule.Proxy); s != "" {
		body["proxy"] = s
	}
	if rule.InsecureTLS {
		body["insecureTLS"] = true
	}
	if s := strings.TrimSpace(rule.Cookies); s != "" {
		body["cookies"] = s
	}

	fmt.Printf("规则 #%d %s → 引擎 %s 段试测 %s\n", rule.ID, rule.Name, seg, u)
	start := time.Now()
	resp, err := postJSON(engine+"/api/test", body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "引擎请求失败: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("耗时 %s ok=%v strategy=%s", time.Since(start).Round(time.Millisecond), resp.OK, resp.Strategy)
	if resp.FinalURL != "" && resp.FinalURL != u {
		fmt.Printf(" finalURL=%s", resp.FinalURL)
	}
	fmt.Println()
	if resp.Challenge {
		fmt.Println("⚠ softBlock=true（挑战页特征命中）")
	}
	if !resp.OK {
		fmt.Printf("失败: %s（%s）\n", resp.Error, resp.Detail)
	}
	for _, a := range resp.Attempts {
		p := a.Profile
		if p != "" {
			p = "/" + p
		}
		fmt.Printf("  attempt %-22s ok=%-5v status=%-3d %s\n", a.Strategy+p, a.OK, a.Status, a.Note)
	}
	for _, w := range resp.Warnings {
		fmt.Println("  [warn] " + w)
	}
	if data, ok := resp.Data[string(seg)].(map[string]any); ok {
		printSummary(data)
	} else if raw, ok := resp.Data[string(seg)]; ok {
		b, _ := json.Marshal(raw)
		fmt.Printf("提取(%s): %s\n", seg, truncate(string(b), 800))
	}
}

func fetchRules(backend string) ([]rule, error) {
	res, err := http.Get(backend + "/api/scrape-rules")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("backend HTTP %d: %s", res.StatusCode, truncate(string(b), 200))
	}
	var out []rule
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("规则 JSON 解析: %w", err)
	}
	return out, nil
}

func pickRule(rules []rule, key string) (*rule, error) {
	var byName, byPrefix *rule
	for i := range rules {
		r := &rules[i]
		if r.Name == key || fmt.Sprint(r.ID) == key {
			return r, nil
		}
		if byName == nil && r.Name == strings.TrimSpace(key) {
			byName = r
		}
		if byPrefix == nil && strings.HasPrefix(r.Name, key) {
			byPrefix = r
		}
	}
	if byName != nil {
		return byName, nil
	}
	if byPrefix != nil {
		return byPrefix, nil
	}
	return nil, fmt.Errorf("未找到规则 %q（库内 %d 条，用 /api/scrape-rules 查名）", key, len(rules))
}

// printSummary 对三段提取结果打印人类可读摘要。
func printSummary(m map[string]any) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		switch v := m[k].(type) {
		case []any:
			fmt.Printf("提取(%s): %d 条\n", k, len(v))
			for i, it := range v {
				if i >= 5 {
					fmt.Printf("  ... 其余 %d 条略\n", len(v)-i)
					break
				}
				fmt.Printf("  %d. %s\n", i+1, summarizeItem(it))
			}
		case string:
			fmt.Printf("提取(%s): %s\n", k, truncate(collapseWS(v), 200))
		default:
			b, _ := json.Marshal(v)
			fmt.Printf("提取(%s): %s\n", k, truncate(string(b), 300))
		}
	}
}

func summarizeItem(it any) string {
	m, ok := it.(map[string]any)
	if !ok {
		b, _ := json.Marshal(it)
		return truncate(string(b), 160)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", k, truncate(collapseWS(fmt.Sprint(m[k])), 60)))
	}
	return strings.Join(parts, " ")
}

func postJSON(u string, body any) (*testResp, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest("POST", u, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Minute}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	rb, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	var out testResp
	if err := json.Unmarshal(rb, &out); err != nil {
		return nil, fmt.Errorf("响应解析（HTTP %d）: %w: %s", res.StatusCode, err, truncate(string(rb), 200))
	}
	return &out, nil
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func collapseWS(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
