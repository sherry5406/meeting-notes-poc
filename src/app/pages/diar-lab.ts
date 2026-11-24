import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AudioService } from '../core/audio.service';
import { DbService, RecordingMeta } from '../core/db.service';
import { clock, fmtTime } from '../core/util';

interface DiarSeg {
  start: number;
  end: number;
  speaker: number;
}

/**
 * sherpa-onnx 的 WebAssembly 說話者分離。
 * 需要把官方預編譯的 WASM 資產放在 public/sherpa-diarization/，見 docs/PHASE0-測試手冊.md。
 * 預期檔案：
 *   sherpa-onnx-wasm-main-speaker-diarization.js
 *   sherpa-onnx-wasm-main-speaker-diarization.wasm
 *   sherpa-onnx-wasm-main-speaker-diarization.data
 *   sherpa-onnx-speaker-diarization.js   （JS API 包裝，提供 createOfflineSpeakerDiarization）
 */
const BASE = 'sherpa-diarization/';
const SCRIPTS = ['sherpa-onnx-wasm-main-speaker-diarization.js', 'sherpa-onnx-speaker-diarization.js'];

@Component({
  selector: 'app-diar-lab',
  template: `
    <h2>實驗 3：說話者分離（sherpa-onnx WASM）</h2>
    <p class="hint">
      目標：用 10 分鐘雙人以上對話，記錄是否閃退、耗時、分段是否合理。
      這個實驗需要先放入 WASM 資產，沒放的話下方會顯示「找不到資產」，其他實驗不受影響。
    </p>

    <section class="card">
      <div>資產檢查：<b [class.bad]="assets() === 'missing'">{{ assetText() }}</b></div>
      <button class="btn small" (click)="checkAssets()">重新檢查</button>
    </section>

    <section class="card">
      <label>錄音來源
        <select (change)="recId.set($any($event.target).value)">
          <option value="">請選擇</option>
          @for (r of recordings(); track r.id) {
            <option [value]="r.id" [selected]="r.id === recId()">
              {{ r.startedAt.slice(5, 16).replace('T', ' ') }}・{{ fmt(r.elapsedMs / 1000) }}
            </option>
          }
        </select>
      </label>
      <label>或上傳音檔
        <input type="file" accept="audio/*,video/*" (change)="file.set($any($event.target).files?.[0] ?? null)" />
      </label>
      <div class="row">
        <label>測試長度（秒）
          <input type="number" min="60" step="60" [value]="maxSec()" (input)="maxSec.set(+$any($event.target).value)" />
        </label>
        <label>人數（-1 = 自動）
          <input type="number" min="-1" max="10" [value]="numSpeakers()" (input)="numSpeakers.set(+$any($event.target).value)" />
        </label>
      </div>
      <button class="btn primary" (click)="run()" [disabled]="busy() || assets() !== 'ok'">開始分離</button>
      <div class="hint">{{ stage() }}</div>
      @if (error()) { <p class="bad">{{ error() }}</p> }
    </section>

    @if (result().length) {
      <section class="card">
        <h3>結果（{{ speakerCount() }} 位說話者・耗時 {{ procSec().toFixed(1) }}s）</h3>
        @for (s of result(); track $index) {
          <div class="seg">
            <span class="tag" [style.background]="color(s.speaker)">Speaker {{ letter(s.speaker) }}</span>
            {{ fmt(s.start) }} – {{ fmt(s.end) }}
          </div>
        }
        <p class="hint">請聽原音檔，人工確認每段是不是同一個人，並記錄正確率。</p>
      </section>
    }

    <section class="card">
      <h3>事件記錄</h3>
      <pre class="log">{{ log().join('\n') }}</pre>
    </section>
  `,
  styles: [
    `
      .seg { padding: 0.3rem 0; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
      .tag { color: #fff; }
    `,
  ],
})
export class DiarLab implements OnInit {
  private db = inject(DbService);
  private audioSvc = inject(AudioService);
  private route = inject(ActivatedRoute);

  protected recordings = signal<RecordingMeta[]>([]);
  protected recId = signal('');
  protected file = signal<File | null>(null);
  protected maxSec = signal(600);
  protected numSpeakers = signal(-1);
  protected assets = signal<'checking' | 'ok' | 'missing'>('checking');
  protected assetText = signal('檢查中…');
  protected busy = signal(false);
  protected stage = signal('待機');
  protected error = signal('');
  protected result = signal<DiarSeg[]>([]);
  protected procSec = signal(0);
  protected log = signal<string[]>([]);
  protected fmt = fmtTime;

