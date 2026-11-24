import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="top">
      <b>Meeting Notes Lite</b>
      <span class="hint">Phase 0 技術驗證</span>
    </header>
    <main class="page"><router-outlet /></main>
    <nav class="tabs">
      <a routerLink="/record" routerLinkActive="on">1 錄音</a>
      <a routerLink="/asr" routerLinkActive="on">2 辨識</a>
      <a routerLink="/diar" routerLinkActive="on">3 分離</a>
    </nav>
  `,
})
export class App {}
