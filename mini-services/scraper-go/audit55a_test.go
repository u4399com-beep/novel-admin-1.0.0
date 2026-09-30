/**
 * audit55a_test.go —— Task 55-a（第 17 轮网络层深审）修复回归锁定：
 * ①G1 stickyHashIndex 全主机哈希：旧实现 buf[9] 定长槽只把 host 前 8 字节混入哈希——
 *   共享 8 字节前缀的站点群（www.dingdian1.com / www.dingdian2.com 同前缀 "www.ding"）
 *   在同一时间窗内恒选同一画像 + 同一 Accept-Language，E14 声明的「同画像不同站语言形态
 *   可异」跨站去相关被截断破坏；修复后按完整 host 字节流哈希（盐位+host+定长窗口）。
 * ②G2 Content-Encoding: deflate 且响应体 0 字节：与 gzip 路径的 io.EOF→empty-body 语义
 *   对齐（旧实现把空体包进 flate 流，首个 Read 得 ErrUnexpectedEOF → 误记 network-error，
 *   attempts 明细/排障面失真——gzip 空体分支已修过同族语义，deflate 分支漏改）。
 * 运行：cd mini-services/scraper-go && go test -race ./... -count=1
 */
package main

import (
	"bytes"
	"io"
	"net/http"
	"testing"
)

// TestStickyHashIndexFullHostDecorrelation G1: 共享 8 字节前缀的站点群在同一窗口内的
// 画像/语言选择不得因 host 截断而恒同桶。30 个同前缀变体至少应出现 2 个不同桶
// （修复前：全部前 8 字节相同 → 哈希输入逐字节相同 → 恒同桶，本测试必红）。
func TestStickyHashIndexFullHostDecorrelation(t *testing.T) {
	const w = int64(4242)
	saw := map[int]bool{}
	for i := 0; i < 30; i++ {
		host := "www.dingdian" + itoa(i) + ".com" // 前 8 字节恒为 "www.ding"
		idx := stickyHashIndex('p', host, w, 3)
		if idx < 0 || idx >= 3 {
			t.Fatalf("下标越界: host=%s idx=%d", host, idx)
		}
		saw[idx] = true
	}
	if len(saw) < 2 {
		t.Fatalf("30 个同前缀主机全部落同一画像桶（host 哈希被截断，跨站去相关失效）: %v", saw)
	}
	// Accept-Language 盐位同口径：同前缀站点群的语言形态也应散布（E14 注释声明的去相关）
	sawL := map[int]bool{}
	for i := 0; i < 30; i++ {
		sawL[stickyHashIndex('l', "www.dingdian"+itoa(i)+".com", w, 3)] = true
	}
	if len(sawL) < 2 {
		t.Fatalf("Accept-Language 盐位在 30 个同前缀主机上恒同桶（截断同族）: %v", sawL)
	}
	// 空 host 行为锁定：hostOf 不可解析 URL 时返回 ""——粘性选择必须确定性、不 panic
	if a, b := stickyHashIndex('p', "", w, 3), stickyHashIndex('p', "", w, 3); a != b || a < 0 || a >= 3 {
		t.Fatalf("空 host 粘性选择不确定或越界: %d vs %d", a, b)
	}
}

type closeRecorder struct {
	io.Reader
	closed *bool
}

func (c closeRecorder) Close() error {
	*c.closed = true
	return nil
}

// TestReadBodyCappedEmptyDeflateBody G2: Content-Encoding: deflate + 0 字节响应体
// 必须按空体处理（note=""，size=0，bytes 空），且响应体已关闭（资源收尾）。
// 修复前：包 flate 流后首个 Read 得 ErrUnexpectedEOF → note="network-error"（本测试必红）。
func TestReadBodyCappedEmptyDeflateBody(t *testing.T) {
	closed := false
	res := &http.Response{
		Header: http.Header{},
		Body:   closeRecorder{Reader: bytes.NewReader(nil), closed: &closed},
	}
	res.Header.Set("Content-Encoding", "deflate")
	got := readBodyCapped(res)
	if got.note != "" {
		t.Fatalf("deflate 空体应按空体处理（对齐 gzip 路径语义）, got note=%q warning=%q", got.note, got.warning)
	}
	if got.size != 0 || len(got.bytes) != 0 {
		t.Fatalf("deflate 空体 size/bytes 应为零: size=%d bytes=%d", got.size, len(got.bytes))
	}
	if !closed {
		t.Fatal("deflate 空体路径响应体未被关闭（资源收尾缺失）")
	}
}

// TestReadBodyCappedEmptyBodyCompanions G2 配套：identity / gzip / 非 2xx 既有语义回归面，
// 防 deflate 修复误伤同函数其余三分支。
func TestReadBodyCappedEmptyBodyCompanions(t *testing.T) {
	// identity 空体：note 空（assess 层落 empty-body）
	closed1 := false
	res1 := &http.Response{Header: http.Header{}, Body: closeRecorder{Reader: bytes.NewReader(nil), closed: &closed1}}
	got1 := readBodyCapped(res1)
	if got1.note != "" || got1.size != 0 || !closed1 {
		t.Fatalf("identity 空体语义被破坏: %+v closed=%v", got1, closed1)
	}
	// gzip 空体：E8 既有口径 note 空（io.EOF → empty-body）
	closed2 := false
	res2 := &http.Response{Header: http.Header{}, Body: closeRecorder{Reader: bytes.NewReader(nil), closed: &closed2}}
	res2.Header.Set("Content-Encoding", "gzip")
	got2 := readBodyCapped(res2)
	if got2.note != "" || got2.size != 0 || !closed2 {
		t.Fatalf("gzip 空体既有语义被破坏: %+v closed=%v", got2, closed2)
	}
	// deflate 1 字节损坏流：仍按传输失败处理（不把损坏流当空体放过）
	res3 := &http.Response{Header: http.Header{}, Body: io.NopCloser(bytes.NewReader([]byte{0x78}))}
	res3.Header.Set("Content-Encoding", "deflate")
	got3 := readBodyCapped(res3)
	if got3.note == "" {
		t.Fatalf("deflate 损坏流应保留失败语义, got note=%q", got3.note)
	}
	// 身份路径正常体不受影响
	res4 := &http.Response{Header: http.Header{}, Body: io.NopCloser(bytes.NewReader([]byte("hello")))}
	got4 := readBodyCapped(res4)
	if string(got4.bytes) != "hello" || got4.note != "" {
		t.Fatalf("identity 正常体被破坏: %+v", got4)
	}
}
