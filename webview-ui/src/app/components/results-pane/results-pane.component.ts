import { AsyncPipe } from '@angular/common';
import { Component } from '@angular/core';
import { Observable, map } from 'rxjs';
import { RunPhase, TestStateService } from '../../services/test-state.service';
import {
  TestResult,
  VsCodeApiService,
} from '../../services/vscode-api.service';
import { basename } from '../../utils/ansi';
import { TestRowComponent } from '../test-row/test-row.component';

interface FileGroup {
  file: string;
  displayName: string;
  tests: TestResult[];
  passed: number;
  failed: number;
  skipped: number;
}

@Component({
  selector: 'app-results-pane',
  standalone: true,
  imports: [AsyncPipe, TestRowComponent],
  templateUrl: './results-pane.component.html',
  styleUrl: './results-pane.component.scss',
})
export class ResultsPaneComponent {
  readonly phase$: Observable<RunPhase>;
  readonly fileGroups$: Observable<FileGroup[]>;
  readonly hasResults$: Observable<boolean>;
  readonly spinnerText$: Observable<string>;

  constructor(
    private readonly state: TestStateService,
    private readonly vsCodeApi: VsCodeApiService,
  ) {
    this.phase$ = this.state.phase$;

    this.hasResults$ = this.state.filteredResults$.pipe(
      map((results) => results.length > 0),
    );

    this.spinnerText$ = this.state.phase$.pipe(
      map((phase) => {
        switch (phase) {
          case 'resolving':
            return 'Resolving project\u2026';
          case 'discovering':
            return 'Discovering tests\u2026';
          case 'running':
            return 'Running tests\u2026';
          default:
            return '';
        }
      }),
    );

    this.fileGroups$ = this.state.filteredResults$.pipe(
      map((results) => {
        const grouped = new Map<string, TestResult[]>();
        for (const r of results) {
          const file = r.file || 'unknown';
          if (!grouped.has(file)) {
            grouped.set(file, []);
          }
          grouped.get(file)!.push(r);
        }

        return Array.from(grouped.entries()).map(([file, tests]) => ({
          file,
          displayName: basename(file),
          tests,
          passed: tests.filter((t) => t.status === 'passed').length,
          failed: tests.filter((t) => t.status === 'failed').length,
          skipped: tests.filter((t) => t.status === 'skipped').length,
        }));
      }),
    );
  }

  openFile(file: string): void {
    this.vsCodeApi.openFile(file);
  }
}
