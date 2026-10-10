# Culling-Photo 实施计划

> 一个运行在 Chrome 中的高性能本地照片筛选（culling）工具。
> 照片始终留在本机，应用本身可以在 localhost 运行，也可以部署到 Cloudflare Pages。
> 筛选结果交给 **Photomator** 做后期。

---

## 1. 目标与约束

### 1.1 已确定的需求
| 项目 | 决定 |
|---|---|
| 浏览器 | **Chrome / Edge（桌面版）**，因为需要 File System Access API 来读写本地文件夹 |
| 平台 | macOS（Photomator 只有 Mac / iOS 版） |
| 单次规模 | **2,000–3,000 张**（必须能扩展到 5,000 张而不崩） |
| 格式 | 主流 RAW + JPEG / HEIC / TIFF / PNG / WebP / AVIF / JXL，支持 RAW+JPEG 配对 |
| 后期 | Photomator：交付方式必须让 Photomator 能直接使用筛选结果 |
| 部署 | `localhost` 和 Cloudflare Pages（纯静态站点，没有服务端处理，照片不上传） |

### 1.2 性能目标（验收标准）
| 指标 | 目标 | 测量方式 |
|---|---|---|
| 打开 3,000 张的文件夹，首屏缩略图出现 | < 1.5 s | Performance mark |
| 3,000 张全部缩略图生成（首次） | < 60 s（M 系列 Mac，SSD） | 基准测试脚本 |
| 第二次打开同一文件夹（有缓存） | < 2 s 全部可浏览 | 基准测试脚本 |
| 放大视图切换到下一张（已预载） | < 50 ms | 从按键到绘制 |
| 切换到未预载的照片 | < 250 ms | 同上 |
| 按键评分到 UI 反馈 | < 16 ms（一帧） | Long task 监测 |
| 网格滚动 | 稳定 60 fps，没有空白格 | Chrome DevTools |
| 主线程 long task | 浏览时为 0 个 > 50 ms 的任务 | PerformanceObserver |
| 内存占用 | < 2 GB（3,000 张） | `performance.measureUserAgentSpecificMemory` |

### 1.3 非目标（暂不做）
- 不做任何修图或调色（交给 Photomator）
- 不上传原图到云端
- v1 不支持 Safari / Firefox 的写入功能（只提供只读降级）
- 视频只显示占位图和基础信息，不提供播放器（以后再考虑）

---

## 2. 用户工作流

```
① 选择文件夹 / 存储卡
   ↓  扫描文件 → 读取 EXIF → 抽取内嵌预览 → 生成缩略图（后台 Worker）
② 速览（网格 + 放大视图）
   ↓  键盘快速标记：P 保留 / X 淘汰 / 1–5 星 / 6–9 色标
③ 连拍分组和对比
   ↓  相似照片自动分组，2–4 张并排对比，100% 查看对焦
④ 复核
   ↓  按条件筛选（只看保留 / 未标记 / ≥3 星），撤销 / 重做
⑤ 交付给 Photomator
      → 写 XMP sidecar + 把选中照片移动或复制到 `_Picks/` 文件夹
      → 淘汰的照片移动到 `_Rejects/`（不直接删除）
```

---

## 3. 格式支持矩阵

### 3.1 预览获取策略（核心性能来源）
**原则：浏览阶段绝对不完整解码 RAW。** 只读取文件头部几 MB，抽取相机已经嵌入的 JPEG 预览（Photo Mechanic 也是这样做的）。

