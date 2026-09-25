/**
 * backend-go —— ZAI LLM 直调层（移植自 z-ai-web-dev-sdk 的 createChatCompletion 协议）。
 *
 * 协议（对 SDK dist/index.js 逆向固化）：
 *   POST {baseUrl}/chat/completions
 *   Headers: Content-Type: application/json
 *            Authorization: Bearer {apiKey}
 *            X-Z-AI-From: Z
 *            X-Chat-Id: {chatId}（存在时）
 *            X-User-Id: {userId}（存在时）
 *            X-Token: {token}（存在时）
 *   Body:    OpenAI messages 格式 + thinking:{type:"disabled"} 默认注入
 *   响应:    OpenAI 格式 choices[0].message.content
 *
 * 凭证：/etc/.z-ai-config（JSON: apiKey/baseUrl/chatId/userId/token；项目/.z-ai-config、
 * ~/.z-ai-config 依次兜底，与 SDK loadConfig 顺序一致）。
 *
 * 治理（对齐 category.ts L3）：3s 超时、全局串行链（并发放大限流失败）、失败 30s 冷却窗。
 */
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	llmTimeoutMs   = 3_000                    // 单次调用超时（与 LLM_TIMEOUT_MS 一致）
	llmGenTimeout  = 5_000 * time.Millisecond // Task 32-b: 智能填充（author/简介生成）超时（用户指令「5s 超时+静默降级」）
	llmCooldownMs  = 30_000                   // 失败冷却窗（与 LLM_COOLDOWN_MS 一致）
	zaiConfigLimit = 2 << 20
)

type zaiConfig struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	ChatID  string `json:"chatId"`
	UserID  string `json:"userId"`
	Token   string `json:"token"`
}

var (
	gZaiOnce    sync.Once
	gZai        *zaiConfig
	gZaiErr     error
	gLLMMutex   sync.Mutex // 全局串行链
	gLLMCoolDo  sync.Once  // 冷却截止时间戳的原子替换由 cooldownUntil 互斥保护
	coolMu      sync.Mutex // 保护 cooldownUntil
	cooldownAt  int64      // 冷却截止（ms）；0 = 无冷却
	gHTTPClient = &http.Client{Timeout: 5 * time.Second}
)

// loadZaiConfig 读凭证（项目目录 → home → /etc，与 SDK loadConfig 顺序一致）
func loadZaiConfig() (*zaiConfig, error) {
	gZaiOnce.Do(func() {
		candidates := []string{
			filepath.Join(cwdOrDot(), ".z-ai-config"),
			filepath.Join(homeOrDot(), ".z-ai-config"),
			"/etc/.z-ai-config",
		}
		for _, p := range candidates {
			b, err := os.ReadFile(p)
			if err != nil {
				continue
			}
			var c zaiConfig
			if err := json.Unmarshal(b, &c); err != nil {
				gZaiErr = errors.New(".z-ai-config 解析失败: " + p)
				return
			}
			if c.BaseURL == "" || c.APIKey == "" {
				continue
			}
			gZai = &c
			return
		}
		gZaiErr = errors.New("z-ai 凭证未找到（.z-ai-config）")
	})
	return gZai, gZaiErr
}

func cwdOrDot() string {
	d, err := os.Getwd()
	if err != nil {
		return "."
	}
	return d
}

func homeOrDot() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return h
}

// llmInCooldown 当前是否处于冷却窗
func llmInCooldown() bool {
	coolMu.Lock()
	defer coolMu.Unlock()
	return time.Now().UnixMilli() < cooldownAt
}

// llmMarkCooldown 进入冷却窗
func llmMarkCooldown() {
	coolMu.Lock()
	cooldownAt = time.Now().UnixMilli() + llmCooldownMs
	coolMu.Unlock()
}

// llmChatMessage 一条对话消息
type llmChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// llmChat 串行化调用 LLM；返回 choices[0].message.content（trim 后）。
// 失败（超时/非 2xx/网络）返回 "" 并进入冷却窗——绝不 panic、绝不阻塞调用方主流程。
func llmChat(messages []llmChatMessage) string {
	return llmChatWithTimeout(messages, time.Duration(llmTimeoutMs)*time.Millisecond)
}

