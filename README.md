# .

This template should help get you started developing with Vue 3 in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Compile and Minify for Production

```sh
npm run build
```

## 部署到公网（GitHub Pages）

项目是纯前端静态站点（无后端，数据在浏览器内存 / localStorage 中），仓库已内置
[.github/workflows/deploy-pages.yml](./.github/workflows/deploy-pages.yml)，推到 `main` 即自动构建并发布。

访问地址：`https://<你的用户名>.github.io/kucunyujing/`

首次部署需要在 GitHub 上确认两件事：

1. **Pages 源**：仓库 `Settings → Pages → Build and deployment → Source` 选 **GitHub Actions**
   （工作流里已加 `enablement: true`，多数情况下会自动开启）。
2. **仓库可见性**：GitHub Pages 只在**公开仓库**或 **Pro/Team/Enterprise 私有仓库**上可用。
   若账号没有付费计划，需要把仓库改成 Public（`Settings → General → Danger Zone → Change visibility`），
   且发布出来的站点本来就是公开的，任何人都能访问。

构建相关说明：

- `vite.config.js` 中 `base` 在打包时设为 `/kucunyujing/`，与项目站点子路径一致；改用自定义域名（根路径）时改回 `'/'`。
- 工作流会把 `dist/index.html` 复制成 `dist/404.html`，让 `/kucunyujing/config` 这类深链接刷新后仍能正常打开。
- 配置文件只在开发态写回 `src/stocking/config.json`；线上环境保存只写入浏览器 localStorage，
  每个访问者的配置/导入数据互相独立，不会影响他人。
