# Culling-Photo 设计与实施计划

> 一个运行在 Chrome 中的高性能本地照片筛选（culling）工具。
> 照片始终留在本机，应用本身可以在 localhost 运行，也可以部署到 Cloudflare Pages。
> 筛选结果交给 **Photomator** 做后期。
>
> 本文档同时记录**设计**和**实际实现**：凡是实现过程中验证或推翻过的结论，都已经写回对应章节。

---

## 0. 当前状态（2026-10-13）

| 阶段 | 状态 |
|---|---|
| Phase 0–3（技术验证 / MVP / 性能与专业功能 / AI 辅助） | ✅ 已实现，代码在 `claude/culling-plan` 分支 |
| 代码审查 + 探索式界面测试 | ✅ 共修复 30 个 bug，每个都有回归测试 |
| 真机验证（Mac + Photomator） | ⏳ **未做**：这是最大的未知数，见 §12 |
| Phase 4（HEIC 快速路径 / 桌面版 / 协作） | ⏳ 未开始，优先级见 §11 |

测试规模：单元测试 126 个（node），浏览器测试 101 个（Chromium headless），端到端测试 7 个（Playwright）。

### 0.1 模块清单
| 模块 | 位置 | 说明 |
|---|---|---|
| 格式解析 | `src/formats/` | 15 款相机 RAW + JPEG/HEIC/AVIF/PNG/WebP/GIF/TIFF/JXL；每个文件最多读 334 KB；逐项对照 exiftool |
| 快速缩略图 | `src/pipeline/jpegDc.ts` | 自写 DC-only JPEG 解码器（1/8 尺寸，不做 IDCT），比 Chrome 全尺寸解码快 2–2.5 倍，MAE < 1 |
| WASM 解码 | `src/decoders/` | HEIC（libheif）、TIFF（utif2）、JXL（jsquash）、RAW 后备（LibRaw 半尺寸 demosaic），全部按需加载 |
| 流水线 | `src/pipeline/pool.ts`、`src/app/session.ts` | 多 Worker、优先级队列、4 条通道、交互预留槽位、每帧合并 UI 更新 |
| 界面 | `src/ui/` | 虚拟网格、放大视图、2–4 张同步对比、胶片条、EXIF + 直方图、溢出提示 |
| 持久化 | `src/db/` | SQLite-WASM（OPFS SAH pool），多标签页冲突时降级为内存模式 |
| XMP | `src/formats/xmp.ts`、`src/export/sidecars.ts` | 自动写 `照片名.xmp`，与 Lightroom / darktable 已有 sidecar 合并 |
| 交付 | `src/export/` | `_Picks/`、`_Rejects/`，先写日志再操作，崩溃后也能还原 |
| AI | `src/ai/` | 清晰度、pHash 连拍分组、每组推荐、智能淘汰建议、MediaPipe 闭眼检测 |

---

## 1. 目标与约束

### 1.1 需求
| 项目 | 决定 |
|---|---|
| 浏览器 | **Chrome / Edge 桌面版**（需要 File System Access API 读写本地文件夹）；其他浏览器只读降级 |
| 平台 | macOS（Photomator 只有 Mac / iOS 版） |
| 单次规模 | **2,000–3,000 张**，5,000 张不崩 |
| 格式 | 主流 RAW + JPEG / HEIC / TIFF / PNG / WebP / AVIF / JXL / 视频；RAW+JPEG 配对 |
| 后期 | Photomator：交付方式必须让 Photomator 能直接使用筛选结果 |
| 部署 | `localhost` 或 Cloudflare Pages（纯静态，照片不上传） |

### 1.2 性能目标（验收标准）

**原则（从实测中得到的教训）：**
1. 目标必须**与机器无关**：用「单核耗时」定义，总时间按 worker 数换算。只写「M 系列 Mac 上 < 60 秒」的目标在 CI 里无法验证。
2. 目标必须绑定**固定的测试数据组成**：同样 3,000 张，纯 RAW 要 107 秒，混合格式要 305 秒，差了 3 倍。
3. 只用**生产构建**、**关闭 Playwright trace** 测量：dev 模式的 HMR 包装和 trace 快照都会把主线程耗时放大好几倍。