// llmChatWithTimeout llmChat 的超时参数化形态（Task 32-b 智能填充用 5s；既有 3s 行为不变）：
// 同样走全局串行链 + 失败冷却窗治理，失败/超时静默返回 ""。
func llmChatWithTimeout(messages []llmChatMessage, timeout time.Duration) string {
	if llmInCooldown() {
		return ""
	}
	cfg, err := loadZaiConfig()
	if err != nil || cfg == nil {
		return ""
	}
	gLLMMutex.Lock()
	defer gLLMMutex.Unlock()
	if llmInCooldown() {
		return "" // 排队期间别的调用已失败进入冷却
	}

	body := map[string]any{
		"messages": messages,
		"thinking": map[string]string{"type": "disabled"},
	}
	jb, _ := json.Marshal(body)
	ctx := gHTTPClient
	req, err := http.NewRequest("POST", cfg.BaseURL+"/chat/completions", bytes.NewReader(jb))
	if err != nil {
		llmMarkCooldown()
		return ""
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("X-Z-AI-From", "Z")
	if cfg.ChatID != "" {
		req.Header.Set("X-Chat-Id", cfg.ChatID)
	}
	if cfg.UserID != "" {
		req.Header.Set("X-User-Id", cfg.UserID)
	}
	if cfg.Token != "" {
		req.Header.Set("X-Token", cfg.Token)
	}

	// 3s 硬超时（与 TS 版 Promise.race 语义一致）
	type result struct {
		content string
		err     error
	}
	ch := make(chan result, 1)
	go func() {
		resp, err := ctx.Do(req)
		if err != nil {
			ch <- result{err: err}
			return
		}
		defer resp.Body.Close()
		rb, _ := readAllLimited(resp.Body, zaiConfigLimit)
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			ch <- result{err: errors.New("LLM HTTP " + itoa(resp.StatusCode) + ": " + truncateRunes(string(rb), 200))}
			return
		}
		var out struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(rb, &out); err != nil {
			ch <- result{err: err}
			return
		}
		content := ""
		if len(out.Choices) > 0 {
			content = out.Choices[0].Message.Content
		}
		ch <- result{content: content}
	}()

	select {
	case res := <-ch:
		if res.err != nil {
			log.Printf("[llm] 调用失败（进入 %ds 冷却）: %v", llmCooldownMs/1000, res.err)
			llmMarkCooldown()
			return ""
		}
		return trimSpaceStr(res.content)
	case <-time.After(timeout):
		log.Printf("[llm] 超时 %s（进入 %ds 冷却）", timeout, llmCooldownMs/1000)
		llmMarkCooldown()
		return ""
	}
}

// ==================== 智能填充 LLM 兜底（Task 32-b） ====================
// 用户指令：author/description 缺失时 LLM 兜底——5s 超时 + 失败静默降级（返回 ""），
// 调用方回落占位值/跳过，绝不阻塞或破坏采集主流程（冷却窗治理同 llmChat）。

// llmGuessAuthor 依书名+简介推断作者笔名；无法推断输出「佚名」（调用方 junk 判定后回落占位）
func llmGuessAuthor(title, description string) string {
	user := "网文《" + truncateRunes(trimSpaceStr(title), 60) + "》"
	if d := trimSpaceStr(description); d != "" {
		user += "，简介：" + truncateRunes(d, 120)
	}
	user += "。推测其作者笔名。"
	return llmChatWithTimeout([]llmChatMessage{
		{Role: "assistant", Content: "你是中文网文资料库。根据书名与简介推测作者笔名，只输出作者名本身，不要任何其他文字；无法推断时输出：佚名"},
		{Role: "user", Content: user},
	}, llmGenTimeout)
}

// llmGenerateDescription 依书名+作者生成简介；失败/超时静默返回 ""（调用方跳过回填）
func llmGenerateDescription(title, author string) string {
	user := "网文书名《" + truncateRunes(trimSpaceStr(title), 60) + "》"
	if a := trimSpaceStr(author); a != "" && a != "佚名" {
		user += "，作者：" + truncateRunes(a, 30)
	}
	user += "。写一段 80 字以内的书籍简介。"
	return llmChatWithTimeout([]llmChatMessage{
		{Role: "assistant", Content: "你是网文简介写手。根据书名与作者写一段不超过 80 字的中文书籍简介，直接输出简介正文，不要任何前后缀或引号。"},
		{Role: "user", Content: user},
	}, llmGenTimeout)
}
