import { createResource, createSignal, For, Show } from 'solid-js';
import { forgetRecent, listRecent, type RecentEntry } from '../fs/recent';

export const supportsFsAccess = () => typeof (window as any).showDirectoryPicker === 'function';

export function Welcome(props: {
  onOpenHandle: (h: FileSystemDirectoryHandle) => void;
  onOpenFiles: (files: File[], name: string) => void;
  onOpenRecent: (r: RecentEntry) => void;
  busy: boolean;
  error: string;
}) {
  const [recent, { refetch }] = createResource(listRecent);
  const [over, setOver] = createSignal(false);
  let input!: HTMLInputElement;

  const pick = async () => {
    try {
      const h = await (window as any).showDirectoryPicker({ id: 'culling', mode: 'readwrite' });
      props.onOpenHandle(h);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.error(e);
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const items = [...(e.dataTransfer?.items ?? [])];
    for (const it of items) {
      const h = await (it as any).getAsFileSystemHandle?.();
      if (h && h.kind === 'directory') {
        props.onOpenHandle(h);
        return;
      }
    }
  };

  return (
    <div class="welcome" onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div class="card">
        <h1>Culling Photo</h1>
        <p class="sub">本地照片快速筛选：照片不会上传，所有处理都在你的电脑上完成。</p>
        <div class="drop" classList={{ over: over() }}>
          <div>把文件夹或存储卡拖到这里</div>
          <div class="actions">
            <Show when={supportsFsAccess()}>
              <button class="primary" onClick={pick} disabled={props.busy} data-testid="open-folder">
                打开文件夹…
              </button>
            </Show>
            <button onClick={() => input.click()} disabled={props.busy} title="不能写入 XMP 或移动文件；评分可以导出">
              {supportsFsAccess() ? '只读打开…' : '打开文件夹（只读）…'}
            </button>
          </div>
          <input
            ref={input}
            type="file"
            // @ts-expect-error non-standard attribute
            webkitdirectory=""
            multiple
            style={{ display: 'none' }}
            data-testid="open-readonly"
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              if (!files.length) return;
              const name = ((files[0] as any).webkitRelativePath || '').split('/')[0] || '照片';
              props.onOpenFiles(files, name);
              e.currentTarget.value = '';
            }}
          />
        </div>
        <Show when={props.busy}>
          <div class="notice">正在打开…</div>
        </Show>
        <Show when={props.error}>
          <div class="notice">{props.error}</div>
        </Show>
        <Show when={!supportsFsAccess()}>
          <div class="notice">当前浏览器不支持 File System Access API：只能以只读方式浏览和评分，评分可以导出为 XMP 压缩包或 CSV。建议使用 Chrome 或 Edge 桌面版。</div>
        </Show>
        <Show when={(recent() ?? []).length}>
          <div class="recent">
            <h2>最近打开</h2>
            <ul>
              <For each={recent()}>
                {(r) => (
                  <li>
                    <span class="n">{r.name}</span>
                    <span class="t">{new Date(r.openedAt).toLocaleString()}</span>
                    <button onClick={() => props.onOpenRecent(r)} disabled={props.busy}>
                      打开
                    </button>
                    <button class="ghost" title="从列表移除" onClick={async () => (await forgetRecent(r.id), refetch())}>
                      ✕
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <div class="features">
          <div>
            <b>RAW 秒开</b>直接读取 RAW 内嵌的 JPEG 预览：CR2/CR3、NEF、ARW、RAF、ORF、RW2、DNG、PEF、SRW，另外支持 HEIC、TIFF、JXL 等格式。
          </div>
          <div>
            <b>键盘驱动</b>P 保留，X 淘汰，1–5 星级，6–9 色标，Z 放大到 100%，C 对比。按 ? 查看全部快捷键。
          </div>
          <div>
            <b>交给 Photomator</b>写入 XMP sidecar，并把保留的照片移动到 _Picks 文件夹，淘汰的移到 _Rejects，可以一键还原。
          </div>
          <div>
            <b>智能辅助</b>检测模糊和过曝，自动分组连拍并推荐每组最佳一张；可选闭眼检测。
          </div>
        </div>
      </div>
    </div>
  );
}