  private loaded = false;

  protected speakerCount() {
    return new Set(this.result().map((s) => s.speaker)).size;
  }
  protected letter(n: number) {
    return String.fromCharCode(65 + (n % 26));
  }
  protected color(n: number) {
    return ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2'][n % 6];
  }

  async ngOnInit() {
    this.recordings.set(await this.db.listRecordings());
    const q = this.route.snapshot.queryParamMap.get('rec');
    if (q) this.recId.set(q);
    await this.checkAssets();
  }

  private addLog(m: string) {
    this.log.update((l) => [`${clock()} ${m}`, ...l].slice(0, 200));
  }

  protected async checkAssets() {
    this.assets.set('checking');
    try {
      const missing: string[] = [];
      for (const f of SCRIPTS) {
        const r = await fetch(BASE + f, { method: 'HEAD' });
        const type = r.headers.get('content-type') ?? '';
        if (!r.ok || type.includes('text/html')) missing.push(f); // SPA fallback 會回傳 index.html
      }
      if (missing.length) {
        this.assets.set('missing');
        this.assetText.set(`找不到資產：${missing.join('、')}`);
      } else {
        this.assets.set('ok');
        this.assetText.set('已找到');
      }
    } catch {
      this.assets.set('missing');
      this.assetText.set('檢查失敗（網路錯誤）');
    }
  }

  private loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`載入失敗：${src}`));
      document.head.appendChild(s);
    });
  }

  /** Emscripten 的 Module 必須在載入 wasm 主程式「之前」定義。 */
  private async initSherpa(): Promise<any> {
    if (this.loaded) return (window as any).__sherpaDiar;
    const w = window as any;
    const ready = new Promise<void>((resolve) => {
      w.Module = {
        locateFile: (p: string) => BASE + p,
        onRuntimeInitialized: () => resolve(),
      };
    });
    await this.loadScript(BASE + SCRIPTS[1]);
    await this.loadScript(BASE + SCRIPTS[0]);
    await ready;
    if (typeof w.createOfflineSpeakerDiarization !== 'function') {
      throw new Error('找不到 createOfflineSpeakerDiarization，請確認 JS API 包裝檔版本');
    }
    w.__sherpaDiar = w.createOfflineSpeakerDiarization(w.Module);
    this.loaded = true;
    return w.__sherpaDiar;
  }

  protected async run() {
    this.error.set('');
    this.result.set([]);
    let blob: Blob | null = this.file();
    if (!blob && this.recId()) blob = (await this.audioSvc.blobFromRecording(this.recId()))?.blob ?? null;
    if (!blob) {
      this.error.set('請先選擇錄音或上傳音檔。');
      return;
    }
    this.busy.set(true);
    try {
      this.stage.set('解碼音訊…');
      const audio = await this.audioSvc.decode16k(blob, this.maxSec());
      this.addLog(`解碼完成：${fmtTime(audio.durationSec)}`);

      this.stage.set('載入 WASM 與模型…');
      const sd = await this.initSherpa();
      this.addLog(`取樣率需求：${sd.sampleRate}`);
      if (sd.sampleRate !== 16000) throw new Error(`模型需要 ${sd.sampleRate}Hz，尚未實作重新取樣`);

      this.stage.set('分離中…（可能需要數分鐘，頁面會暫時無回應）');
      await new Promise((r) => setTimeout(r, 50)); // 讓 UI 先更新
      const t0 = performance.now();
      if (this.numSpeakers() > 0) {
        sd.setConfig({ clustering: { numClusters: this.numSpeakers() } });
      }
      const segs: DiarSeg[] = sd.process(audio.samples);
      this.procSec.set((performance.now() - t0) / 1000);
      this.result.set(segs);
      this.stage.set('完成');
      this.addLog(`完成：${segs.length} 段，耗時 ${this.procSec().toFixed(1)}s`);
    } catch (e) {
      const m = (e as Error).message;
      this.error.set(`失敗：${m}`);
      this.addLog(`❌ ${m}`);
      this.stage.set('失敗');
    } finally {
      this.busy.set(false);
    }
  }
}