| 格式 | 容器结构 | 内嵌预览位置 | 预览常见尺寸 | 后备方案 |
|---|---|---|---|---|
| CR2（Canon 旧款） | TIFF | IFD0 的 StripOffsets | 全尺寸 | LibRaw-WASM |
| **CR3**（Canon 新款） | ISO-BMFF | `uuid` → `PRVW`（1620px）/ `mdat` 中的全尺寸 JPEG | 全尺寸 | LibRaw-WASM |
| NEF / NRW（Nikon） | TIFF | SubIFD 中的 JpgFromRaw | 全尺寸 | LibRaw-WASM |
| ARW（Sony） | TIFF | PreviewImage | 1616px 到全尺寸，视机型而定 | LibRaw-WASM |
| RAF（Fuji） | 自有 header + TIFF | header 中直接给出 JPEG 的 offset | 1920px 到全尺寸 | LibRaw-WASM |
| ORF（Olympus / OM） | TIFF + MakerNote | MakerNote 中的 PreviewImage | 约 3200px | LibRaw-WASM |
| RW2（Panasonic） | 类 TIFF | JpgFromRaw | 1920px | LibRaw-WASM |
| DNG（含 iPhone ProRAW） | TIFF | SubIFD 中 NewSubFileType=1 的 JPEG | 不固定 | LibRaw-WASM |
| PEF / SRW / 3FR / IIQ | TIFF | PreviewImage | 不固定 | LibRaw-WASM（P2 优先级） |
| JPEG | — | 本身即可直接显示，另外读 EXIF 缩略图做极速首屏 | — | — |
| HEIC / HEIF | ISO-BMFF | 先抽 `thmb` 缩略图项；全图用 libheif-WASM 解码 | — | — |
| AVIF / WebP / PNG / GIF | — | Chrome 原生解码 | — | — |
| TIFF | TIFF | 有内嵌缩略图就用；没有就用 utif 解码 | — | — |
| JXL | — | Chrome 不原生支持，用 jxl-WASM 解码 | — | — |
| MOV / MP4 | — | `<video>` 抽取第一帧做缩略图 | — | — |

### 3.2 RAW+JPEG 配对
- 同一文件夹中 basename 相同（不分大小写）的文件，合并为**一个逻辑照片**。
- 显示时优先用 JPEG，因为它解码快、色彩就是相机直出的效果。
- 评分同时作用于两个文件：两个都写 XMP，移动时两个一起移动。
- 设置项可选择交付哪一个：「只交付 RAW」「只交付 JPEG」「两个都交付」。

### 3.3 方向和色彩
- 读取 EXIF Orientation，并用 `createImageBitmap(..., { imageOrientation: 'from-image' })` 处理。
- 内嵌预览一般是 sRGB；HEIC / AVIF 可能是 Display P3。Canvas 使用 `colorSpace: 'display-p3'`，确保在 Mac 屏幕上色彩准确。

---

## 4. 架构

```
┌──────────────────────────── Main thread (UI) ─────────────────────────────┐
│  SolidJS UI：Grid（虚拟化）· Loupe（WebGL）· Compare · Filmstrip · 键盘   │
│  Store（细粒度响应式）←→ Command bus（undo/redo）                          │
└───────┬─────────────────────────┬─────────────────────────┬───────────────┘
        │ Comlink                 │ Comlink                 │ Comlink
┌───────▼────────┐   ┌────────────▼─────────────┐   ┌───────▼────────────┐
│ Scanner Worker │   │ Preview Worker Pool (N)   │   │ DB Worker          │
│ 遍历目录       │   │ 解析容器 → 抽取 JPEG      │   │ SQLite-WASM        │
│ 配对 RAW+JPEG  │   │ 解码 → 缩放 → 编码 WebP   │   │ (OPFS SAH pool)    │
│ 读 stat        │   │ 读 EXIF                   │   │ 照片 / 评分 / 历史 │
└───────┬────────┘   └────────────┬─────────────┘   └───────┬────────────┘
        │                         │                         │
┌───────▼─────────────────────────▼─────────────────────────▼───────────────┐
│ FileSource 抽象层                                                          │
│  ├─ FsAccessSource（Chrome：FileSystemDirectoryHandle，读写）              │
│  ├─ InputDirSource（降级：<input webkitdirectory>，只读）                  │
│  └─ (未来) TauriSource（原生 Rust 后端）                                   │
└───────────────────────────────────────────────────────────────────────────┘
┌─────────────────────── 缓存层 ───────────────────────┐   ┌─ AI Worker（P3）─┐
│ L1 内存：ImageBitmap LRU（屏幕尺寸，约 12 张）        │   │ 模糊 / 闭眼     │
│ L2 内存：缩略图 Blob URL / Bitmap（全部）             │   │ pHash / CLIP    │
│ L3 OPFS：缩略图 + 屏幕预览 WebP（按 session 存储）    │   │ ONNX Web/WebGPU │
└──────────────────────────────────────────────────────┘   └─────────────────┘
```

