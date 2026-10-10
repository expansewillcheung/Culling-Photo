# Culling Photo

本地照片筛选（culling）工具，运行在 Chrome / Edge 桌面版中。照片不会上传：读取、生成缩略图、分析都在本机完成。
可以在本地运行，也可以作为纯静态网站部署到 Cloudflare Pages。

详细设计见 [PLAN.md](PLAN.md)。

## 快速开始

```bash
npm install
npm run dev          # http://localhost:5173
# 或生产构建
npm run build && npm run preview
```

在 Chrome 中打开页面，点击 **打开文件夹…**，选择相机存储卡或照片文件夹。

## 部署到 Cloudflare Pages

```bash
npm run build
npx wrangler pages deploy dist --project-name culling-photo
```

`public/_headers` 会设置 COOP/COEP 响应头（WASM 多线程需要）。部署后所有处理仍然只在浏览器本地完成。

## 支持的格式

| 类型 | 格式 | 预览方式 |
|---|---|---|
| RAW | CR2, CR3, NEF, NRW, ARW, RAF, ORF, RW2, DNG（含 iPhone ProRAW）, PEF, SRW, 3FR, IIQ | 抽取内嵌 JPEG，没有可用预览时用 LibRaw (WASM) 解码 |
| 常见格式 | JPEG, PNG, WebP, AVIF, GIF | Chrome 原生解码 |
| 其他 | HEIC/HEIF, TIFF, JPEG XL | WASM 解码（按需加载） |
| 视频 | MP4, MOV | 截取一帧做缩略图，可以播放 |

同名的 RAW + JPEG 会合并为一张照片，评分和移动对两个文件同时生效。

## 交给 Photomator

1. 筛选时的标记会自动写入 XMP sidecar（`IMG_0001.xmp`），包含 `xmp:Rating`、`xmp:Label`，淘汰的照片写 `Rating=-1`。
2. 点击 **交付**：保留的照片移动（或复制）到 `_Picks/`（可按星级分子文件夹），淘汰的移到 `_Rejects/`。
3. 在 Photomator 中打开 `_Picks` 文件夹即可开始后期。
4. 所有移动都记录在 `_culling-log.json` 中，可以在交付对话框中一键还原。工具从不直接删除文件。

## 开发

```bash
./scripts/fetch-fixtures.sh   # 下载 RAW 测试样本（raw.pixls.us，CC0）
./scripts/gen-fixtures.sh     # 生成 JPEG/HEIC/TIFF/JXL 等测试文件（需要 exiftool, imagemagick, libheif-examples, libjxl-tools）
npm test                      # 单元测试（node）
npm run test:browser          # 浏览器测试（Chromium headless）
npm run e2e                   # 端到端测试
BENCH_COUNT=3000 npm run bench  # 性能基准测试：3000 张
```