**测试数据组成（`scripts/make-bench-dir.mjs`，用硬链接，不占额外磁盘）：**
- **A：纯 RAW**（`BENCH_MIX=raw`）——15 款相机样本轮流，代表一次相机拍摄
- **B：混合格式**（默认）——RAW + JPEG + 约 10% HEIC/JXL/TIFF，代表手机 + 相机混合

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 第一张缩略图出现 | < 1.5 s | `progress.firstThumbAt` |
| 单张 RAW 缩略图（单核耗时） | ≤ 150 ms（数据 A 平均） | `thumbStatsByFormat` |
| 单张 HEIC / JXL 缩略图（单核耗时） | ≤ 300 ms（**当前 1.5–2.5 s，未达标**） | 同上 |
| 3,000 张全部缩略图 | ≤ 3,000 × 单张耗时 ÷ worker 数 × 1.2 | 基准测试脚本 |
| 元数据（全部头部解析） | < 20 s（3,000 张，4 核） | `progress.metaDone` |
| 第二次打开（有缓存） | < 2 s 全部可浏览 | `BENCH_WARM=1` |
| 放大视图切换（已预载） | < 50 ms | 按键到 render 可用 |
| 快速连按切换（未预载） | < 250 ms | 同上 |
| 按键到 UI 反馈 | < 16 ms | Event Timing API |
| 主线程单次 UI 刷新 | < 8 ms | `perfLog('ui-flush')` |
| 滚动时 long task | 无 > 100 ms 的任务 | PerformanceObserver |
| 内存 | < 1 GB（数据 A）/ < 2 GB（数据 B） | `measureUserAgentSpecificMemory` |

### 1.3 非目标
- 不做修图或调色（交给 Photomator）
- 不上传原图
- Safari / Firefox 只读（可以评分，评分导出为 XMP 压缩包或 CSV）
- 视频只做缩略图和播放，不做剪辑

---

## 2. 用户工作流

```
① 打开文件夹（或拖入）
   ↓  扫描 → 解析头部 → 抽内嵌预览 → 生成缩略图（后台 Worker）
② 速览（网格 + 放大视图）
   ↓  键盘标记：P 保留 / X 淘汰 / 1–5 星 / 6–9、V 色标
③ 连拍分组和对比
   ↓  自动分组 + 每组推荐；2–4 张同步对比；100% 查看对焦
④ 复核
   ↓  筛选（保留 / 未标记 / ≥N 星 / 建议淘汰）；撤销 / 重做
⑤ 交付给 Photomator
      → 写 XMP sidecar；保留的照片移到 `_Picks/`，淘汰的移到 `_Rejects/`
      → 在 Photomator 中打开 `_Picks/`；一键还原
```

---

## 3. 格式支持

### 3.1 预览获取策略
**原则：浏览阶段绝不完整解码 RAW。** 先读 64 KB 头部，再按需读 16 KB 的块，抽取相机内嵌的 JPEG 预览。每个内嵌 JPEG 都要校验 SOI 和 SOF（只接受 C0/C1/C2），尺寸从 SOF 读取，不信任 tag。

| 格式 | 内嵌预览位置 | 实测最大预览 | 缩略图路径 |
|---|---|---|---|
| CR2 | IFD0 StripOffsets | 全尺寸 | DC 解码 |
| CR3 | `PRVW`（1620px）+ trak[0] 全尺寸 JPEG | 全尺寸 | 用 PRVW，原生解码 |
| NEF / NRW | SubIFD JpgFromRaw + PreviewIFD | 全尺寸（Z 8）/ 4128px（D850） | DC 解码 |
| ARW | PreviewImage / JpgFromRaw | 1616px（A7 III）/ 全尺寸（A1） | 原生或 DC 解码 |
| RAF | header 中的 offset | 4416px | DC 解码 |
| ORF | MakerNote CameraSettings | 3200px | DC 解码 |
| RW2 | JpgFromRaw（自带 EXIF） | 1920px | 原生解码 |
| DNG（含 ProRAW） | SubIFD NewSubFileType=1 | 全尺寸 | DC 解码 |
| PEF / SRW | PreviewImage / JpgFromRaw | 全尺寸 | DC 解码 |
| JPEG | 文件本身 | — | DC 解码（≥ 4096px 时） |
| HEIC / HEIF | 无 JPEG；`thmb` 缩略图项为 HEVC 编码 | — | libheif 全图解码（**慢，见 §11 P1**） |
| AVIF / WebP / PNG / GIF | — | — | Chrome 原生 |
| TIFF | — | — | utif2 |
| JXL | — | — | jsquash（单线程，慢） |
| MOV / MP4 | — | — | 主线程 `<video>` 抽帧，最多 2 个并发 |

