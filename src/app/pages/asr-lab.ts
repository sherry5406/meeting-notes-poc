import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AudioService } from '../core/audio.service';
import { DbService, RecordingMeta } from '../core/db.service';
import { clock, copyText, fmtTime } from '../core/util';

interface Seg {
  start: number;
  end: number;
  text: string;
}

const MODELS = [
  { id: 'onnx-community/whisper-tiny', label: 'whisper-tiny（最快，品質最低）' },
  { id: 'onnx-community/whisper-base', label: 'whisper-base（建議先測）' },
  { id: 'onnx-community/whisper-small', label: 'whisper-small（較準，較慢較吃記憶體）' },
];

const SLICE_SEC = 60; // 每次送進 worker 的音訊長度，控制記憶體峰值

@Component({
  selector: 'app-asr-lab',
  template: `
    <h2>實驗 2：本機語音辨識（Whisper）</h2>
    <p class="hint">
      目標：在手機上辨識 10 分鐘真實中文會議，記錄速度、記憶體與錯誤率。
      模型第一次使用需從 Hugging Face 下載（之後快取）。<b>音檔不會上傳。</b>
    </p>

    <section class="card">
      <label>錄音來源
        <select (change)="recId.set($any($event.target).value)">
          <option value="">請選擇（先到實驗 1 錄音）</option>
          @for (r of recordings(); track r.id) {
            <option [value]="r.id" [selected]="r.id === recId()">
              {{ r.startedAt.slice(5, 16).replace('T', ' ') }}・{{ fmt(r.elapsedMs / 1000) }}
            </option>
          }
        </select>
      </label>
      <label>或上傳音檔
        <input type="file" accept="audio/*,video/*" (change)="onFile($event)" />
      </label>

      <label>模型
        <select (change)="model.set($any($event.target).value)">
          @for (m of models; track m.id) {
            <option [value]="m.id" [selected]="m.id === model()">{{ m.label }}</option>
          }
        </select>
      </label>
      <label>自訂模型 ID（例如 Breeze-ASR-25 的 ONNX 版）
        <input type="text" placeholder="owner/model-name" (input)="custom.set($any($event.target).value.trim())" />
      </label>
      <div class="row">
        <label>裝置
          <select (change)="device.set($any($event.target).value)">
            <option value="webgpu" [selected]="device() === 'webgpu'">WebGPU（快，若支援）</option>
            <option value="wasm" [selected]="device() === 'wasm'">WASM（相容性高，慢）</option>
          </select>
        </label>
        <label>測試長度（秒，0 = 全部）
          <input type="number" min="0" step="60" [value]="maxSec()" (input)="maxSec.set(+$any($event.target).value)" />
        </label>
      </div>
      <p class="hint">WebGPU：{{ gpuText() }}</p>

      <div class="row">
        <button class="btn primary" (click)="run()" [disabled]="busy()">開始辨識</button>
        <button class="btn danger" (click)="cancel()" [disabled]="!busy()">中止</button>
      </div>
      @if (error()) { <p class="bad">{{ error() }}</p> }
    </section>

    <section class="card">
      <h3>進度</h3>
      <div class="bar"><div class="fill" [style.width.%]="pct()"></div></div>
      <div class="hint">{{ stage() }}</div>
      @if (stats()) {
        <div class="grid2">
          <div>音訊長度：<b>{{ fmt(stats()!.audioSec) }}</b></div>
          <div>辨識耗時：<b>{{ fmt(stats()!.procSec) }}</b></div>
          <div>即時倍率：<b>{{ stats()!.rtf.toFixed(2) }}x</b></div>
          <div>JS 堆積記憶體：<b>{{ stats()!.heap ?? '?' }} MB</b></div>
        </div>
        <p class="hint">即時倍率 &lt; 1 代表辨識比錄音還快（1 小時錄音需要的處理時間 ≈ 倍率 × 60 分鐘）。</p>
      }
    </section>

    <section class="card">
      <h3>逐字稿（{{ segs().length }} 段）</h3>
      <div class="row">
        <button class="btn small" (click)="copy()">複製逐字稿</button>
      </div>
      @for (s of segs(); track $index) {
        <div class="seg"><span class="ts">{{ fmt(s.start) }}</span> {{ s.text }}</div>
      } @empty {
        <p class="hint">尚無結果。</p>
      }
    </section>

    <section class="card">
      <h3>事件記錄</h3>
      <pre class="log">{{ log().join('\n') }}</pre>
    </section>
  `,
  styles: [
    `
      .seg { padding: 0.35rem 0; border-top: 1px solid var(--line); }
      .ts { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 0.5rem; }
      .bar { height: 10px; background: var(--line); border-radius: 5px; overflow: hidden; }
      .fill { height: 100%; background: var(--accent); transition: width 0.2s; }
    `,
  ],
})
export class AsrLab implements OnInit, OnDestroy {
  private db = inject(DbService);
  private audioSvc = inject(AudioService);
  private route = inject(ActivatedRoute);

  protected models = MODELS;
  protected recordings = signal<RecordingMeta[]>([]);
  protected recId = signal('');
  protected file = signal<File | null>(null);
  protected model = signal(MODELS[1].id);
  protected custom = signal('');
  protected device = signal<'webgpu' | 'wasm'>('webgpu');
  protected maxSec = signal(600);
  protected busy = signal(false);
  protected pct = signal(0);
  protected stage = signal('待機');
  protected error = signal('');
  protected segs = signal<Seg[]>([]);
  protected log = signal<string[]>([]);
  protected gpuText = signal('檢查中…');
  protected stats = signal<{ audioSec: number; procSec: number; rtf: number; heap: number | null } | null>(null);
  protected fmt = fmtTime;

