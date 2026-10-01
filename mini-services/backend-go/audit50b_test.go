/**
 * audit50b_test.go —— Task 50-b 深审回归锁定（封面补抓链路）：
 * ① backfill 候选扫描 token 全覆盖：g1-g12 全部入候选（旧 LENGTH=2 条件漏扫 3 字符
 *    的 g10/g11/g12），本地封面路径与空 coverSrc 仍正确排除；
 * ② 单次请求总时长预算：预算耗尽即停止发起新下载，attempted/remaining 如实反映
 *    （WriteTimeout=65s 防线；契约字段名零变更）；
 * ③ consumeCoverResponse 畸形响应表驱动：空响应体分支（修复点：旧版对 nil err 调
 *    err.Error() → nil 指针 panic 被 recover 吞成假原因）+ 状态/类型/限长/解码/
 *    解压炸弹守卫全链回归；
 * ④ upsertBook coverSrc 「首写为准」语义锁定（storex.go Task 50 UPDATE 守卫条件）。
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db；候选 coverSrc
 * 一律用私网地址——SSRF 文本层即拒，零网络依赖、测试恒快）。
 */
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// mustInitBackfillFixtures 候选书测试夹具：测试分类 + 指定 cover/coverSrc 的书。
// id 段 95100+ 避让其他测试文件；t.Cleanup 自清（只删本夹具插入的行）。
func mustInitBackfillFixtures(t *testing.T) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9501,'封面补抓测试分类')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "Novel" WHERE "id" >= 95100`)
		_, _ = db.Exec(`DELETE FROM "Category" WHERE "id" = 9501`)
	})
}

func insertBackfillNovel(t *testing.T, id int64, title, cover, coverSrc string) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","cover","coverSrc","categoryId","status","createdAt","updatedAt")
                        VALUES (?,?,?,?,?,9501,'serial',0,0)`, id, title, "补抓测试作者", cover, coverSrc); err != nil {
		t.Fatalf("insert novel #%d: %v", id, err)
	}
}

// TestCoverBackfillScanCoversAllTokens 修复①：g1-g12 全 token 面入候选（旧 LENGTH=2
// 漏扫 g10/g11/g12），本地封面/空 coverSrc 排除。
func TestCoverBackfillScanCoversAllTokens(t *testing.T) {
	mustInitBackfillFixtures(t)
	const privateSrc = "http://192.168.1.1/x.jpg" // SSRF 文本层即拒，不触网
	for tok := 1; tok <= 12; tok++ {
		cover := "g" + itoa(tok)
		insertBackfillNovel(t, int64(95100+tok), "token书"+itoa(tok), cover, privateSrc)
	}
	insertBackfillNovel(t, 95120, "本地封面书", "/covers/95120.jpg", privateSrc) // 排除：已本地
	insertBackfillNovel(t, 95121, "无源站URL书", "g5", "")                      // 排除：coverSrc 空

	cands, err := coverBackfillCandidates()
	if err != nil {
		t.Fatalf("coverBackfillCandidates: %v", err)
	}
	got := map[int64]string{}
	for _, c := range cands {
		got[c.id] = c.coverSrc
	}
	for tok := 1; tok <= 12; tok++ {
		id := int64(95100 + tok)
		if got[id] != privateSrc {
			t.Fatalf("token g%d（id=%d）应入候选，got=%q（全量=%v）", tok, id, got[id], got)
		}
	}
	if _, ok := got[95120]; ok {
		t.Fatal("本地封面 /covers/ 路径不应入候选")
	}
	if _, ok := got[95121]; ok {
		t.Fatal("coverSrc 为空不应入候选")
	}
}