内嵌预览不足 1000px 且需要 100% 查看时，才会退回 LibRaw（固定在一个 worker 里，见 §4.2）。

### 3.2 已验证的平台事实（写死在设计里）
- **Chrome 没有缩小解码 JPEG 的能力**：`createImageBitmap(blob, {resizeWidth})` 会先全尺寸解码再缩放；WebCodecs `ImageDecoder` 指定 `desiredWidth` 时解码 JPEG 直接失败。这就是自写 DC 解码器的原因。
- **`imageOrientation: 'none'` 在 Chrome 中等同于 `'from-image'`**：浏览器一定会应用 JPEG 自带的 EXIF 方向。因此：内嵌 JPEG 有自己的 EXIF 方向 → 交给浏览器；没有 → 按 RAW 的方向手动旋转。DC 解码的输出不带方向，一律手动旋转。
- **`resizeWidth/Height` 作用在旋转之后**：方向为 5–8 时要交换宽高。
- **HEIC 的 irot/imir 由 libheif 处理**，EXIF 方向要忽略，否则会旋转两次。
- **LibRaw-WASM 需要跨源隔离**（COOP/COEP），并且会自带一个嵌套 worker，单实例共享内存 256 MB 起。

### 3.3 RAW+JPEG 配对
- 同一文件夹中 basename 相同（不分大小写）的文件合并为一张照片；显示优先用 JPEG。
- 一张照片只有一个 sidecar：`IMG_0001.xmp`（Lightroom 约定）。读取时也接受 `IMG_0001.CR3.xmp`。
- 交付时可选「两个都交付 / 只交 RAW / 只交 JPEG」；淘汰的照片永远移走全部文件。

---

## 4. 架构

```
┌──────────────────────────── Main thread (UI) ─────────────────────────────┐
│ SolidJS：Grid（虚拟化）· ImageView（Canvas2D）· Compare · Filmstrip · 键盘 │
│ Store（只放 UI 需要的字段）· 撤销栈（按文件夹）· ui() 每帧合并更新          │
│ Session：解析结果 / 文件列表等不可变大对象放在 store 外                     │
└───────┬───────────────────────┬────────────────────┬──────────────────────┘
        │ Comlink               │ Comlink            │ Comlink
┌───────▼──────────────┐ ┌──────▼─────────┐ ┌────────▼─────────┐ ┌─────────────┐
│ Preview Pool (N)     │ │ Meta Worker    │ │ DB Worker        │ │ AI Worker   │
│ 通道：normal / heavy │ │ 只做头部解析   │ │ SQLite-WASM      │ │ MediaPipe   │
│       / raw          │ │ 最多 8 批并发  │ │ OPFS SAH pool    │ │ （按需）    │
│ 抽预览 → DC/原生/WASM│ └────────────────┘ │ Web Lock 防多开  │ └─────────────┘
│ → 512px WebP + 分析  │                    └──────────────────┘
└───────┬──────────────┘
┌───────▼───────────────────────────────────────────────────────────────────┐
│ FileSource：FsAccessSource（读写）· FileListSource（只读降级）              │
│ 缓存：OPFS 缩略图（按 文件路径+大小+mtime 命名）· RenderCache（9 张屏幕尺寸 │
│ + 1 张全尺寸 ImageBitmap，LRU，对比视图中所有窗格的条目都被 pin 住）        │
└───────────────────────────────────────────────────────────────────────────┘
```