### 4.1 技术栈
| 层 | 选择 | 理由 |
|---|---|---|
| 构建 | Vite + TypeScript（strict） | 快，Worker / WASM 支持好 |
| UI | **SolidJS** | 细粒度响应式，3,000 个格子评分变化时不会整片重渲染 |
| Worker 通信 | Comlink + Transferable（ArrayBuffer / ImageBitmap） | 零拷贝传输 |
| 数据库 | `@sqlite.org/sqlite-wasm`（OPFS SAH pool VFS） | 不需要 COOP/COEP，同步 API，速度快 |
| 句柄持久化 | IndexedDB 存 `FileSystemDirectoryHandle` | 重开时只需重新授权 |
| 图像缩放 | `OffscreenCanvas` + `createImageBitmap(resizeWidth)`，高质量缩放 | 原生实现，可在 Worker 中跑 |
| 缩略图编码 | `OffscreenCanvas.convertToBlob({type:'image/webp', quality:0.8})` | 体积小 |
| 放大视图渲染 | WebGL2（texture + 平移缩放 shader） | 100% / 200% 缩放流畅，可叠加高光警告 |
| RAW 完整解码 | LibRaw 编译的 WASM（按需懒加载） | 只在预览过小又要 100% 查看时使用 |
| HEIC | libheif-WASM（懒加载） | Chrome 不支持 HEIC |
| TIFF | utif2 | 轻量 |
| JXL | @jsquash/jxl（懒加载） | |
| 测试 | Vitest（单元测试）+ Playwright（E2E 和基准测试） | |
| 部署 | Cloudflare Pages（`_headers` 设置 COOP/COEP 和 CSP） | |

### 4.2 关键设计决定
1. **只读文件头部**：`file.slice(0, 4MB)` 先尝试解析；如果 preview offset 超出范围，再精确 slice 那一段。不读取整个 50MB 的 RAW。
2. **Worker Pool 大小**：`max(2, navigator.hardwareConcurrency - 2)`。任务队列有优先级：**可视区域 > 预载邻居 > 后台全量**，滚动时取消已经不可见的任务。
3. **两级预览**：
   - `thumb`：长边 384px，WebP，大约 25KB/张，3,000 张约 75MB，全部存入 OPFS
   - `screen`：长边 = 屏幕物理像素（例如 3024px），按需生成，存入 OPFS 的 LRU（上限 1.5GB，可配置）
   - `full`：直接使用内嵌 JPEG，或者用 LibRaw 解码，只在 100% 查看时临时生成，不持久化
4. **Session 指纹**：用 `目录路径 + 文件数 + Σ(size, mtime)` 识别同一批照片；单个文件则以 `relPath + size + mtime` 作为缓存键。
5. **所有写操作走 Command 模式**，支持 undo/redo，并以 debounce（500ms）批量写入 XMP。

---

## 5. 数据模型（SQLite）