// runBackfillCovers 直接调 handler 并解出 JSON 响应
func runBackfillCovers(t *testing.T, query string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/novels/backfill-covers"+query, nil)
	rec := httptest.NewRecorder()
	handleNovelsBackfillCovers(rec, req, nil)
	if rec.Code != 200 {
		t.Fatalf("backfill-covers 应 200，got %d（%s）", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode resp: %v", err)
	}
	return resp
}

// TestNovelsBackfillCoversHandlerEndToEnd 端到端：候选计数/失败明细/DB cover 不被失败
// 写花（私网 coverSrc 恒 SSRF 拒绝，零网络依赖）。
func TestNovelsBackfillCoversHandlerEndToEnd(t *testing.T) {
	mustInitBackfillFixtures(t)
	insertBackfillNovel(t, 95130, "私网源书A", "g7", "http://192.168.1.1/a.jpg")
	insertBackfillNovel(t, 95131, "私网源书B", "g11", "http://192.168.1.1/b.jpg")

	resp := runBackfillCovers(t, "?limit=20")
	if resp["scanned"].(float64) != 2 || resp["attempted"].(float64) != 2 {
		t.Fatalf("scanned/attempted = %v/%v, want 2/2", resp["scanned"], resp["attempted"])
	}
	if resp["fixed"].(float64) != 0 || resp["failed"].(float64) != 2 || resp["remaining"].(float64) != 0 {
		t.Fatalf("fixed/failed/remaining = %v/%v/%v, want 0/2/0", resp["fixed"], resp["failed"], resp["remaining"])
	}
	fails, _ := resp["failures"].([]any)
	if len(fails) != 2 {
		t.Fatalf("failures = %v, want 2 条", resp["failures"])
	}
	f0, _ := fails[0].(map[string]any)
	if !strings.Contains(f0["reason"].(string), "SSRF") {
		t.Fatalf("失败原因应透出 SSRF 拒绝，got %q", f0["reason"])
	}

	// 失败不改写 cover（渐变 token 保留）与 coverSrc（补抓通道数据源留存）
	db, _ := getDB()
	var cover, coverSrc string
	if err := db.QueryRow(`SELECT "cover","coverSrc" FROM "Novel" WHERE "id" = 95131`).Scan(&cover, &coverSrc); err != nil {
		t.Fatalf("query novel: %v", err)
	}
	if cover != "g11" || coverSrc != "http://192.168.1.1/b.jpg" {
		t.Fatalf("失败后 cover/coverSrc = %q/%q, want g11/原URL", cover, coverSrc)
	}
}

// TestNovelsBackfillCoversBatchingRemaining Task 50-b 分批语义（Task 69 起为游标分页）：
// limit=1 时单批只取 1 本（scanned=1），hasMore=true + nextAfterId 驱动调用方翻页；
// 第二批 afterId 游标续上处理下一本。旧「全量扫描+内存截断」契约（scanned=全量）已
// 被「SQL 分页」取代（force 全量面可达万级书，全量加载不再合适）。
func TestNovelsBackfillCoversBatchingRemaining(t *testing.T) {
	mustInitBackfillFixtures(t)
	insertBackfillNovel(t, 95140, "分批书A", "g9", "http://192.168.1.1/a.jpg")
	insertBackfillNovel(t, 95141, "分批书B", "g12", "http://192.168.1.1/b.jpg")

	resp := runBackfillCovers(t, "?limit=1")
	if resp["scanned"].(float64) != 1 || resp["attempted"].(float64) != 1 {
		t.Fatalf("scanned/attempted = %v/%v, want 1/1（SQL 分页语义）", resp["scanned"], resp["attempted"])
	}
	if resp["remaining"].(float64) != 0 {
		t.Fatalf("remaining = %v, want 0（批内未尝试书为 0）", resp["remaining"])
	}
	if resp["hasMore"] != true {
		t.Fatalf("hasMore = %v, want true（还有下一批）", resp["hasMore"])
	}
	if int64(resp["nextAfterId"].(float64)) != 95140 {
		t.Fatalf("nextAfterId = %v, want 95140（本批处理的书 id）", resp["nextAfterId"])
	}
	if resp["failed"].(float64) != 1 {
		t.Fatalf("failed = %v, want 1", resp["failed"])
	}

	// 第二批：afterId 游标翻页，处理 95141
	resp = runBackfillCovers(t, "?limit=1&afterId=95140")
	if resp["scanned"].(float64) != 1 || resp["attempted"].(float64) != 1 {
		t.Fatalf("第二批 scanned/attempted = %v/%v, want 1/1", resp["scanned"], resp["attempted"])
	}
	if resp["hasMore"] != false {
		t.Fatalf("第二批 hasMore = %v, want false（候选耗尽）", resp["hasMore"])
	}
	if int64(resp["nextAfterId"].(float64)) != 95141 {
		t.Fatalf("第二批 nextAfterId = %v, want 95141", resp["nextAfterId"])
	}
}

// TestNovelsBackfillCoversBudgetStopsNewDownloads 修复②：预算耗尽即停止发起新下载
// （attempted=0/remaining 如实），响应必在 WriteTimeout 窗口内写回。
func TestNovelsBackfillCoversBudgetStopsNewDownloads(t *testing.T) {
	mustInitBackfillFixtures(t)
	insertBackfillNovel(t, 95150, "预算书A", "g10", "http://192.168.1.1/a.jpg")
	insertBackfillNovel(t, 95151, "预算书B", "g2", "http://192.168.1.1/b.jpg")

	old := coverBackfillBudget
	if old <= 0 {
		t.Fatalf("生产预算必须为正值，got %v", old)
	}
	coverBackfillBudget = -1 * time.Nanosecond // 注入：任何时刻都已超预算
	t.Cleanup(func() { coverBackfillBudget = old })

	resp := runBackfillCovers(t, "?limit=20")
	if resp["attempted"].(float64) != 0 {
		t.Fatalf("预算耗尽后 attempted = %v, want 0", resp["attempted"])
	}
	if resp["remaining"].(float64) != 2 || resp["failed"].(float64) != 0 {
		t.Fatalf("remaining/failed = %v/%v, want 2/0", resp["remaining"], resp["failed"])
	}
}

// fakeCoverRes 构造 consumeCoverResponse 表驱动用的假响应
func fakeCoverRes(status int, ctype string, body []byte) *http.Response {
	h := http.Header{}
	if ctype != "" {
		h.Set("Content-Type", ctype)
	}
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(bytes.NewReader(body))}
}

