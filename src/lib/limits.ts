/**
 * 跨模块共享的字段限长常量。
 *
 * 管理端 API（POST/PUT /api/novels）与采集入库（store.upsertBook）必须同口径截断：
 * Novel 上有 @@unique([title, author])，两侧上限不一致时，同一本超长书名的书会因
 * 截断结果不同生成两套唯一键 → 重复入库。
 */

/** 书名上限（Novel.title） */
export const NOVEL_TITLE_MAX = 200
/** 作者上限（Novel.author） */
export const NOVEL_AUTHOR_MAX = 100
/** 简介上限（Novel.description） */
export const NOVEL_DESCRIPTION_MAX = 2000
/** 章节标题上限（Chapter.title，目录链接与正文落库共用） */
export const CHAPTER_TITLE_MAX = 200