### 4.1 技术栈
| 层 | 选择 | 备注 |
|---|---|---|
| 构建 | Vite 6 + TypeScript strict | `optimizeDeps.exclude` 必须包含 sqlite-wasm / jsquash / libraw-wasm / libheif-js |
| UI | SolidJS | 细粒度响应式；**注意**：非 plain object（class 实例）不会被 store 代理，用这一点存放不可变大对象 |
| Worker 通信 | Comlink + Transferable | **store 代理对象不能 postMessage**，跨线程前必须是普通对象 |
| 数据库 | `@sqlite.org/sqlite-wasm`（opfs-sahpool） | 批量操作用 `json_each` + `MATERIALIZED` CTE，否则 3,000 行要 7 秒 |
| 放大视图 | **Canvas2D**（不是 WebGL） | ImageBitmap 的 drawImage 已走 GPU，100% 缩放和拖动都流畅 |
| 缩略图 | 512px WebP q0.78，约 35 KB/张 | 同一份 ImageData 顺便做清晰度 / pHash / 直方图 |
| 部署 | Cloudflare Pages | `public/_headers` 设置 COOP/COEP；最大文件 11 MB（MediaPipe wasm），在 25 MB 限制内 |

### 4.2 Worker 通道（实测后加入，原计划没有）
| 通道 | 内容 | 限制 | 原因 |
|---|---|---|---|
| `meta` | 头部解析 | 独立 worker | 曾经被重型解码卡住，3,000 张元数据读了 92 秒；分开后降到 11–18 秒 |
| `normal` | 内嵌预览 / 原生解码 / DC 解码 | 每个 worker 最多 2 个 | — |
| `heavy` | HEIC / JXL / TIFF | 同时最多 ⌈N×2/3⌉ 个，每个 worker 最多 1 个 | WASM 同步解码会阻塞整个 worker 的事件循环 |
| `raw` | LibRaw 后备 | 只在 worker 0，一次 1 个 | 每个 LibRaw 实例 256 MB+；限制后内存从 1.65 GB 降到 570 MB |

**优先级**：放大视图（-100）> 预载邻居（-50+d）> 可见格子（0+i）> 即将滚到的格子（100+i）> 元数据（500）> 后台（1000+i）。
**交互预留**：优先级 ≥ 1000 的后台任务永远留一个空闲槽位，保证快速翻页 ≤ 250 ms。
**派发**：每次一遍线性扫描，按通道取最优任务；不对整个队列排序（3,000 个任务时排序本身就会变慢）。

### 4.3 主线程预算规则（实测后加入）
1. **Worker 结果每帧合并**：`session.ui(fn)` 用 rAF 合并（另加 100 ms 的 setTimeout 兜底，后台标签页 rAF 不触发），一帧只重排、重渲染一次。合并前单条消息要 26–61 ms。
2. **不可变大对象不进 store**：`ParsedFile` 放在 `session.parsedById`；`CatalogItem` 是 class 实例，不会被代理。
3. **按文件名排序的 id 就是 catalog 顺序**：比较时用 `a.id - b.id`，不调用 `Intl.Collator`。
4. **元数据读完前按文件名显示**，读完后只按时间重排一次，并保持当前照片可见（否则网格会在 20 秒里不停重排）。
5. **连拍重新分组**：缩略图生成期间每 4 秒最多一次，全部完成后再做一次。

---

## 5. 交互规则（实测后加入）

> 探索式测试发现的 14 个界面问题中，大部分都源于这些规则当时没有写下来。

### 5.1 焦点与选择
- 当前照片被筛选或标记隐藏后（例如在「未标记」筛选下按 P），**焦点移到接替它位置的那一张**，绝不停在看不见的照片上。
- 视图变化（筛选、排序、标记）后，**选择集中被隐藏的照片自动剔除**；剩下一张时清空选择集。
- Shift+点击时，如果当前照片已被筛选掉，就以被点击的那张作为起点。
- 元数据读完后，如果用户还没移动过焦点，焦点放到第一个格子。
- 下拉框 / 滑杆改完值后把焦点还给页面，方向键要继续用于切换照片。

### 5.2 标记
- 标记目标：网格中有多选时作用于整个选择集；**对比视图中只作用于当前激活的那张**；其他情况作用于当前照片。
- P / X 再按一次取消；色标再按一次取消。
- 长按按键：导航键和设置星级（幂等）可以重复触发；开关类按键（P / X / 色标 / I / H / A / S）忽略重复，自动前进开启时除外。
- 自动前进：标记后跳到下一张；如果标记已经让焦点移动（照片被隐藏），就不再额外前进。
- 撤销栈最多 500 步，**随文件夹清空**，不能跨文件夹撤销。

