import { Injectable } from '@angular/core';

export interface RecordingMeta {
  id: string;
  startedAt: string;
  endedAt?: string;
  mimeType: string;
  bitrate: number;
  status: 'recording' | 'completed' | 'interrupted';
  chunkCount: number;
  size: number;
  /** 計時器累計的「有效錄音毫秒」（不含暫停） */
  elapsedMs: number;
}

export interface ChunkRow {
  recordingId: string;
  seq: number;
  blob: Blob;
}

const DB_NAME = 'meeting-notes-poc';
const DB_VERSION = 1;

@Injectable({ providedIn: 'root' })
export class DbService {
  private dbPromise?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('recordings', { keyPath: 'id' });
        db.createObjectStore('chunks', { keyPath: ['recordingId', 'seq'] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  /** 執行一個交易，並等到交易真正 commit 才 resolve（確保資料已落地）。 */
  private async run<T>(
    stores: string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    const db = await this.open();
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T | undefined;
      const req = fn(tx);
      if (req) req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 交易被中止'));
    });
  }

  putRecording(meta: RecordingMeta) {
    return this.run(['recordings'], 'readwrite', (tx) => tx.objectStore('recordings').put(meta));
  }

  async getRecording(id: string): Promise<RecordingMeta | undefined> {
    return this.run<RecordingMeta>(['recordings'], 'readonly', (tx) =>
      tx.objectStore('recordings').get(id),
    );
  }

  async listRecordings(): Promise<RecordingMeta[]> {
    const rows = await this.run<RecordingMeta[]>(['recordings'], 'readonly', (tx) =>
      tx.objectStore('recordings').getAll(),
    );
    return (rows ?? []).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  putChunk(row: ChunkRow) {
    return this.run(['chunks'], 'readwrite', (tx) => tx.objectStore('chunks').put(row));
  }

  async getChunks(recordingId: string): Promise<ChunkRow[]> {
    const rows = await this.run<ChunkRow[]>(['chunks'], 'readonly', (tx) =>
      tx.objectStore('chunks').getAll(IDBKeyRange.bound([recordingId, 0], [recordingId, Infinity])),
    );
    return (rows ?? []).sort((a, b) => a.seq - b.seq);
  }

  async deleteRecording(id: string) {
    await this.run(['chunks', 'recordings'], 'readwrite', (tx) => {
      tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
      tx.objectStore('recordings').delete(id);
    });
  }

  async storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
  }

  async requestPersist(): Promise<boolean> {
    return (await navigator.storage?.persist?.()) ?? false;
  }
}
