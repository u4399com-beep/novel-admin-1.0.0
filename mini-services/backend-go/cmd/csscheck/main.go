/**
 * csscheck —— Tailwind 类名漂移检测（Go 版，Task 58 起替代已拆除的 bun/Tailwind 构建期管线）。
 *
 * 背景：tw.css 已固化为仓库内 vendored 资产（build-go.sh 不再生成）。模板新增工具类时
 * tw.css 不会自动更新——本工具核对「模板用到但 tw.css 缺失」的类名，作为再生的前置审计
 * （warning-only，退出码恒 0，供人审阅；构建链路不依赖）。
 *
 * 用法：
 *   cd mini-services/backend-go && go run ./cmd/csscheck [-v]
 *
 * 口径（v2，压误报）：
 *   - 扫描面 = web/templates/** 的 class 属性值 + web-src/gradient-tokens.txt 行
 *     （Tailwind v4 真正的类名注入面；JS/CSS 文件噪声大，JS 侧动态类名靠人审）
 *   - 候选按空白切分后过「工具类合法性」过滤：root（首个 : 前段）必须以小写字母或
 *     负号开头；拒绝 # 开头/大写字母（括号内任意值除外）/括号不平衡/空段
 *   - tw.css 侧选择器转义（\:\/\. 等）统一去反斜杠后做子串匹配
 */
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const twRel = "web/static/css/tw.css"

var classAttrRe = regexp.MustCompile(`class(?:Name)?\s*=\s*"([^"]*)"|class(?:Name)?\s*=\s*'([^']*)'`)

func main() {
	verbose := flag.Bool("v", false, "逐类打印缺失项")
	flag.Parse()

	// 去 CSS 转义反斜杠，形成粗粒度可子串匹配视图（md\:hover\:x → md:hover:x）；
	// 覆盖面 = vendored tw.css + 全部手写 css + 模板内联 <style>（adm-*/dd-*/aj-*
	// 等自研类定义处）+ 渐变 token 表
	var sb strings.Builder
	var files []string
	for _, pat := range []string{
		"web/static/css/*.css",
		"web/templates/**/*.*",
		"web-src/gradient-tokens.txt",
	} {
		matches, _ := filepath.Glob(pat)
		files = append(files, matches...)
	}
	for _, cf := range append([]string{twRel}, files...) {
		b, rerr := os.ReadFile(cf)
		if rerr != nil {
			continue
		}
		sb.Write(b)
	}
	twFlat := strings.ReplaceAll(sb.String(), "\\", "")

	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "csscheck: 扫描面为空（请在 mini-services/backend-go 目录运行）")
		os.Exit(1)
	}

	used := map[string]int{}
	total := 0
	for _, f := range files {
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		isTokens := strings.HasSuffix(f, "gradient-tokens.txt")
		for sc.Scan() {
			line := dropInterpolation(sc.Text())
			if isTokens {
				for _, tok := range strings.Fields(line) {
					if plausible(tok) {
						used[tok]++
						total++
					}
				}
				continue
			}
			for _, m := range classAttrRe.FindAllStringSubmatch(line, -1) {
				val := m[1]
				if val == "" {
					val = m[2]
				}
				for _, tok := range strings.Fields(val) {
					if plausible(tok) {
						used[tok]++
						total++
					}
				}
			}
		}
		_ = fh.Close()
	}

	missing := []string{}
	for tok := range used {
		if !strings.Contains(twFlat, tok) {
			missing = append(missing, tok)
		}
	}
	sort.Strings(missing)

	fmt.Printf("[csscheck] 扫描面 %d 文件 / 候选类 %d（唯一 %d）/ tw.css 缺失 %d\n", len(files), total, len(used), len(missing))
	if len(missing) > 0 {
		if *verbose {
			for _, m := range missing {
				fmt.Printf("  MISSING %-40s x%d\n", m, used[m])
			}
		} else {
			n := len(missing)
			if n > 15 {
				n = 15
			}
			for _, m := range missing[:n] {
				fmt.Printf("  MISSING %-40s x%d\n", m, used[m])
			}
			if len(missing) > n {
				fmt.Printf("  ... 其余 %d 项用 -v 查看\n", len(missing)-n)
			}
		}
		fmt.Println("[csscheck] 存在漂移：模板新增类未进 vendored tw.css（按 docs/deployment.md §CSS 手动再生）")
	} else {
		fmt.Println("[csscheck] OK：模板类名全部被 vendored tw.css 覆盖")
	}
}

// plausible 过滤明显非工具类的 token：防十六进制色值/URL/文案混入（warning-only 工具
// 宁可漏报不可误报——漏报面由人工 review 模板兜底）。
func plausible(tok string) bool {
	if tok == "" || len(tok) < 2 || len(tok) > 120 {
		return false
	}
	root := tok
	if i := strings.IndexByte(tok, ':'); i >= 0 {
		root = tok[:i]
	}
	// root 必须以小写字母或负号（负 margin）开头
	if root == "" {
		return false
	}
	c0 := root[0]
	if !(c0 >= 'a' && c0 <= 'z') && c0 != '-' {
		return false
	}
	if strings.HasPrefix(tok, "--") {
		return false
	}
	// 括号必须成对；括号外不允许大写/#/,（括号内任意值如 bg-[#1B1B1F] 合法）
	depth := 0
	for _, r := range tok {
		switch r {
		case '[':
			depth++
		case ']':
			depth--
			if depth < 0 {
				return false
			}
		case '#', ',', '(', ')':
			if depth == 0 {
				return false
			}
		default:
			if depth == 0 && r >= 'A' && r <= 'Z' {
				return false
			}
		}
	}
	return depth == 0
}

// dropInterpolation 去掉 {{...}}（Go 模板）插值段，防模板语法产生伪类名。
func dropInterpolation(s string) string {
	for {
		i := strings.Index(s, "{{")
		if i < 0 {
			break
		}
		j := strings.Index(s[i:], "}}")
		if j < 0 {
			s = s[:i]
			break
		}
		s = s[:i] + " " + s[i+j+2:]
	}
	return s
}
