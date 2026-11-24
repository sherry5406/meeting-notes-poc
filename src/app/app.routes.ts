import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'record' },
  { path: 'record', loadComponent: () => import('./pages/record-lab').then((m) => m.RecordLab), title: '實驗 1：錄音' },
  { path: 'asr', loadComponent: () => import('./pages/asr-lab').then((m) => m.AsrLab), title: '實驗 2：語音辨識' },
  { path: 'diar', loadComponent: () => import('./pages/diar-lab').then((m) => m.DiarLab), title: '實驗 3：說話者分離' },
  { path: '**', redirectTo: 'record' },
];
