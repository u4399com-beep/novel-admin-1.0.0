/**
 * coversaudit.go —— 封面与书籍一一对应审计/归位（R98）。
 *
 * 背景（用户指令：检查封面图是否和书籍一一对应；命名统一为入库书籍 id）：
 *   存储层命名本就为 {novelId}.jpg（fetchAndStoreCover / storeCoverJPEG 落盘契约），
 *   但「文件名按 id」≠「映射正确」——已知的错位向量：
 *     1. DB cover 字段与书籍 id 脱钩（旧库残留 / 人工改库 / 历史导入）：
 *        cover='/covers/43.jpg' 挂在 id=42 的书上。backfillBrokenCoverLocal 的
 *        「文件存在即健康」判定对此完全失明（文件恰好在）→ 前台长期张冠李戴。
 *        purgeStaleCoversOnFreshDB 只覆盖「全新空库」这一极端形态。
 *     2. 磁盘孤儿文件（书籍删除后遗留 / 旧库编号残留）——无害但占空间、可被
 *        未来 id 复用误挂。
 *   本文件三层闭环：
 *     A. normalizeCoverNames —— boot 自愈：本地形态 cover 一律归位为
 *        '/covers/{id}.jpg'（安全 rename 仅在「旧名只被本书引用 + 目标不存在」时执行；
 *        目标已存在则仅改 DB 指针；旧名缺目标缺 → 保持原状交由紧随其后的
 *        backfillBrokenCoverLocal 重置渐变 token 补抓重建）。
 *     B. auditCoverBookMapping —— 只读审计（GET /api/novels/covers-audit）：
 *        指针错误清单 / 文件缺失清单 / 孤儿文件清单。
 *     C. repairCoverBookMapping / purgeOrphanCoverFiles —— POST 修复动作：
 *        action=repair（归位 rename + 指针改写）、action=purge-orphans（孤儿清理）。
 *
 * 前台防线（同指令探讨结论）：coverSrc 模板函数（web.go）按书籍 id 确定性派生
 *   /covers/{id}.jpg，DB cover 字段即使整体错乱前台也不可能展示成别的书的图——
 *   「命名=id」+「前台派生」双层结构后，映射错误只剩「文件缺失」一种可自愈形态。
 */
package main

import (
        "database/sql"
        "log"
        "net/http"
        "os"
        "path/filepath"
        "strings"
)

func init() {
        register("GET", "/api/novels/covers-audit", handleNovelsCoversAuditGet)
        register("POST", "/api/novels/covers-audit", handleNovelsCoversAuditPost)
}

// coverLocalRow 本地封面形态书籍行
type coverLocalRow struct {
        id     int64
        title  string
        author string
        cover  string
}

// loadCoverLocalRows 全量拉取本地形态 cover 的书籍（id 升序）。
// ⚠ 使用传入 db 直查而非 queryList/queryOne——本函数被 boot 链（getDB 的
// sync.Once 内）调用，queryList 内部 getDB() 会递归自锁（R97 死锁同款，dbReady
// 门闩只救设置读取层，救不了这里）。
func loadCoverLocalRows(db *sql.DB) ([]coverLocalRow, error) {
        rows := []coverLocalRow{}
        rs, err := db.Query(`SELECT "id","title","author","cover" FROM "Novel" WHERE "cover" LIKE '/covers/%' ORDER BY "id" ASC`)
        if err != nil {
                return nil, err
        }
        defer rs.Close()
        for rs.Next() {
                var r coverLocalRow
                if err := rs.Scan(&r.id, &r.title, &r.author, &r.cover); err != nil {
                        return nil, err
                }
                rows = append(rows, r)
        }
        return rows, rs.Err()
}

// coverBaseFor 书籍 id → 规范文件名（{id}.jpg）
func coverBaseFor(id int64) string { return itoa(int(id)) + ".jpg" }

