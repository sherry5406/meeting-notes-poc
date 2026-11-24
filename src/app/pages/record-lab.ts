import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AudioService } from '../core/audio.service';
import { DbService, RecordingMeta } from '../core/db.service';
import { clock, copyText, fmtBytes, fmtTime } from '../core/util';

const CHUNK_MS = 5000;

interface PlayerState {
  id: string;
  url: string;
  size: number;
  playableSec: number;
  recordedSec: number;
}

@Component({
  selector: 'app-record-lab',
  imports: [RouterLink],
  template: `
    <h2>實驗 1：錄音 ＋ IndexedDB</h2>
    <p class="hint">
      目標：驗證 Android 手機能長時間錄音、分段寫入 IndexedDB，並完整還原。
      每 {{ chunkSec }} 秒會寫入一個 chunk。
    </p>

    <section class="card">
      <div class="timer">{{ fmt(elapsed() / 1000) }}</div>
      <div class="status">
        狀態：<b>{{ statusLabel() }}</b>
        @if (wakeLockOn()) { ・ 螢幕常亮已啟用 }
      </div>
      <div class="grid2">
        <div>已寫入 chunk：<b>{{ chunks() }}</b></div>
        <div>已寫入大小：<b>{{ bytesFmt(bytes()) }}</b></div>
        <div>寫入失敗：<b [class.bad]="writeErrors() > 0">{{ writeErrors() }}</b></div>
        <div>格式：<b>{{ mime() || '-' }}</b></div>
      </div>

      @if (status() === 'idle') {
        <div class="row">
          <label>位元率
            <select #br>
              <option value="16000">16 kbps</option>
              <option value="32000" selected>32 kbps（建議）</option>
              <option value="64000">64 kbps</option>
            </select>
          </label>
          <label class="chk"><input type="checkbox" [checked]="useWakeLock()" (change)="useWakeLock.set(!useWakeLock())" /> 錄音時保持螢幕常亮</label>
        </div>
        <button class="btn primary" (click)="start(+br.value)">● 開始錄音</button>
      } @else {
        <div class="row">
          @if (status() === 'recording') {
            <button class="btn" (click)="pause()">⏸ 暫停</button>
          } @else if (status() === 'paused') {
            <button class="btn" (click)="resume()">▶ 繼續</button>
          }
          <button class="btn danger" (click)="stop()" [disabled]="status() === 'stopping'">■ 結束並保存</button>
        </div>
      }
      @if (error()) { <p class="bad">{{ error() }}</p> }
    </section>

    <section class="card">
      <h3>已保存的錄音</h3>
      <div class="row">
        <button class="btn small" (click)="refresh()">重新整理</button>
        <button class="btn small" (click)="persist()">要求永久儲存</button>
      </div>
      <p class="hint">{{ storageText() }}</p>
      @for (r of recordings(); track r.id) {
        <div class="rec">
          <div>
            <b>{{ r.startedAt.slice(5, 16).replace('T', ' ') }}</b>
            <span class="tag" [class.warn]="r.status !== 'completed'">{{ statusText(r.status) }}</span>
          </div>
          <div class="hint">{{ r.mimeType }} ・ {{ r.chunkCount }} chunks ・ {{ bytesFmt(r.size) }} ・ 計時 {{ fmt(r.elapsedMs / 1000) }}</div>
          <div class="row">
            <button class="btn small" (click)="play(r)">還原並播放</button>
            <a class="btn small" [routerLink]="['/asr']" [queryParams]="{ rec: r.id }">送去辨識</a>
            <a class="btn small" [routerLink]="['/diar']" [queryParams]="{ rec: r.id }">送去分離</a>
            <button class="btn small danger" (click)="remove(r)">刪除</button>
          </div>
          @if (player()?.id === r.id) {
            <audio controls [src]="player()!.url" class="audio"></audio>
            <div class="grid2">
              <div>可播放長度：<b>{{ fmt(player()!.playableSec) }}</b></div>
              <div>計時長度：<b>{{ fmt(player()!.recordedSec) }}</b></div>
            </div>
            <div [class.bad]="gap() > 3">
              差距 {{ gap().toFixed(1) }} 秒
              @if (gap() > 3) { ⚠ 超過 3 秒，可能有中斷或遺失 } @else { ✓ 正常 }
            </div>
            <a class="btn small" [href]="player()!.url" [download]="'rec-' + r.id + extFor(r.mimeType)">下載音檔</a>
          }
        </div>
      } @empty {
        <p class="hint">尚無錄音。</p>
      }
    </section>

    <section class="card">
      <h3>事件記錄（鎖屏／切換 App 測試用）</h3>
      <div class="row">
        <button class="btn small" (click)="copyReport()">複製診斷報告</button>
        <button class="btn small" (click)="log.set([])">清除</button>
      </div>
      <pre class="log">{{ log().join('\n') }}</pre>
    </section>
  `,
  styles: [
    `
      .timer { font-size: 3rem; font-variant-numeric: tabular-nums; text-align: center; margin: 0.25rem 0; }
      .status { text-align: center; margin-bottom: 0.5rem; }
      .rec { border-top: 1px solid var(--line); padding: 0.75rem 0; }
      .audio { width: 100%; margin: 0.5rem 0; }
    `,
  ],
})
export class RecordLab implements OnInit, OnDestroy {
  private db = inject(DbService);
  private audioSvc = inject(AudioService);