### 5.3 视图
- 放大视图和对比视图**共用同一个缩放状态**；Z / 按住空格 / 单击都作用于所有窗格；每次切换视图都重置为「适合屏幕」。
- 100% = 一个图像像素对应一个设备像素；缩放基准永远是原始尺寸（不是当前位图的尺寸），这样全尺寸图加载完成时画面不会跳。
- Ctrl/⌘+滚轮缩放时，每格的 delta 限制在 ±30，约 1.35 倍。
- 无法解码的文件显示「无法预览这张照片」和错误原因，不显示缩放比例。
- 无法解码的文件不参与连拍分组。

### 5.4 快捷键（`src/ui/keyboard.ts`）
| 键 | 动作 |
|---|---|
| ← → ↑ ↓ / Home End / PageUp PageDown | 导航（网格中 ↑↓ 按行移动） |
| Shift + 方向键 / Shift+点击 / ⌘(Ctrl)+点击 | 扩展选择 / 范围选择 / 切换选择 |
| Enter / E · G / Esc · C | 放大视图 · 网格 · 对比 |
| Space | 网格中打开放大视图；放大视图中按住临时 100% |
| Z / 单击图片 · ⌘(Ctrl)+滚轮 | 适合 ↔ 100% · 缩放 |
| P · X · U | 保留 · 淘汰 · 清除旗标 |
| 1–5 / 0 · 6 7 8 9 / V | 星级 / 清除 · 红黄绿蓝 / 紫 |
| A（或 Caps Lock） | 自动前进开关 |
| S · H · I | 连拍折叠 · 溢出提示 · 信息面板 |
| + / - | 缩略图大小 |
| ⌘(Ctrl)+Z / ⌘(Ctrl)+Shift+Z · ⌘(Ctrl)+A | 撤销 / 重做 · 全选 |
| ? | 快捷键帮助 |

---

## 6. 会话生命周期（实测后加入）

> 代码审查发现的 16 个 bug 中，约 12 个是切换文件夹或 dispose 时，旧会话的任务写进了新会话。

1. **打开文件夹串行化**：`openSource` 用 promise 链排队，绝不并发。
2. **dispose 必须**：终止整个 worker 池（正在运行的任务以 cancelled 结束，之后拒绝新任务）；清掉所有 timer；丢弃已排队的 UI 更新；释放 object URL 和 ImageBitmap。
3. **`loaded` 闸门**：新会话列完文件之前，store 里还是旧照片，此时任何缩略图或渲染请求一律忽略。
4. **后台任务（人脸分析等）每一步都检查 `isDisposed`**。
5. **用户的标记最大**：用户在元数据读取期间手动做的标记，以及从数据库恢复的标记，都不会被 sidecar 或 EXIF 里的评分覆盖（`marksSettled` 集合）。
6. **XMP 写入链**：`flushMarks()` 必须等待所有 sidecar 写入完成；交付和还原前都要先 flush。
7. **交付后重新扫描**：结果要在重新扫描完成后再显示；`_Picks/`、`_Rejects/` 中的照片不再参与下一次交付计划。
8. **重新打开同一个文件夹**：按文件夹名匹配最近一次会话；如果文件有变化，只为大小和 mtime 都没变的文件恢复标记，避免把旧拍摄的标记套到重复使用的存储卡文件夹上。

---

## 7. 数据模型（SQLite，`src/db/store.ts`）

```sql
session (sid INTEGER PK, id TEXT UNIQUE, root_name, fingerprint, created_at, opened_at, settings_json)
photo   (id INTEGER PK, session, key TEXT, UNIQUE(session, key),
         dir_rel, basename, files_json,                -- 成员文件反范式化存成 JSON，加载时不用 join
         capture_ts, camera, lens, iso, shutter, aperture, focal, width, height, orientation)
pstate  (photo_id PK, rating, flag, label INT, thumb_state)   -- 热数据：标记 3,000 张只改约 10 个页
ai      (photo_id PK, blur_score, phash TEXT(16 hex), group_id, eyes_closed, face_count)
history (session, seq, ts, cmd_json, undone) WITHOUT ROWID
```