```sql
CREATE TABLE session (
  id TEXT PRIMARY KEY, root_name TEXT, fingerprint TEXT,
  created_at INTEGER, opened_at INTEGER, settings_json TEXT
);

CREATE TABLE photo (               -- 逻辑照片（RAW+JPEG 合并后为一条）
  id INTEGER PRIMARY KEY,
  session_id TEXT, basename TEXT, dir_rel TEXT,
  capture_ts INTEGER,             -- 排序主键（含亚秒）
  camera TEXT, lens TEXT, iso INTEGER, shutter REAL, aperture REAL, focal REAL,
  width INTEGER, height INTEGER, orientation INTEGER,
  rating INTEGER DEFAULT 0,       -- 0–5
  flag INTEGER DEFAULT 0,         -- 1 保留 / -1 淘汰 / 0 未标记
  label TEXT,                     -- red/yellow/green/blue/purple
  group_id INTEGER,               -- 连拍 / 相似分组
  blur_score REAL, eyes_closed INTEGER, face_count INTEGER,
  phash BLOB, embedding BLOB,
  thumb_state INTEGER             -- 0 未处理 / 1 已生成 / 2 失败
);

CREATE TABLE file (                -- 物理文件
  id INTEGER PRIMARY KEY, photo_id INTEGER,
  rel_path TEXT, ext TEXT, kind TEXT, -- raw/jpeg/heic/...
  size INTEGER, mtime INTEGER,
  preview_offset INTEGER, preview_length INTEGER, preview_w INTEGER, preview_h INTEGER,
  xmp_state INTEGER                -- 0 无 / 1 已同步 / 2 待写入
);

CREATE TABLE history (id INTEGER PRIMARY KEY, ts INTEGER, cmd_json TEXT, undone INTEGER);

CREATE INDEX idx_photo_sort ON photo(session_id, capture_ts);
CREATE INDEX idx_photo_filter ON photo(session_id, flag, rating);
```

内存中保留一份 `Float64Array / Int8Array` 列式副本，供网格排序和筛选使用（3,000 行可以在 1ms 内筛完），SQLite 只负责持久化。

---

## 6. 交付给 Photomator

> ⚠️ Photomator 会读取哪些元数据，需要在 **Phase 0 实测**后才能定案。以下是分层策略，保证至少有一种方式一定可行。

| 方式 | 内容 | 可靠性 | 默认 |
|---|---|---|---|
| **A. 文件夹交付** | 保留的照片移动或复制到 `_Picks/`，淘汰的移动到 `_Rejects/`；可按星级分子文件夹 `_Picks/5★/` | ✅ 100%：Photomator 直接打开这个文件夹即可 | **开启** |
| B. XMP sidecar | `IMG_0001.CR3` → `IMG_0001.xmp`，内容含 `xmp:Rating`、`xmp:Label`，淘汰写 `xmp:Rating=-1` | 待验证 Photomator 是否读取（Lightroom / Capture One / darktable 均会读取） | 开启 |
| C. 内嵌 XMP（只限 JPEG / HEIC / TIFF / DNG） | 将 rating 直接写入文件内的 XMP 段 | 待验证；会修改原文件，所以默认关闭 | 关闭 |
| D. 清单导出 | CSV / TXT 文件名列表 | 可用于其他工具 | 按需使用 |

**移动文件的实现：**
- 优先使用 `FileSystemHandle.move()`。同一卷内是瞬间完成的 rename，3,000 张也只需几秒。
- 如果 `move()` 不可用，就用 stream 复制，校验文件大小后再 `removeEntry()` 原文件（需要显示进度条）。
- 所有移动记录写入 `_culling-log.json`，提供「还原」按钮，可以撤销全部移动。
- **默认从不真正删除文件。**

**Phase 0 的 Photomator 验证清单：**
- [ ] Photomator 打开文件夹时，是否显示 XMP sidecar 中的 rating 和 label？
- [ ] 是否读取 JPEG / HEIC 内嵌的 XMP rating？
- [ ] RAW+JPEG 同时放在一个文件夹时，Photomator 如何显示？
- [ ] macOS Finder 标签：Chrome 无法设置，记录为限制，留待将来的 Tauri 版本

---

## 7. UI 和快捷键

