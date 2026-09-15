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
 * ShipSay 演示主题：现代扁平红白灰三段式
 * 主红 #BF2C24 / 高亮红 #ED4259 / 深灰导航页脚 #3E3D43 / 页面底 #F4F4F4
 * 960px 容器 + 700/250 双栏卡片流；阅读页米黄纸感 #E7E1D4
 */
const theme: ThemeModule = {
  id: 'shipsay',
  name: 'ShipSay 演示',
  source: 'demo.shipsay.com',
  description: '现代扁平红白灰：深灰导航 + 960px 双栏卡片流 + 点线分隔 + 米黄纸感阅读页',
  swatch: ['#BF2C24', '#3E3D43'],
  Layout,
  Home,
  Category,
  Book,
  Toc,
  Chapter,
  Search,
}

export default theme