// normalizeCoverNames boot 自愈：本地形态 cover 归位为 /covers/{id}.jpg。
// 安全规则（绝不制造新错位）：
//   - rename 仅当：旧文件名只被这一本书引用（refCount==1）+ 旧文件存在 + 目标 {id}.jpg 不存在
//     （目标已存在时 rename 会覆盖掉本书真正该用的图 → 拒绝，只改指针）；
//   - 其余情况统一 UPDATE cover='/covers/{id}.jpg'（目标缺失场景由紧随其后的
//     backfillBrokenCoverLocal 重置渐变 token，补抓通道按 coverSrc 重建）。
// 幂等：base 已等于 {id}.jpg 的行零写放大。失败仅记日志不阻断启动。
func normalizeCoverNames(db *sql.DB) {
        rows, err := loadCoverLocalRows(db)
        if err != nil {
                log.Printf("[covers] 封面命名归位扫描失败（暂存，重启重试）: %v", err)
                return
        }
        // 旧文件名引用计数：>1 = 多本书指向同一文件（改名会影响他书），一律只改指针
        refCount := map[string]int{}
        for _, r := range rows {
                refCount[filepath.Base(r.cover)]++
        }
        dir := coversDir()
        renamed, repointed := 0, 0
        for _, r := range rows {
                base := filepath.Base(r.cover)
                want := coverBaseFor(r.id)
                if base == want {
                        continue // 已规范
                }
                oldAbs := filepath.Join(dir, base)
                tgtAbs := filepath.Join(dir, want)
                if refCount[base] == 1 && tgtAbs != oldAbs {
                        if _, statErr := os.Stat(tgtAbs); os.IsNotExist(statErr) {
                                if _, statErr2 := os.Stat(oldAbs); statErr2 == nil {
                                        if rErr := os.Rename(oldAbs, tgtAbs); rErr == nil {
                                                renamed++
                                        }
                                }
                        }
                }
                if _, err := db.Exec(`UPDATE "Novel" SET "cover" = ? WHERE "id" = ?`,
                        LOCAL_PREFIX+want, r.id); err != nil {
                        log.Printf("[covers] 封面指针归位失败 id=%d: %v", r.id, err)
                        return
                }
                repointed++
        }
        if renamed > 0 || repointed > 0 {
                log.Printf("[covers] 封面命名归位：rename %d 个文件、指针归位 %d 行（命名契约 /covers/{id}.jpg）", renamed, repointed)
        }
}

// coverIDMismatch 指针与书籍 id 脱钩条目
type coverIDMismatch struct {
        NovelID    int64  `json:"novelId"`
        Title      string `json:"title"`
        Cover      string `json:"cover"`               // 现存指针（≠ 规范名）
        Expected   string `json:"expected"`            // /covers/{id}.jpg
        FileExists bool   `json:"fileExists"`          // 现存指针指向的文件是否存在
}

// coversAuditReport 审计报告（GET /api/novels/covers-audit 响应体）
type coversAuditReport struct {
        Books          int               `json:"books"`
        LocalCovers    int               `json:"localCovers"`
        GradientCovers int               `json:"gradientCovers"`
        Files          int               `json:"files"`
        MissingFiles   []int64           `json:"missingFiles"`
        IDMismatches   []coverIDMismatch `json:"idMismatches"`
        OrphanFiles    []string          `json:"orphanFiles"`
}

// auditCoverBookMapping 全库审计（只读）：
//   - MissingFiles：cover 指向 /covers/{id}.jpg（规范名）但文件缺失（→ 渐变兜底/补抓重建）
//   - IDMismatches：cover 是本地形态但文件名 ≠ {id}.jpg（指针脱钩，前台已由 coverSrc
//     确定性派生兜底，落库归位走 repair）
//   - OrphanFiles：磁盘 jpg 文件名不在任何在库书籍 {id}.jpg 集合（书籍已删/旧库残留）
func auditCoverBookMapping() (*coversAuditReport, error) {
        db, derr := getDB()
        if derr != nil {
                return nil, derr
        }
        rep := &coversAuditReport{
                MissingFiles: []int64{},
                IDMismatches: []coverIDMismatch{},
                OrphanFiles:  []string{},
        }
        if err := queryOne(`SELECT COUNT(*) FROM "Novel"`, []any{&rep.Books}); err != nil {
                return nil, err
        }
        if err := queryOne(`SELECT COUNT(*) FROM "Novel" WHERE "cover" LIKE 'g_' OR "cover" LIKE 'g__'`, []any{&rep.GradientCovers}); err != nil {
                return nil, err
        }
        rows, err := loadCoverLocalRows(db)
        if err != nil {
                return nil, err
        }
        rep.LocalCovers = len(rows)
        dir := coversDir()
        // 期望文件名集合 = 在库书籍 {id}.jpg（无论 cover 字段当前指向何处——文件系统真实契约）
        expected := map[string]bool{}
        for _, r := range rows {
                expected[coverBaseFor(r.id)] = true
        }
        for _, r := range rows {
                base := filepath.Base(r.cover)
                if base != coverBaseFor(r.id) {
                        exists := false
                        if _, statErr := os.Stat(filepath.Join(dir, base)); statErr == nil {
                                exists = true
                        }
                        rep.IDMismatches = append(rep.IDMismatches, coverIDMismatch{
                                NovelID:    r.id,
                                Title:      r.title,
                                Cover:      r.cover,
                                Expected:   LOCAL_PREFIX + coverBaseFor(r.id),
                                FileExists: exists,
                        })
                        continue
                }
                if _, statErr := os.Stat(filepath.Join(dir, base)); statErr != nil {
                        rep.MissingFiles = append(rep.MissingFiles, r.id)
                }
        }
        // 磁盘扫描：孤儿文件
        entries, err := os.ReadDir(dir)
        if err == nil {
                for _, e := range entries {
                        if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".jpg") {
                                continue
                        }
                        if !expected[e.Name()] {
                                rep.OrphanFiles = append(rep.OrphanFiles, e.Name())
                        }
                        rep.Files++
                }
        }
        return rep, nil
}

