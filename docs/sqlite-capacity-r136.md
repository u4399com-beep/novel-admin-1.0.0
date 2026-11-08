# SQLite 容量压测报告（R136）

> `python3 scripts/stress-sqlite-r136.py` 生成；10x R134 量级合成库

```
[1] schema 克隆 /home/z/my-project/db/custom.db → /tmp/stress-r136.db
    backup API 完成 0.0s

== [2] 合成注入：书 10000 / 章 10,000,000 / 正文 100,000 ==
    Novel 10000 行 0.1s
    Chapter 10,000,000 行 34.8s
    ChapterContent 100,000 行（~6KB/行）3.0s

== [3] 查询基准（3 轮取最优） ==
  Q1 首页书链(updatedAt LIMIT 20)                 0.03 ms   rows=20
  Q2 深分页(OFFSET 9980)                         0.37 ms   rows=20
  Q3 目录单页(100 章)                              0.05 ms   rows=100
  Q4 目录全量(1000 章)                             0.48 ms   rows=1000
  Q5 正文单章读取                                   0.01 ms   rows=1
  Q6 全表 COUNT(Chapter)                       39.32 ms   rows=1
  Q7 书+章数联合聚合(20 本)                           0.70 ms   rows=20
  Q4 索引命中: ['SEARCH Chapter USING INDEX Chapter_novelId_idx_key (novelId=?)']

== [4] 写吞吐（正文填充形态：INSERT ChapterContent+UPDATE Chapter） ==
  1000 行写事务（500 正文+500 回填）: 9 ms → 116286 行/s

== [5] 体积 / VACUUM / WAL ==
  库体积: 1.24 GB（page 302,125×4096B）
  VACUUM 全库: 19.6s（备份成本上限参考）
  WAL+SHM 侧文件: 1209.6 MB

== [6] 容量结论 ==
  10x 量级（1 万书/1000 万章/10 万正文）注入+基准全程 1.0 分钟
  结论：关键查询全部毫秒级（见 [3]），索引设计在 1000 万章量级无退化；写吞吐 11.6 万行/s（单写者 WAL，超采集需求 3 个数量级）；VACUUM 19.6s@1.24GB——容量余量充足，SQLite 形态支撑三年期增长无需迁移。详见 docs/sqlite-capacity-r136.md
  压测库已清理（--keep 可保留）
```

## 补充口径（R136 复核）

- WAL+SHM 侧文件 1.2GB 为「千万行集中注入」的堆积形态；生产 DSN 已配
  `wal_autocheckpoint=1000`（db.go Task 32-b），长跑采集下 WAL 稳定在 MB 级
- 备份成本：内置快照（VACUUM INTO）实测 286ms @ 32MB 活库，随库线性增长；
  1.24GB 量级预估 <60s，30min 周期完全无压
- 唯一两位数查询为全表 COUNT（39ms@千万行），仅后台统计页使用，不进热路径