  protected readonly chunkSec = CHUNK_MS / 1000;
  protected status = signal<'idle' | 'recording' | 'paused' | 'stopping'>('idle');
  protected elapsed = signal(0);
  protected chunks = signal(0);
  protected bytes = signal(0);
  protected writeErrors = signal(0);
  protected mime = signal('');
  protected error = signal('');
  protected log = signal<string[]>([]);
  protected recordings = signal<RecordingMeta[]>([]);
  protected useWakeLock = signal(true);
  protected wakeLockOn = signal(false);
  protected storageText = signal('');
  protected player = signal<PlayerState | null>(null);

  protected fmt = fmtTime;
  protected bytesFmt = fmtBytes;

  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private meta?: RecordingMeta;
  private seq = 0;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private tickTimer?: number;
  private lastTick = 0;
  private wake?: WakeLockSentinel;
  private hiddenAt = 0;
  private chunksAtHidden = 0;

  private onVisibility = () => this.handleVisibility();

  protected statusLabel() {
    return { idle: '待機', recording: '錄音中', paused: '已暫停', stopping: '保存中…' }[this.status()];
  }

  protected statusText(s: RecordingMeta['status']) {
    return { recording: '未正常結束（可還原）', interrupted: '中斷', completed: '完成' }[s];
  }

  protected gap() {
    const p = this.player();
    return p ? Math.abs(p.playableSec - p.recordedSec) : 0;
  }

  protected extFor(mime: string) {
    return mime.includes('mp4') ? '.m4a' : mime.includes('ogg') ? '.ogg' : '.webm';
  }

  async ngOnInit() {
    document.addEventListener('visibilitychange', this.onVisibility);
    await this.refresh();
  }

  ngOnDestroy() {
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.clearInterval(this.tickTimer);
    if (this.status() !== 'idle') this.addLog('⚠ 離開頁面時仍在錄音，錄音器被中止');
    this.recorder?.state !== 'inactive' && this.recorder?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.releaseWake();
    const p = this.player();
    if (p) URL.revokeObjectURL(p.url);
  }

  protected addLog(msg: string) {
    this.log.update((l) => [`${clock()} ${msg}`, ...l].slice(0, 300));
  }

  protected async refresh() {
    const list = await this.db.listRecordings();
    // 上次沒有正常結束的錄音（頁面被殺、當機）會停在 recording 狀態
    for (const r of list) {
      if (r.status === 'recording' && r.id !== this.meta?.id) {
        r.status = 'interrupted';
        await this.db.putRecording(r);
      }
    }
    this.recordings.set(list);
    const e = await this.db.storageEstimate();
    this.storageText.set(
      e
        ? `儲存空間：已用 ${fmtBytes(e.usage)} / 配額 ${fmtBytes(e.quota)} ・ 永久儲存：${e.persisted ? '是' : '否'}`
        : '此瀏覽器無法查詢儲存空間',
    );
  }