  private worker?: Worker;
  private cancelled = false;

  async ngOnInit() {
    this.recordings.set(await this.db.listRecordings());
    const q = this.route.snapshot.queryParamMap.get('rec');
    if (q) this.recId.set(q);
    const gpu = (navigator as any).gpu;
    if (!gpu) {
      this.gpuText.set('此瀏覽器沒有 WebGPU，請用 WASM（會比較慢）');
      this.device.set('wasm');
    } else {
      try {
        const a = await gpu.requestAdapter();
        this.gpuText.set(a ? '可用' : '沒有可用的 GPU adapter，建議改用 WASM');
        if (!a) this.device.set('wasm');
      } catch {
        this.gpuText.set('檢查失敗，建議改用 WASM');
        this.device.set('wasm');
      }
    }
  }

  ngOnDestroy() {
    this.worker?.terminate();
  }

  protected onFile(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0] ?? null;
    this.file.set(f);
  }

  private addLog(m: string) {
    this.log.update((l) => [`${clock()} ${m}`, ...l].slice(0, 200));
  }

  protected cancel() {
    this.cancelled = true;
    this.worker?.terminate();
    this.worker = undefined;
    this.busy.set(false);
    this.stage.set('已中止');
    this.addLog('使用者中止');
  }

  private callWorker<T>(msg: unknown, until: string, transfer?: Transferable[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const w = this.worker!;
      const handler = (ev: MessageEvent) => {
        const d = ev.data;
        if (d.type === 'progress') {
          const p = d.p;
          if (p.status === 'progress' && typeof p.progress === 'number') {
            this.stage.set(`下載模型：${p.file ?? ''} ${p.progress.toFixed(0)}%`);
            this.pct.set(Math.min(15, p.progress * 0.15));
          }
          return;
        }
        if (d.type === 'error') {
          w.removeEventListener('message', handler);
          reject(new Error(d.message));
        } else if (d.type === until) {
          w.removeEventListener('message', handler);
          resolve(d as T);
        }
      };
      w.addEventListener('message', handler);
      w.postMessage(msg, transfer ?? []);
    });
  }

  protected async run() {
    this.error.set('');
    this.segs.set([]);
    this.stats.set(null);
    this.cancelled = false;

    let blob: Blob | null = this.file();
    if (!blob && this.recId()) blob = (await this.audioSvc.blobFromRecording(this.recId()))?.blob ?? null;
    if (!blob) {
      this.error.set('請先選擇錄音或上傳音檔。');
      return;
    }

    this.busy.set(true);
    const modelId = this.custom() || this.model();
    try {
      this.stage.set('解碼音訊…');
      const maxSeconds = this.maxSec() > 0 ? this.maxSec() : 24 * 3600;
      const audio = await this.audioSvc.decode16k(blob, maxSeconds);
      this.addLog(`解碼完成：${fmtTime(audio.durationSec)}（全長 ${fmtTime(audio.fullDurationSec)}），耗時 ${(audio.decodeMs / 1000).toFixed(1)}s`);

      this.worker = new Worker(new URL('../workers/asr.worker', import.meta.url), { type: 'module' });
      this.stage.set('載入模型…');
      const ready = await this.callWorker<{ ms: number; heapMB: number | null }>(
        { type: 'load', model: modelId, device: this.device(), dtype: 'auto' },
        'ready',
      );
      this.addLog(`模型載入：${modelId}（${this.device()}），${(ready.ms / 1000).toFixed(1)}s`);

      const total = audio.samples.length;
      const sliceLen = SLICE_SEC * 16000;
      const all: Seg[] = [];
      let procMs = 0;
      let lastHeap: number | null = ready.heapMB;

      for (let off = 0, i = 0; off < total && !this.cancelled; off += sliceLen, i++) {
        const slice = audio.samples.slice(off, Math.min(total, off + sliceLen));
        const offsetSec = off / 16000;
        this.stage.set(`辨識中：${fmtTime(offsetSec)} / ${fmtTime(audio.durationSec)}`);
        const res = await this.callWorker<{
          text: string;
          chunks: { text: string; timestamp: [number, number | null] }[];
          ms: number;
          heapMB: number | null;
        }>({ type: 'run', id: i, audio: slice, offset: offsetSec, language: 'chinese' }, 'result', [slice.buffer]);
        procMs += res.ms;
        lastHeap = res.heapMB ?? lastHeap;
        const parts = res.chunks.length ? res.chunks : [{ text: res.text, timestamp: [0, null] as [number, null] }];
        for (const c of parts) {
          const t = c.text.trim();
          if (!t) continue;
          all.push({ start: offsetSec + (c.timestamp[0] ?? 0), end: offsetSec + (c.timestamp[1] ?? c.timestamp[0] ?? 0), text: t });
        }
        this.segs.set([...all]);
        this.pct.set(15 + (85 * Math.min(total, off + sliceLen)) / total);
        this.addLog(`第 ${i + 1} 段（${SLICE_SEC}s 音訊）耗時 ${(res.ms / 1000).toFixed(1)}s`);
      }

      if (!this.cancelled) {
        const procSec = procMs / 1000;
        this.stats.set({ audioSec: audio.durationSec, procSec, rtf: procSec / audio.durationSec, heap: lastHeap });
        this.stage.set('完成');
        this.pct.set(100);
      }
    } catch (e) {
      const msg = (e as Error).message;
      this.error.set(`失敗：${msg}`);
      this.addLog(`❌ ${msg}`);
      this.stage.set('失敗');
    } finally {
      this.busy.set(false);
    }
  }

  protected async copy() {
    const text = this.segs().map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
    this.addLog((await copyText(text)) ? '已複製逐字稿' : '複製失敗');
  }
}