### 7.1 视图
- **网格视图（G）**：虚拟化，只渲染可视区域 ±2 屏；格子尺寸可以用滑杆调整；角标显示星级 / 旗标 / 色标 / RAW+J 标记 / 分组编号。
- **放大视图（E / Enter）**：单张全屏，底部胶片条，可开关 EXIF 浮层。
- **对比视图（C）**：2–4 张同步平移和缩放，适合比较连拍。
- **分组视图**：连拍按组折叠，每组显示推荐的最佳一张。

### 7.2 快捷键（可自定义，默认值参考 Photo Mechanic / Lightroom）
| 键 | 动作 |
|---|---|
| ← → / ↑ ↓ | 上一张 / 下一张（网格中移动） |
| Space | 快速 100% 查看（按住生效，放开还原） |
| Z | 切换「适合屏幕」和 100% 缩放 |
| P / X / U | 保留 / 淘汰 / 取消标记 |
| 1–5 / 0 | 设置星级 / 清除星级 |
| 6–9 | 红 / 黄 / 绿 / 蓝色标 |
| Caps Lock | 自动前进：标记后自动跳到下一张 |
| ⌘Z / ⇧⌘Z | 撤销 / 重做 |
| F | 筛选菜单 |
| ⇧ + 方向键 | 多选 |
| H | 高光 / 阴影溢出警告 |
| I | 显示 / 隐藏 EXIF 信息 |
| ? | 显示快捷键列表 |

### 7.3 筛选和排序
- 按拍摄时间（默认）、文件名、星级、模糊分数排序
- 筛选条件：旗标、星级 ≥ N、色标、相机 / 镜头、焦段、ISO 范围、文件类型、「只看未标记」

---

## 8. AI 辅助（Phase 3）

全部在浏览器本地运行，模型按需下载并缓存在 Cache Storage 中。

| 功能 | 方法 | 成本 | 用途 |
|---|---|---|---|
| 模糊 / 失焦 | 在 thumb 和 screen 尺寸上计算 Laplacian variance，同时做中心区域与全图的比较 | 约 2ms/张（JS + SIMD） | 标出可能模糊的照片 |
| 连拍分组 | 拍摄时间间隔 < 1.5s **且** pHash 汉明距离 < 阈值 | 约 1ms/张 | 自动分组 |
| 语义相似 | CLIP / SigLIP（ONNX Runtime Web，WebGPU）求 embedding 再做余弦相似度 | 约 15ms/张（WebGPU） | 跨时间段的相似照片分组 |
| 人脸和闭眼 | MediaPipe Face Landmarker，用 eye blendshapes 判断 | 约 20ms/张 | 在人像连拍中标出闭眼的照片 |
| 每组推荐 | 综合清晰度、闭眼、曝光直方图打分 | — | 推荐每组最佳一张 |
| Smart Cull | 建议淘汰模糊、闭眼和重复的照片 | — | **只给建议**，最终由用户确认 |

---

## 9. 目录结构