  protected async persist() {
    const ok = await this.db.requestPersist();
    this.addLog(`要求永久儲存：${ok ? '已授予' : '未授予'}`);
    await this.refresh();
  }

  private pickMime(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  }

  protected async start(bitrate: number) {
    this.error.set('');
    if (!window.isSecureContext) {
      this.error.set('目前不是 HTTPS／localhost，瀏覽器不允許使用麥克風。');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      this.error.set('此瀏覽器不支援 MediaRecorder。');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch (e) {
      this.error.set(`無法取得麥克風：${(e as Error).message}。請在瀏覽器網站設定允許麥克風。`);
      return;
    }

    const mimeType = this.pickMime();
    this.recorder = new MediaRecorder(this.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: bitrate,
    });
    this.mime.set(this.recorder.mimeType);

    const id = `${Date.now()}`;
    this.meta = {
      id,
      startedAt: new Date().toISOString(),
      mimeType: this.recorder.mimeType,
      bitrate,
      status: 'recording',
      chunkCount: 0,
      size: 0,
      elapsedMs: 0,
    };
    this.seq = 0;
    this.chunks.set(0);
    this.bytes.set(0);
    this.writeErrors.set(0);
    this.elapsed.set(0);
    this.writeQueue = this.db.putRecording(this.meta);

    this.recorder.ondataavailable = (ev) => this.onChunk(ev.data);
    this.recorder.onerror = (ev) => this.addLog(`MediaRecorder 錯誤：${(ev as ErrorEvent).error?.message ?? 'unknown'}`);
    this.recorder.onpause = () => this.addLog('錄音器 pause');
    this.recorder.onresume = () => this.addLog('錄音器 resume');
    this.recorder.onstop = () => void this.finalize();
    this.stream.getAudioTracks().forEach((t) => {
      t.onended = () => this.addLog('⚠ 麥克風音軌被系統結束（ended）');
      t.onmute = () => this.addLog('⚠ 麥克風音軌 muted（可能被系統或其他 App 搶走）');
      t.onunmute = () => this.addLog('麥克風音軌 unmuted');
    });

    this.recorder.start(CHUNK_MS);
    this.status.set('recording');
    this.lastTick = performance.now();
    this.tickTimer = window.setInterval(() => this.tick(), 250);
    this.addLog(`開始錄音：${this.recorder.mimeType} @ ${bitrate / 1000}kbps`);
    if (this.useWakeLock()) await this.acquireWake();
  }

  private tick() {
    const now = performance.now();
    if (this.status() === 'recording') this.elapsed.update((e) => e + (now - this.lastTick));
    this.lastTick = now;
  }

  private onChunk(blob: Blob) {
    if (!blob.size || !this.meta) return;
    const meta = this.meta;
    const seq = this.seq++;
    this.chunks.update((c) => c + 1);
    this.bytes.update((b) => b + blob.size);
    meta.chunkCount = this.chunks();
    meta.size = this.bytes();
    meta.elapsedMs = this.elapsed();
    const snapshot = { ...meta };
    // 依序寫入，確保 chunk 順序與 commit 順序一致
    this.writeQueue = this.writeQueue
      .then(() => this.db.putChunk({ recordingId: meta.id, seq, blob }))
      .then(() => this.db.putRecording(snapshot))
      .catch((e) => {
        this.writeErrors.update((n) => n + 1);
        this.addLog(`❌ IndexedDB 寫入失敗（chunk ${seq}）：${(e as Error).message}`);
      });
  }

  protected pause() {
    this.recorder?.pause();
    this.status.set('paused');
  }

  protected resume() {
    this.recorder?.resume();
    this.lastTick = performance.now();
    this.status.set('recording');
  }