- `key = (dir_rel + '/' + basename).toLowerCase()`
- label 编码：0 无，1 红，2 黄，3 绿，4 蓝，5 紫
- 实测（3,000 行）：`loadSession` 42–54 ms，`setMarks` 46–71 ms，首次 `upsertFiles` 约 400 ms
- 多标签页：Web Lock 被占用时降级为内存数据库，状态栏显示「未持久化」
- 内存中的排序和筛选直接在 Solid store 上做（3,000 张约 1 ms），不需要另外维护列式副本

---

## 8. 交付给 Photomator

| 方式 | 内容 | 状态 |
|---|---|---|
| **A. 文件夹交付**（默认） | 保留 → `_Picks/`（可按星级分 `5★/…`），淘汰 → `_Rejects/` | ✅ 已实现；一定可用 |
| **B. XMP sidecar**（默认开启） | `xmp:Rating`（淘汰写 -1）、`xmp:Label`、`cull:Flag`；合并已有内容 | ✅ 已实现；**Photomator 是否读取未验证** |
| C. 内嵌 XMP 写入 JPEG / HEIC | — | ❌ 不做：会修改原文件 |
| D. CSV / XMP 压缩包 | 只读模式使用 | ✅ 已实现 |

**安全规则：**
- 每一批操作**先写入 `_culling-log.json` 再执行**；崩溃后，还原按磁盘的实际状态逐个撤销。
- 优先用 `FileSystemHandle.move()`（同一卷内瞬间完成）；不可用时复制 → 校验大小 → 删除原文件。
- 同名冲突时，整张照片的所有成员文件统一加 ` (n)` 后缀，绝不覆盖。
- 合并 sidecar 前先把原文件备份到 `_culling-backup/<runId>/`。
- **从不删除照片**；还原时绝不删除唯一副本。
- 实测：OPFS 中 3,000 个文件，移动用 2.2–3.7 秒，还原用 2.0–3.3 秒。

---

## 9. AI 辅助（`src/ai/`）

| 功能 | 实际方法 | 实测成本 | 备注 |
|---|---|---|---|
| 清晰度 | 4 个方向的一维二阶导均方值，每块取最小值，全图取最清晰的块，和中心加权结果比较取大 | 1.5–1.8 ms / 512px | 普通 Laplacian 方差对运动模糊不敏感，所以改了算法；> 1 清晰，< 0.3 模糊 |
| pHash | 32×32 DCT → 8×8 | 约 0.8 ms | 同一张图换格式或缩放，汉明距离 ≤ 4；不同场景 24–40 |
| 连拍分组 | 时间间隔 ≤ 2 s **且** 汉明距离 ≤ 12 | 3,000 张约 4 ms | 间隔可在设置中调 |
| 每组推荐 | log 清晰度 − 闭眼惩罚 − 高光 / 阴影溢出惩罚 | — | 权重在 `PICK_WEIGHTS` |
| 智能淘汰建议 | 模糊 > 闭眼 > 重复 > 过曝 > 欠曝 | — | 只给建议，不自动标记 |
| 闭眼 | MediaPipe FaceLandmarker 的 blink 系数 > 0.5 | 90–140 ms / 1024px | 首次下载约 4 MB 模型；**阈值没用真实闭眼照片校准过** |
| 语义相似（CLIP） | transformers.js，从 CDN 加载 | 0.4–2 s / 张（WASM） | 已实现但没接入界面；太慢 |

---

## 10. 目录结构（实际）

