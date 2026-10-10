import { createSignal, lazy, Match, onCleanup, onMount, Show, Suspense, Switch } from 'solid-js';
import { store } from '../store/store';
import { Session, session, setSession } from './session';
import { FileListSource, FsAccessSource, type FileSource } from '../fs/FileSource';
import { ensurePermission, rememberRecent, type RecentEntry } from '../fs/recent';
import { Welcome } from '../ui/Welcome';
import { TopBar } from '../ui/TopBar';
import { StatusBar } from '../ui/StatusBar';
import { Grid } from '../ui/Grid';
import { Loupe } from '../ui/Loupe';
import { Compare } from '../ui/Compare';
import { InfoPanel } from '../ui/InfoPanel';
import { HelpDialog, SettingsDialog } from '../ui/Dialogs';
import { handleKey, handleKeyUp } from '../ui/keyboard';
import { wireSession } from './wiring';
import { emptyProgress } from '../store/store';

const DeliverDialog = lazy(() => import('../ui/DeliverDialog'));

export function App() {
  const { state, actions } = store;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const openSource = async (source: FileSource) => {
    setBusy(true);
    setError('');
    try {
      await session?.dispose();
      const s = new Session();
      setSession(s);
      await wireSession(s, source);
      const r = await s.open(source, s.persist);
      if (r.photos === 0) {
        actions.toast('这个文件夹里没有找到照片', 4000);
      }
    } catch (e) {
      console.error(e);
      setError(`打开失败：${(e as Error).message ?? e}`);
      actions.setState('screen', 'welcome');
    } finally {
      setBusy(false);
    }
  };

  const openHandle = async (h: FileSystemDirectoryHandle) => {
    if (!(await ensurePermission(h, 'readwrite'))) {
      if (!(await ensurePermission(h, 'read'))) {
        setError('没有获得文件夹访问权限');
        return;
      }
    }
    void rememberRecent(h);
    await openSource(new FsAccessSource(h));
  };

  const close = async () => {
    await session?.dispose();
    setSession(undefined);
    actions.setState({ screen: 'welcome', photos: [], current: -1, selection: [], dialog: '', progress: emptyProgress() });
  };

  onMount(() => {
    const kd = (e: KeyboardEvent) => {
      if (handleKey(e)) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => handleKeyUp(e);
    const bu = () => void session?.flushMarks();
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('beforeunload', bu);
    document.addEventListener('visibilitychange', bu);
    onCleanup(() => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('beforeunload', bu);
      document.removeEventListener('visibilitychange', bu);
    });
    // Test / automation hooks.
    (window as any).__culling = {
      store,
      openHandle: (h: FileSystemDirectoryHandle) => openSource(new FsAccessSource(h)),
      openFiles: (files: File[], name: string) => openSource(new FileListSource(files, name)),
      get session() {
        return session;
      },
    };
  });

  return (
    <>
    <Show when={state.toast}>
      <div class="toast" role="status">{state.toast}</div>
    </Show>
    <Switch>
      <Match when={state.screen === 'welcome'}>
        <Welcome
          busy={busy()}
          error={error()}
          onOpenHandle={openHandle}
          onOpenFiles={(files, name) => openSource(new FileListSource(files, name))}
          onOpenRecent={(r: RecentEntry) => openHandle(r.handle)}
        />
      </Match>
      <Match when={state.screen === 'library'}>
        <div class="app">
          <TopBar onClose={close} />
          <div class="main">
            <div class="stage">
              <Switch>
                <Match when={state.view === 'grid'}>
                  <Grid />
                </Match>
                <Match when={state.view === 'loupe'}>
                  <Loupe />
                </Match>
                <Match when={state.view === 'compare'}>
                  <Compare />
                </Match>
              </Switch>
            </div>
            <Show when={state.settings.showInfo}>
              <InfoPanel />
            </Show>
          </div>
          <StatusBar />
          <Show when={state.dialog === 'help'}>
            <HelpDialog />
          </Show>
          <Show when={state.dialog === 'settings'}>
            <SettingsDialog onAnalyzeFaces={() => session && import('./faces').then((m) => m.analyzeFaces(session!))} />
          </Show>
          <Show when={state.dialog === 'deliver'}>
            <Suspense>
              <DeliverDialog />
            </Suspense>
          </Show>
        </div>
      </Match>
    </Switch>
    </>
  );
}
