import { Injectable, inject } from '@angular/core';
import { DbService } from './db.service';

export interface DecodedAudio {
  samples: Float32Array; // 16kHz 單聲道
  sampleRate: number;
  durationSec: number;
  fullDurationSec: number;
  decodeMs: number;
}

@Injectable({ providedIn: 'root' })
export class AudioService {
  private db = inject(DbService);

  /** 把 IndexedDB 內的分段 chunk 組回一個 Blob。 */
  async blobFromRecording(id: string): Promise<{ blob: Blob; mimeType: string } | null> {
    const meta = await this.db.getRecording(id);
    if (!meta) return null;
    const chunks = await this.db.getChunks(id);
    if (!chunks.length) return null;
    return { blob: new Blob(chunks.map((c) => c.blob), { type: meta.mimeType }), mimeType: meta.mimeType };
  }

  /**
   * 解碼並重新取樣成 16kHz 單聲道 Float32（Whisper 與 sherpa-onnx 的輸入格式）。
   * maxSeconds：只取前 N 秒，用來控制記憶體。
   */
  async decode16k(blob: Blob, maxSeconds: number): Promise<DecodedAudio> {
    const t0 = performance.now();
    const buf = await blob.arrayBuffer();
    const ctx = new AudioContext({ sampleRate: 16000 });
    try {
      const audio = await ctx.decodeAudioData(buf);
      const ch = audio.numberOfChannels;
      const len = audio.length;
      const mono = new Float32Array(len);
      for (let c = 0; c < ch; c++) {
        const data = audio.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += data[i] / ch;
      }
      const maxLen = Math.min(len, Math.floor(maxSeconds * audio.sampleRate));
      const samples = maxLen < len ? mono.slice(0, maxLen) : mono;
      return {
        samples,
        sampleRate: audio.sampleRate,
        durationSec: samples.length / audio.sampleRate,
        fullDurationSec: len / audio.sampleRate,
        decodeMs: performance.now() - t0,
      };
    } finally {
      await ctx.close();
    }
  }

  /** MediaRecorder 產生的 webm 常常沒有 duration（Infinity），用這個小技巧取得真實長度。 */
  probeDuration(url: string): Promise<number> {
    return new Promise((resolve) => {
      const a = new Audio();
      a.preload = 'metadata';
      a.src = url;
      const done = (d: number) => {
        a.removeAttribute('src');
        resolve(d);
      };
      a.onerror = () => done(NaN);
      a.onloadedmetadata = () => {
        if (Number.isFinite(a.duration)) return done(a.duration);
        a.currentTime = 1e101;
        a.ontimeupdate = () => {
          a.ontimeupdate = null;
          done(Number.isFinite(a.duration) ? a.duration : NaN);
        };
      };
    });
  }
}