```
src/
├─ core/        types.ts（模块之间的接口契约）、util.ts
├─ fs/          FileSource.ts（FsAccess / FileList）、recent.ts（IndexedDB 记住句柄）
├─ formats/     detect · bytes · tiff · tiffFile · exif · jpeg · bmff · raf · simple · xmp · xmpRating
├─ decoders/    heic · tiff · jxl · raw（LibRaw）· pixels
├─ pipeline/    catalog（配对 + 指纹）· pool（通道 + 优先级）· image（解码路径选择）· jpegDc
├─ workers/     preview.worker.ts
├─ cache/       opfs.ts
├─ db/          client · db.worker · store（SQL）· types
├─ export/      delivery · sidecars · fallback（CSV / zip）· fsutil
├─ ai/          blur · hash · group · score · faces · embed · ai.worker · client
├─ store/       store.ts（状态 + 撤销 + 视图 memo）· types.ts
├─ app/         App · session（流水线核心）· wiring（XMP / 持久化）· persist · faces · video · renderCache
└─ ui/          Grid · ImageView · Loupe · Compare · InfoPanel · TopBar · StatusBar · Welcome · Dialogs · DeliverDialog · keyboard
tests/
├─ unit/        session.test.ts（用假 pool 驱动真实 Session）· keyboard.test.ts
├─ browser/     解码 / 方向 / fixtures 辅助
└─ e2e/         app（完整流程）· smoke · regressions · ui · bench · profile · trace
scripts/        fetch-fixtures.sh · gen-fixtures.sh · make-bench-dir.mjs
```

---

## 11. 后续路线（按优先级）

| 优先级 | 任务 | 理由 / 预期 | 验收 |
|---|---|---|---|
| **P0** | 在 Mac 上实测性能和 Photomator 兼容性 | 最大的未知数；见 §12 清单 | 清单全部打勾 |
| **P1** | HEIC 快速缩略图：用 libheif 解码 HEIF 自带的 320–512px `thmb` 缩略图项 | iPhone 照片的主要瓶颈；预计每张 2 s → 100 ms 以内（未测） | 数据 B 中 HEIC 单核 ≤ 300 ms |
| **P1** | WASM 解码器只在 1–2 个 worker 中加载，闲置 20 秒后释放 | 混合格式内存 1.3 GB | 数据 B < 1 GB |
| **P1** | 第二次打开的基准测试（`BENCH_WARM=1`）纳入验收 | §1.2 的目标还没测过 | < 2 s |
| **P2** | Tauri 桌面版（4a）：在 Mac 上调用系统 ImageIO 解码 HEIC / RAW，支持 Finder 标签和存储卡导入 | 浏览器方案的性能上限；HEIC 能快 10 倍以上，内存也小 | 同一数据集下全部缩略图 ≤ 浏览器版的 1/3 |
| **P2** | 计划里还没兑现的功能：自定义快捷键、显示对焦点（读 makernote）、ISO / 焦段筛选 | 原计划承诺过 | — |
| **P3** | 界面细节：点击放大时让点击位置保持在光标下；720–1220px 宽度下顶栏的布局；交付后按钮状态；只读模式下设置项的说明文字 | 探索式测试留下的问题 | — |
| **P3** | 两个 sidecar 同时存在（`IMG.xmp` + `IMG.CR3.xmp`）时的合并策略 | 用 darktable 的用户会遇到 | — |
| **P4** | 客户协作（4b）：R2 + D1 + Durable Objects | 有需求再做 | — |

---

## 12. 需要在 Mac 上手动验证的清单（P0）

准备：`npm run build && npm run preview`，用 Chrome 打开，准备一个 2,000–3,000 张的真实拍摄文件夹（复制一份，不要用唯一的原件）。

**性能**
- [ ] 状态栏显示的「首屏」< 1.5 s
- [ ] 「全部缩略图」耗时：记录相机型号、张数、Mac 型号；纯 RAW 预计 30–45 秒
- [ ] 关闭后再打开同一个文件夹，2 秒内全部可浏览
- [ ] 在放大视图中连续按 → 20 次，没有明显卡顿
- [ ] 活动监视器中 Chrome 的总内存 < 2 GB

**Photomator**
- [ ] 标记几张照片（星级 + 色标 + 保留 / 淘汰），用 Photomator 打开文件夹，看是否显示 XMP 里的星级和色标
- [ ] RAW+JPEG 成对的照片在 Photomator 中怎样显示
- [ ] 交付后打开 `_Picks/`：文件齐全，sidecar 跟着照片走
- [ ] 带「5★」这类非英文名字的子文件夹（开启「按星级分文件夹」）在 Finder 和 Photomator 中显示正常
- [ ] 还原后文件夹恢复原样

**结果怎么改设计**
- Photomator 读取 XMP → 交付默认改为「不移动、只写 XMP」
- Photomator 不读取 XMP → 保持文件夹交付；按星级分文件夹改为默认开启

