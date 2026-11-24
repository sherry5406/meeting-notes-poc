# Meeting Notes Lite — Phase 0 技術驗證手冊

技術：Angular 22 ＋ Angular Service Worker（PWA）＋ Transformers.js ＋（選用）sherpa-onnx WASM。

## 一、啟動

```bash
npm install --ignore-scripts      # 跳過 onnxruntime-node 的原生安裝（瀏覽器用不到）
npm run build                     # 產出 dist/meeting-notes-poc/browser
```

麥克風需要 HTTPS（localhost 除外）。手機測試的三種方式：

1. **部署到 Cloudflare Pages**：Build command `npm run build`，Output directory `dist/meeting-notes-poc/browser`。
   Pages 需要 SPA 回退，`public/_redirects` 已內建 `/* /index.html 200`。
2. **電腦 `npx ng serve --host 0.0.0.0`＋ Chrome 遠端偵錯埠轉發**（`chrome://inspect` → Port forwarding 4200）。
3. 任何臨時 HTTPS 通道（例如 cloudflared quick tunnel）。

用 Android Chrome 開啟後，選單 →「安裝應用程式」可加入主畫面，PWA 行為與正式版一致。

## 二、實驗 1：錄音＋IndexedDB（先做這個）

| # | 情境 | 做法 | 通過標準 |
|---|---|---|---|
| 1-1 | 5 分鐘前景錄音 | 螢幕保持亮著 | 「差距」≤ 3 秒，寫入失敗 0 |
| 1-2 | 30 分鐘前景錄音 | 勾選「保持螢幕常亮」 | 同上；可播放長度≈計時 |
| 1-3 | 60 分鐘前景錄音 | 同上 | 同上；記錄檔案大小 |
| 1-4 | 暫停／繼續 | 錄音中暫停 30 秒再繼續 | 計時不含暫停時間 |
| 1-5 | 切換其他 App | 錄音中切到 LINE 10 秒再回來 | 看事件記錄：是否收到 chunk、`track` 狀態 |
| 1-6 | 鎖定螢幕 | 錄音中鎖屏 1 分鐘再解鎖 | 同上（預期可能中斷，這是要驗證的事） |
| 1-7 | 來電 | 錄音中接一通電話 | 記錄行為 |
| 1-8 | 頁面被殺 | 錄音中從最近工作清單滑掉 App | 重開後狀態為「未正常結束（可還原）」，且能播放已寫入部分 |
| 1-9 | 儲存空間 | 按「要求永久儲存」 | 記錄是否被授予 |

每項完成後按「複製診斷報告」，貼給我即可分析。

建議位元率 32 kbps（語音足夠，1 小時約 14 MB）。

## 三、實驗 2：語音辨識

1. 先用實驗 1 錄一段約 10 分鐘的真實中文會議（或上傳現有音檔）。
2. 模型建議順序：`whisper-base` → `whisper-small`；裝置先試 WebGPU，失敗再試 WASM。
3. 想試台灣華語：在「自訂模型 ID」填入 Breeze-ASR-25 的 ONNX 版（`markno5/Breeze-ASR-25-ONNX`）。
   它是 large 級模型，手機很可能記憶體不足，主要用來評估品質上限。
4. 記錄：即時倍率、記憶體、是否閃退、錯字率（人工抽查 1 分鐘）。

通過標準（建議）：即時倍率 ≤ 1.0（1 小時錄音 ≤ 1 小時處理）、不閃退、一般中文可讀。

> 網路說明：第一次執行會從 Hugging Face 下載模型，並從 jsDelivr 下載 ONNX Runtime 的 wasm。
> 音檔與逐字稿**不會**離開手機。WebGPU 版 wasm 為 27 MiB，超過 Cloudflare Pages 單檔 25 MiB 上限，所以不能直接放進 Pages；若要自架，改放 Cloudflare R2。

## 四、實驗 3：說話者分離（選用）

這個實驗需要手動放入官方預編譯資產（本專案沒有內建）。

1. 從 sherpa-onnx 的 WebAssembly speaker-diarization 範例取得（版本請與 JS API 包裝檔一致）：
   - `sherpa-onnx-wasm-main-speaker-diarization.js`
   - `sherpa-onnx-wasm-main-speaker-diarization.wasm`
   - `sherpa-onnx-wasm-main-speaker-diarization.data`（內含 pyannote segmentation 與說話者嵌入模型）
   - `sherpa-onnx-speaker-diarization.js`
2. 全部放進 `public/sherpa-diarization/`，重新 build。
3. 實驗 3 頁面頂部顯示「已找到」後即可執行。分離是同步運算，執行中頁面會暫時無回應，屬正常。
4. 記錄：是否閃退、耗時、人數是否正確、換人處是否切對。

若手機無法穩定完成，v0.1 以「手動標記 Speaker」為正式方案。

## 五、需要回報給我的結果

- 手機型號、Android 版本、Chrome 版本、RAM
- 實驗 1 各情境的診斷報告
- 實驗 2：模型、裝置、即時倍率、記憶體、品質觀察
- 實驗 3：是否可執行、耗時、正確率觀察

## 六、已知限制

- 實驗 2、3 的實際執行需要網路與真實手機，開發環境無法替你驗證效能。
- 手機瀏覽器在鎖屏或背景時可能暫停錄音，這是瀏覽器限制；錄音頁用 Wake Lock 降低螢幕休眠機率。
- `MediaRecorder` 產生的 webm 沒有時間長度標頭，拖曳播放進度可能不精準，不影響辨識。
