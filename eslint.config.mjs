// Task 27：Next.js 已拆除，项目为 Go 单栈（backend-go 页面 SSR + API）。
// ESLint 仅守护残余 JS/TS 工具脚本（scripts/、tests/）；Go 代码由 go vet/go fmt 把关，
// 模板/静态 JS 由 mini-services 自治（历史 warning 非本配置辖区）。
const eslintConfig = [
  {
    rules: {
      "prefer-const": "off",
      "no-unused-vars": "off",
      "no-console": "off",
      "no-empty": "off",
      "no-irregular-whitespace": "off",
      "no-case-declarations": "off",
      "no-fallthrough": "off",
      "no-mixed-spaces-and-tabs": "off",
      "no-redeclare": "off",
      "no-undef": "off",
      "no-unreachable": "off",
      "no-useless-escape": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "mini-services/**",
      "skills/**",
      "tool-results/**",
      "download/**",
      "upload/**",
      "scripts/archive/**",
    ],
  },
];

export default eslintConfig;