  protected stop() {
    if (!this.recorder || this.recorder.state === 'inactive') return;
    this.status.set('stopping');
    this.recorder.stop(); // 會觸發最後一個 dataavailable，再觸發 onstop
  }

  private async finalize() {
    window.clearInterval(this.tickTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.releaseWake();
    await this.writeQueue; // 等所有 chunk 都 commit
    if (this.meta) {
      this.meta.status = this.writeErrors() > 0 ? 'interrupted' : 'completed';
      this.meta.endedAt = new Date().toISOString();
      this.meta.chunkCount = this.chunks();
      this.meta.size = this.bytes();
      this.meta.elapsedMs = this.elapsed();
      await this.db.putRecording(this.meta);
      this.addLog(`已保存：${this.meta.chunkCount} chunks，${fmtBytes(this.meta.size)}，寫入失敗 ${this.writeErrors()} 次`);
    }
    this.status.set('idle');
    await this.refresh();
  }

  protected async play(r: RecordingMeta) {
    const old = this.player();
    if (old) URL.revokeObjectURL(old.url);
    this.player.set(null);
    const res = await this.audioSvc.blobFromRecording(r.id);
    if (!res) {
      this.addLog('找不到音檔資料');
      return;
    }
    const url = URL.createObjectURL(res.blob);
    const playable = await this.audioSvc.probeDuration(url);
    this.player.set({ id: r.id, url, size: res.blob.size, playableSec: playable, recordedSec: r.elapsedMs / 1000 });
    this.addLog(`還原 ${r.id}：${fmtBytes(res.blob.size)}，可播放長度 ${fmtTime(playable)}`);
  }

  protected async remove(r: RecordingMeta) {
    if (!confirm('確定刪除這筆錄音？')) return;
    if (this.player()?.id === r.id) this.player.set(null);
    await this.db.deleteRecording(r.id);
    await this.refresh();
  }

  // ---- 螢幕常亮與背景診斷 ----
  private async acquireWake() {
    try {
      if (!('wakeLock' in navigator)) {
        this.addLog('此瀏覽器不支援 Wake Lock');
        return;
      }
      this.wake = await navigator.wakeLock.request('screen');
      this.wakeLockOn.set(true);
      this.wake.onrelease = () => this.wakeLockOn.set(false);
    } catch (e) {
      this.addLog(`Wake Lock 失敗：${(e as Error).message}`);
    }
  }

  private async releaseWake() {
    try {
      await this.wake?.release();
    } catch {
      /* ignore */
    }
    this.wake = undefined;
    this.wakeLockOn.set(false);
  }

  private handleVisibility() {
    const recording = this.status() === 'recording' || this.status() === 'paused';
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
      this.chunksAtHidden = this.chunks();
      if (recording) this.addLog(`頁面進入背景／螢幕關閉（state=${this.recorder?.state}）`);
      return;
    }
    if (!recording || !this.hiddenAt) return;
    const away = (Date.now() - this.hiddenAt) / 1000;
    const got = this.chunks() - this.chunksAtHidden;
    const expected = Math.floor(away / this.chunkSec);
    const track = this.stream?.getAudioTracks()[0];
    this.addLog(
      `回到前景：離開 ${away.toFixed(0)}s，期間收到 ${got} 個 chunk（預期約 ${expected}），` +
        `recorder=${this.recorder?.state}，track=${track?.readyState}${track?.muted ? '(muted)' : ''}` +
        (got < expected * 0.5 && expected > 1 ? ' ⚠ 背景期間錄音疑似中斷' : ' ✓'),
    );
    this.hiddenAt = 0;
    if (this.useWakeLock() && !this.wakeLockOn()) void this.acquireWake(); // 回前景需重新取得
  }

  protected async copyReport() {
    const info = {
      ua: navigator.userAgent,
      time: new Date().toISOString(),
      mime: this.mime(),
      recordings: this.recordings(),
      log: [...this.log()].reverse(),
    };
    const ok = await copyText(JSON.stringify(info, null, 2));
    this.addLog(ok ? '診斷報告已複製到剪貼簿' : '複製失敗，請手動選取記錄文字');
  }
}