```
culling-photo/
├─ PLAN.md
├─ package.json / vite.config.ts / tsconfig.json
├─ public/
│  └─ _headers                 # Cloudflare Pages：COOP/COEP、CSP、缓存策略
├─ src/
│  ├─ main.tsx
│  ├─ app/                     # 路由、全局布局、快捷键注册
│  ├─ ui/
│  │  ├─ grid/                 # 虚拟网格
│  │  ├─ loupe/                # WebGL 放大视图
│  │  ├─ compare/
│  │  ├─ filmstrip/
│  │  └─ panels/               # EXIF、筛选、设置
│  ├─ store/                   # Solid store、列式索引、commands（undo/redo）
│  ├─ fs/
│  │  ├─ FileSource.ts         # 接口
│  │  ├─ FsAccessSource.ts
│  │  └─ InputDirSource.ts
│  ├─ formats/
│  │  ├─ detect.ts             # magic bytes 识别
│  │  ├─ tiff.ts               # 通用 TIFF/IFD 解析（CR2/NEF/ARW/DNG/ORF/RW2/PEF）
│  │  ├─ bmff.ts               # ISO-BMFF（CR3/HEIC/AVIF）
│  │  ├─ raf.ts
│  │  ├─ exif.ts               # EXIF tag 映射
│  │  └─ xmp.ts                # XMP 读写
│  ├─ workers/
│  │  ├─ scanner.worker.ts
│  │  ├─ preview.worker.ts
│  │  ├─ db.worker.ts
│  │  └─ ai.worker.ts
│  ├─ pipeline/
│  │  ├─ scheduler.ts          # 优先级队列 + 取消
│  │  └─ cache.ts              # L1/L2/L3 缓存
│  ├─ decoders/                # 懒加载 WASM：libraw、libheif、jxl、utif
│  ├─ export/                  # 文件夹交付、XMP 批量写入、日志 / 还原
│  └─ ai/
├─ tests/
│  ├─ fixtures/                # 每种格式的小样本（git-lfs，或在 CI 中下载）
│  ├─ unit/                    # 解析器和 exiftool 输出对照
│  └─ e2e/                     # Playwright + 基准测试
└─ scripts/
   ├─ gen-fixtures.sh          # 用 exiftool 生成标准答案 JSON
   └─ bench.ts                 # 3,000 张基准测试
```

---

## 10. 里程碑

### Phase 0：技术验证 Spike（3–4 天）
**目标：证明「快」和「Photomator 能接收结果」这两件事。**
- [ ] Vite + Solid + TS 项目骨架，ESLint / Prettier / Vitest
- [ ] `FsAccessSource`：选择文件夹，递归列出文件，持久化句柄
- [ ] `tiff.ts`、`bmff.ts`、`raf.ts`：实现 CR3 / NEF / ARW / RAF / DNG 的内嵌预览抽取
- [ ] 用 exiftool `-b -PreviewImage / -JpgFromRaw` 的输出作为标准答案，逐字节对比
- [ ] 基准测试：在 Worker Pool 中处理 3,000 张 RAW，测量抽取 + 缩略图的总耗时
- [ ] 完成 Photomator 验证清单（第 6 节），确定交付默认值
- [ ] 测试 `FileSystemHandle.move()` 在本地目录上的可用性
- **出口条件**：3,000 张 < 60s；至少一种 Photomator 交付方式已验证可行

### Phase 1：MVP（2 周）
- [ ] 扫描器：RAW+JPEG 配对、拍摄时间排序（读 EXIF 子秒）
- [ ] 优先级调度器（可视区域优先、滚动时取消）
- [ ] 虚拟网格 + 缩略图 L2/L3 缓存
- [ ] 放大视图：Canvas2D 版本，预载前后各 3 张
- [ ] 完整快捷键评分（P / X / U / 0–5 / 6–9、自动前进）
- [ ] undo / redo
- [ ] SQLite session：关闭后重新打开，所有标记都还在
- [ ] XMP sidecar 写入（debounce 批量写），并读取已有的 XMP
- [ ] 文件夹交付（`_Picks/`、`_Rejects/`）、操作日志和一键还原
- [ ] 基础筛选（旗标 / 星级 / 未标记）
- [ ] 部署到 Cloudflare Pages
- **出口条件**：用真实的 2,500 张婚礼或活动照片完成一次端到端 cull，并在 Photomator 中打开结果

### Phase 2：性能和专业功能（2 周）
- [ ] WebGL2 放大视图：100% / 200%，平移惯性，高光 / 阴影警告
- [ ] 屏幕尺寸预览的 L3 LRU 缓存，并为 OPFS 设置容量上限
- [ ] 对比视图（2–4 张，同步缩放）
- [ ] HEIC（libheif）、TIFF（utif）、JXL、视频缩略图
- [ ] ORF / RW2 / PEF / SRW 格式
- [ ] LibRaw-WASM 后备方案：预览太小时按需解码全图
- [ ] EXIF 面板和直方图
- [ ] 进阶筛选（相机、镜头、焦段、ISO、文件类型）
- [ ] 只读降级模式（`webkitdirectory`），评分导出为 XMP zip
- [ ] 性能回归 CI（Playwright 基准测试，超过阈值即失败）
- **出口条件**：第 1.2 节的所有性能指标达标

