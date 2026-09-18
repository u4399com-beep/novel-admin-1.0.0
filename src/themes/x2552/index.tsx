'use client'

import type { ThemeModule } from '../types'
import Layout from './Layout'
import Home from './Home'
import Category from './Category'
import Book from './Book'
import Toc from './Toc'
import Chapter from './Chapter'
import Search from './Search'

/**
 * x2552 —— 杰奇 CMS 经典模板重建（蓝白配色 + 橙色点缀）：
 * 960px 定宽直角描边；首页=封面排行榜横条 + 760 最近更新长列表 + 190 双榜 + 友情链接；
 * 分类/详情/搜索=左侧 190 排行侧栏 + 右 760 数据表/属性表格；目录/正文页切换为 30px 紧凑顶栏，
 * 全量目录多列网格、正文页淡蓝底白盒 + 章首章尾双导航 + 字号设置；链接深蓝 hover 橙。
 */
const theme: ThemeModule = {
  id: 'x2552',
  name: '杰奇经典',
  source: 'x2552.com',
  description:
    '杰奇 CMS 经典蓝白模板重建：960px 定宽、渐变标题条 + 2px 天蓝亮线区块、深蓝链接 hover 橙；首页封面排行横条 + 更新长列表 + 双榜侧栏，详情页属性表格 + 书评区；目录/正文页紧凑顶栏、多列全量目录与淡蓝底阅读器（双导航 + 字号设置）。',
  swatch: ['#2F468F', '#FF6600'],
  Layout,
  Home,
  Category,
  Book,
  Toc,
  Chapter,
  Search,
}

export default theme