// coverRepairResult 修复动作结果
type coverRepairResult struct {
        Renamed   int      `json:"renamed"`
        Repointed int      `json:"repointed"`
        Purged    int      `json:"purged,omitempty"`
        PurgedList []string `json:"puragedList,omitempty"`
}

// repairCoverBookMapping 归位修复：本地形态 cover 一律改写为规范名；满足安全条件的
// 旧文件 rename（同 normalizeCoverNames 单书安全规则），其余仅改指针。
func repairCoverBookMapping() (*coverRepairResult, error) {
        db, derr := getDB()
        if derr != nil {
                return nil, derr
        }
        rows, err := loadCoverLocalRows(db)
        if err != nil {
                return nil, err
        }
        res := &coverRepairResult{}
        refCount := map[string]int{}
        for _, r := range rows {
                refCount[filepath.Base(r.cover)]++
        }
        dir := coversDir()
        for _, r := range rows {
                base := filepath.Base(r.cover)
                want := coverBaseFor(r.id)
                if base == want {
                        continue
                }
                if refCount[base] == 1 {
                        oldAbs := filepath.Join(dir, base)
                        tgtAbs := filepath.Join(dir, want)
                        if _, statErr := os.Stat(tgtAbs); os.IsNotExist(statErr) {
                                if _, statErr2 := os.Stat(oldAbs); statErr2 == nil {
                                        if rErr := os.Rename(oldAbs, tgtAbs); rErr == nil {
                                                res.Renamed++
                                        }
                                }
                        }
                }
                if _, err := db.Exec(`UPDATE "Novel" SET "cover" = ? WHERE "id" = ?`,
                        LOCAL_PREFIX+want, r.id); err != nil {
                        return nil, err
                }
                res.Repointed++
        }
        return res, nil
}

// purgeOrphanCoverFiles 孤儿封面清理：文件名不属于任何在库书籍 {id}.jpg 的 jpg 全部删除。
// 安全边界：只删 coversDir() 顶层 .jpg（与 purgeStaleCoversIn 同口径），绝不递归、
// 绝不触碰在库书籍期望集合内的文件。
func purgeOrphanCoverFiles() (*coverRepairResult, error) {
        db, derr := getDB()
        if derr != nil {
                return nil, derr
        }
        rows, err := loadCoverLocalRows(db)
        if err != nil {
                return nil, err
        }
        expected := map[string]bool{}
        for _, r := range rows {
                expected[coverBaseFor(r.id)] = true
        }
        dir := coversDir()
        res := &coverRepairResult{PurgedList: []string{}}
        entries, err := os.ReadDir(dir)
        if err != nil {
                return res, nil // 目录不存在 = 无孤儿
        }
        for _, e := range entries {
                if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".jpg") {
                        continue
                }
                if expected[e.Name()] {
                        continue
                }
                if rmErr := os.Remove(filepath.Join(dir, e.Name())); rmErr == nil {
                        res.Purged++
                        res.PurgedList = append(res.PurgedList, e.Name())
                }
        }
        return res, nil
}

// ==================== handlers ====================

func handleNovelsCoversAuditGet(w http.ResponseWriter, _ *http.Request, _ map[string]string) {
        rep, err := auditCoverBookMapping()
        if err != nil {
                failJSON(w, "封面审计失败", firstLineErr(err), 500)
                return
        }
        writeJSON(w, 200, rep)
}

func handleNovelsCoversAuditPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
        action := ""
        if v, ok := readBodyValue(r); ok {
                if s, isStr := bodyMap(v)["action"].(string); isStr {
                        action = s
                }
        }
        switch action {
        case "repair":
                res, err := repairCoverBookMapping()
                if err != nil {
                        failJSON(w, "封面归位修复失败", firstLineErr(err), 500)
                        return
                }
                rep, err := auditCoverBookMapping()
                if err != nil {
                        writeJSON(w, 200, map[string]any{"result": res})
                        return
                }
                writeJSON(w, 200, map[string]any{"result": res, "report": rep})
        case "purge-orphans":
                res, err := purgeOrphanCoverFiles()
                if err != nil {
                        failJSON(w, "孤儿封面清理失败", firstLineErr(err), 500)
                        return
                }
                rep, err := auditCoverBookMapping()
                if err != nil {
                        writeJSON(w, 200, map[string]any{"result": res})
                        return
                }
                writeJSON(w, 200, map[string]any{"result": res, "report": rep})
        default:
                writeJSON(w, 400, map[string]string{"error": "action 仅支持 repair / purge-orphans"})
        }
}