---

## 13. 测试与开发流程

### 13.1 测试
| 层 | 工具 | 内容 |
|---|---|---|
| 单元（node） | Vitest | 格式解析逐项对照 exiftool 的标准答案（`tests/fixtures/groundtruth.json`）、模糊测试（截断 / 翻转字节 / 自循环 IFD）、XMP 往返 + exiftool 校验、AI 阈值、用假 pool 驱动的 Session / store / 键盘测试 |
| 浏览器 | Vitest browser + Chromium | WASM 解码、8 种方向逐像素比对、DC 解码误差、SQLite、OPFS 上的交付和还原（含模拟崩溃） |
| 端到端 | Playwright | 可写路径：把样本复制到 OPFS，调用 `window.__culling.openHandle`；只读路径：`setInputFiles` 选文件夹 |
| 性能 | `npm run bench` | 必须加 `E2E_PROD=1`；输出 `bench-results/*.json`，含逐格式耗时 |
| 诊断 | `tests/e2e/profile.spec.ts`、`trace.spec.ts` | CPU profile（含总耗时）和主线程任务追踪 |

**已知坑：**
- 测量性能时必须关闭 Playwright trace（`E2E_TRACE` 不要设）。它的 DOM 快照会制造假的 long task。
- headless Chromium 在内存中的 OPFS 会把非 ASCII 目录名（`5★`、`é`）合并到父目录，测试里要用 `ratingDirStyle: 'ascii'`。
- `setInputFiles` 选择带中文和括号的路径时会卡住。

### 13.2 多 agent 开发流程（这次验证有效的做法）
1. **先定接口再并行**：先写 `src/core/types.ts` 和各模块的空函数，再把模块分给 agent，每个 agent 只能改自己的目录，不能改 `package.json` 或配置文件。4 个模块合并时几乎没有冲突。
2. **agent 工作目录的准备**：
   - 先 `git reset --hard <目标分支>`：worktree 默认基于旧提交创建。
   - `node_modules` 用 `cp -al` 硬链接复制：软链接会被 Vite 的文件访问白名单拒绝。
   - 测试样本可以用软链接。
3. **分阶段提交**：有一个 agent 因为额度用完中途停了，幸好代码还在磁盘上。要求 agent 每完成一个可测试的单元就提交一次。
4. **每个阶段的出口条件都要包括「审查 + QA」**：集成完成后，同时派一个代码审查 agent（每个 bug 先写失败测试再修）和一个探索式测试 agent（多种宽度截图，像真实用户一样操作），一次就找出了 30 个 bug。
5. **性能问题先测量再动手**：每次优化之前，先用 `thumbStatsByFormat`、`perfLog` 和 profile 找到瓶颈，例如元数据被阻塞、主线程消息处理慢、Chrome 不支持缩小解码。

---

## 14. 风险和对策

| 风险 | 状态 | 对策 |
|---|---|---|
| Photomator 不读 XMP | 未验证 | 默认文件夹交付（一定可用） |
| HEIC / JXL 太慢 | **已确认**（1.5–2.5 s / 张） | P1：HEIF 缩略图项；P2：Tauri + ImageIO |
| 内嵌预览分辨率低（旧款 Sony 1616px、Panasonic 1920px） | 已确认 | 放大视图提示；需要时用 LibRaw 解码 |
| WASM 内存不释放 | 已确认（混合格式 1.3 GB） | P1：限制加载 WASM 的 worker 数，闲置释放 |
| 闭眼检测漏判 | 未校准 | 收集真实闭眼样本，必要时把阈值降到 0.4 |
| 多标签页同时打开 | 已处理 | Web Lock + 降级为内存模式 + 状态栏提示 |
| 交付中途崩溃 | 已测试 | 先写日志再操作，按磁盘实际状态还原 |
| 存储卡文件夹重复使用，旧标记套到新照片上 | 已处理 | 只为大小和 mtime 都没变的文件恢复标记 |
| 外置硬盘 / SD 卡读取慢 | 未测 | 后续：针对外置盘降低并发；提供「先导入到 SSD」选项（Tauri 版） |
| Chrome 权限需要重新授权 | 已处理 | IndexedDB 记住目录句柄，最近打开列表一键重新授权 |
