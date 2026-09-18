'use client'

import type { ThemeModule } from './types'
import aijjxs from './aijjxs'
import ddyueshu from './ddyueshu'
import pilishuwu from './pilishuwu'
import qb23 from './23qb'
import kks101 from './101kks'
import huangjinwu from './huangjinwu'
import ggd66 from './ggd66'
import shipsay from './shipsay'
import x2552 from './x2552'
import trxsw from './trxsw'

/** 全部主题注册表：key 与 SiteSetting.activeTheme 对应 */
export const THEMES: Record<string, ThemeModule> = {
  aijjxs,
  ddyueshu,
  pilishuwu,
  '23qb': qb23,
  '101kks': kks101,
  huangjinwu,
  ggd66,
  shipsay,
  x2552,
  trxsw,
}

export const THEME_LIST: ThemeModule[] = Object.values(THEMES)

export function getTheme(id: string): ThemeModule {
  return THEMES[id] ?? THEMES['aijjxs']
}
