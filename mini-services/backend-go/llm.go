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
	llmTimeoutMs   = 3_000  // 单次调用超时（与 LLM_TIMEOUT_MS 一致）
	llmCooldownMs  = 30_000 // 失败冷却窗（与 LLM_COOLDOWN_MS 一致）
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
	case <-time.After(time.Duration(llmTimeoutMs) * time.Millisecond):
		log.Printf("[llm] 超时 %dms（进入 %ds 冷却）", llmTimeoutMs, llmCooldownMs/1000)
		llmMarkCooldown()
		return ""
	}
}