### Phase 3：AI 辅助（2 周）
- [ ] 模糊分数（Worker + SIMD）
- [ ] pHash 和时间间隔连拍分组，加上分组视图
- [ ] MediaPipe 闭眼检测
- [ ] CLIP embedding（WebGPU，没有 WebGPU 时降级为 WASM）
- [ ] 每组推荐最佳一张，加上 Smart Cull 建议面板
- **出口条件**：AI 建议的淘汰准确率 ≥ 85%（以人工标记作为对照）

### Phase 4：可选扩展
- **4a. Tauri 桌面版**：实现 `TauriSource`（Rust 并行处理 + mmap）、存储卡导入和双备份、Finder 标签、Safari 用户也能使用
- **4b. 客户协作**：将 2048px 预览上传到 R2，评分存在 D1，用 Durable Objects 做实时同步，用 Cloudflare Access 保护分享链接

---

## 11. 测试策略
- **格式样本库**：每种相机或格式至少准备 2 个样本（不同机型），来源包括 raw.pixls.us 和自己的相机；放在 `tests/fixtures/`，用 git-lfs 管理。
- **解析器对照测试**：用 exiftool 导出的 JSON 和预览二进制作为标准答案，对比 offset、length、orientation、拍摄时间。
- **E2E**：Playwright 启动 Chrome，用 `--use-fake-ui-for-media-stream` 等参数加 mock 的 directory handle，测试评分 → XMP → 交付的完整流程。
- **基准测试**：`scripts/bench.ts` 自动生成 3,000 个文件的测试文件夹（复制样本加改名），记录第 1.2 节的指标，作为 CI artifact 输出。
- **数据安全测试**：在交付过程中模拟中断（关闭标签页），确认可以从日志还原，没有文件丢失。

---

## 12. 风险和对策
| 风险 | 影响 | 对策 |
|---|---|---|
| Photomator 不读 XMP sidecar | 星级无法自动带过去 | 以文件夹交付为主；可按星级分子文件夹 |
| 部分机型内嵌预览太小（旧款 Sony、Panasonic） | 100% 查看对焦不准 | 显示「低分辨率预览」提示，并提供按需 LibRaw 解码 |
| CR3 结构因机型而变化 | 抽取失败 | 用 exiftool 对照测试，失败时自动转用 LibRaw |
| OPFS 空间不足 | 缓存失败 | 使用 `navigator.storage.persist()`，设置 LRU 上限，提供清除缓存按钮 |
| Chrome 权限需要重新授权 | 每次重开都要点击 | 持久化句柄，并在 Chrome 中请求持久权限 |
| 3,000 张 ImageBitmap 占满内存 | 页面崩溃 | 缩略图用 Blob URL 加 `<img decoding=async>`，只有 L1 保留 Bitmap，并主动调用 `close()` |
| 移动文件时中断 | 文件状态不一致 | 先写日志，再执行移动，失败可还原 |
| 外置硬盘 / SD 卡读取慢 | 首屏变慢 | 降低并发、顺序读取；可选「先导入到本地 SSD」 |

---

## 13. 待确认事项
1. 主要使用的相机型号？（决定 Phase 0 优先测试哪些格式）
2. Photomator 是用「打开文件夹」还是「导入到照片图库」的流程？
3. 淘汰的照片：默认移到 `_Rejects/`，还是只做标记、不移动？
4. 是否需要存储卡导入功能（复制 + 改名 + 双备份）？如果需要，Phase 4a 的优先级要提高。