// tinyJPEGBytes 生成一张极小但合法的 JPEG（4x3 纯色）
func tinyJPEGBytes(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for y := 0; y < 3; y++ {
		for x := 0; x < 4; x++ {
			img.Set(x, y, color.RGBA{R: 200, G: 120, B: 40, A: 255})
		}
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return b.Bytes()
}

// pngHeaderBytes 构造仅含 IHDR 的 PNG 头（声明 w×h 尺寸；解压炸弹守卫用）
func pngHeaderBytes(t *testing.T, w, h uint32) []byte {
	t.Helper()
	buf := &bytes.Buffer{}
	buf.Write([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})
	chunk := &bytes.Buffer{}
	_ = binary.Write(chunk, binary.BigEndian, uint32(13))
	chunk.WriteString("IHDR")
	_ = binary.Write(chunk, binary.BigEndian, w)
	_ = binary.Write(chunk, binary.BigEndian, h)
	chunk.WriteByte(8) // bit depth
	chunk.WriteByte(2) // color type: RGB
	chunk.WriteByte(0) // compression
	chunk.WriteByte(0) // filter
	chunk.WriteByte(0) // interlace
	buf.Write(chunk.Bytes())
	_ = binary.Write(buf, binary.BigEndian, crc32.ChecksumIEEE(chunk.Bytes()[4:]))
	return buf.Bytes()
}

// TestConsumeCoverResponse 修复③+全链回归：畸形/合法响应表驱动。
// 首案即本轮修复点：HTTP 200 + 空响应体在旧代码走 `err != nil || len(buf) == 0`
// 合并分支对 nil err 调 Error() → panic（被 fetchAndStoreCover 的 recover 吞成
// "panic: runtime error:..." 假原因）；现给出真实原因「响应体为空」。
func TestConsumeCoverResponse(t *testing.T) {
	jpg := tinyJPEGBytes(t)
	cases := []struct {
		name       string
		res        *http.Response
		wantReason string // 精确匹配（非空时）
		wantPrefix string // 前缀匹配（与 wantReason 二选一）
		wantOK     bool   // reason 为空且 ob 非空
	}{
		{"200空响应体", fakeCoverRes(200, "image/png", nil), "响应体为空", "", false},
		{"404", fakeCoverRes(404, "image/jpeg", jpg), "HTTP 404", "", false},
		{"非图像类型", fakeCoverRes(200, "text/html", []byte("<html></html>")), "非图像响应: text/html", "", false},
		{"超限读体", fakeCoverRes(200, "image/jpeg", bytes.Repeat([]byte{0xFF}, MAX_COVER_BYTES+2)), "", "响应体读取失败: ", false},
		{"HTML伪装图片", fakeCoverRes(200, "image/jpeg", []byte("<html>not an image</html>")), "图像头校验未过（非图/越界像素）", "", false},
		{"边长越界PNG", fakeCoverRes(200, "image/png", pngHeaderBytes(t, 20001, 10)), "图像头校验未过（非图/越界像素）", "", false},
		{"像素数越界PNG", fakeCoverRes(200, "image/png", pngHeaderBytes(t, 20000, 2001)), "图像头校验未过（非图/越界像素）", "", false},
		{"合法JPEG", fakeCoverRes(200, "image/jpeg", jpg), "", "", true},
	}
	for _, c := range cases {
		ob, reason := consumeCoverResponse(c.res)
		if c.wantOK {
			if reason != "" || len(ob) == 0 {
				t.Fatalf("[%s] 应成功，got reason=%q len=%d", c.name, reason, len(ob))
			}
			continue
		}
		if reason == "" {
			t.Fatalf("[%s] 应失败，got 成功（%d 字节）", c.name, len(ob))
		}
		if c.wantReason != "" && reason != c.wantReason {
			t.Fatalf("[%s] reason = %q, want %q", c.name, reason, c.wantReason)
		}
		if c.wantPrefix != "" && !strings.HasPrefix(reason, c.wantPrefix) {
			t.Fatalf("[%s] reason = %q, want 前缀 %q", c.name, reason, c.wantPrefix)
		}
	}
}

// TestUpsertBookCoverSrcFirstWriteWins 语义锁定：coverSrc「首写为准」（storex.go
// Task 50 UPDATE 守卫 `coverSrc IS NULL OR coverSrc = ”`）——重采拿到不同 URL 不
// 覆盖首写值，补抓通道数据源稳定。
func TestUpsertBookCoverSrcFirstWriteWins(t *testing.T) {
	mustInitBackfillFixtures(t)
	insertBackfillNovel(t, 95160, "首写书", "g3", "")

	const first = "http://images.example-cdn.org/a.jpg"
	const second = "http://other.example-cdn.org/b.jpg"
	db, _ := getDB()
	for _, u := range []string{first, second, second} {
		if _, err := execRetry(`UPDATE Novel SET coverSrc = ? WHERE id = ? AND (coverSrc IS NULL OR coverSrc = '')`,
			u, 95160); err != nil {
			t.Fatalf("coverSrc update: %v", err)
		}
	}
	var got string
	if err := db.QueryRow(`SELECT "coverSrc" FROM "Novel" WHERE "id" = 95160`).Scan(&got); err != nil {
		t.Fatalf("query coverSrc: %v", err)
	}
	if got != first {
		t.Fatalf("coverSrc = %q, want 首写值 %q", got, first)
	}
}
