/**
 * backend-go —— 字段限长常量（逐字对齐 src/lib/limits.ts）。
 *
 * 管理端 API（POST/PUT novels）与采集入库（store.upsertBook）必须同口径截断：
 * Novel 上有 @@unique([title, author])，两侧上限不一致时，同一本超长书名的书会因
 * 截断结果不同生成两套唯一键 → 重复入库。
 */
package main

const (
	novelTitleMax       = 200  // 书名上限（Novel.title）
	novelAuthorMax      = 100  // 作者上限（Novel.author）
	novelDescriptionMax = 2000 // 简介上限（Novel.description）
	chapterTitleMax     = 200  // 章节标题上限（Chapter.title）
)
