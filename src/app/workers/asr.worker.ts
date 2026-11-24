/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';

// 模型一律從 Hugging Face Hub 下載並快取在瀏覽器（Cache Storage）。
env.allowLocalModels = false;

// pipeline 的型別過於複雜，直接用 any 避免 TS「union type too complex」錯誤。
const createPipeline: any = pipeline;
let asr: any = null;

type LoadMsg = { type: 'load'; model: string; device: 'webgpu' | 'wasm'; dtype: string };
type RunMsg = { type: 'run'; id: number; audio: Float32Array; offset: number; language: string };

function heapMB(): number | null {
  const m = (performance as any).memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
}

addEventListener('message', async (ev: MessageEvent<LoadMsg | RunMsg>) => {
  const data = ev.data;
  try {
    if (data.type === 'load') {
      const t0 = performance.now();
      let dtype: any = data.dtype;
      if (data.dtype === 'auto') {
        dtype = data.device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
      }
      asr = await createPipeline('automatic-speech-recognition', data.model, {
        device: data.device,
        dtype,
        progress_callback: (p: any) => postMessage({ type: 'progress', p }),
      });
      postMessage({ type: 'ready', ms: performance.now() - t0, heapMB: heapMB() });
    } else if (data.type === 'run') {
      if (!asr) throw new Error('模型尚未載入');
      const t0 = performance.now();
      const out = await asr(data.audio, {
        language: data.language,
        task: 'transcribe',
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      postMessage({
        type: 'result',
        id: data.id,
        offset: data.offset,
        text: out.text as string,
        chunks: (out.chunks ?? []) as { text: string; timestamp: [number, number | null] }[],
        ms: performance.now() - t0,
        heapMB: heapMB(),
      });
    }
  } catch (e) {
    postMessage({ type: 'error', message: (e as Error)?.message ?? String(e), id: (data as RunMsg).id });
  }
});
