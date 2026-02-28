/**
 * TestStateService — Central reactive store for all test run state.
 *
 * Listens to messages from VsCodeApiService and maintains the current
 * state as BehaviorSubjects that Angular components can subscribe to.
 * This keeps components simple — they just bind to observables.
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ConsoleLogEntry,
  ExtensionMessage,
  ResolutionPayload,
  RunCompletePayload,
  TestInfo,
  TestResult,
  VsCodeApiService,
} from './vscode-api.service';

export type RunPhase =
  | 'idle'
  | 'resolving'
  | 'discovering'
  | 'running'
  | 'complete';

export type StatusFilter = 'all' | 'passed' | 'failed' | 'skipped';

export interface CachedResultInfo {
  file: string;
  cachedAt: number;
  contentHash: string;
}

@Injectable({ providedIn: 'root' })
export class TestStateService {
  // ─── Observable state ────────────────────────────────────

  private readonly phaseSubject = new BehaviorSubject<RunPhase>('idle');
  readonly phase$ = this.phaseSubject.asObservable();

  private readonly resolutionSubject =
    new BehaviorSubject<ResolutionPayload | null>(null);
  readonly resolution$ = this.resolutionSubject.asObservable();

  private readonly discoveredTestsSubject = new BehaviorSubject<TestInfo[]>([]);
  readonly discoveredTests$ = this.discoveredTestsSubject.asObservable();

  private readonly resultsSubject = new BehaviorSubject<TestResult[]>([]);
  readonly results$ = this.resultsSubject.asObservable();

  private readonly runCompleteSubject =
    new BehaviorSubject<RunCompletePayload | null>(null);
  readonly runComplete$ = this.runCompleteSubject.asObservable();

  private readonly consoleLogsSubject = new BehaviorSubject<ConsoleLogEntry[]>(
    [],
  );
  readonly consoleLogs$ = this.consoleLogsSubject.asObservable();

  private readonly currentFileSubject = new BehaviorSubject<string | null>(
    null,
  );
  readonly currentFile$ = this.currentFileSubject.asObservable();

  /** Non-null when the current results came from cache rather than a live run. */
  private readonly cachedResultSubject =
    new BehaviorSubject<CachedResultInfo | null>(null);
  readonly cachedResult$ = this.cachedResultSubject.asObservable();

  /** Status filter for the results pane. */
  private readonly statusFilterSubject = new BehaviorSubject<StatusFilter>(
    'all',
  );
  readonly statusFilter$ = this.statusFilterSubject.asObservable();

  /** Results filtered by the current status filter. */
  readonly filteredResults$ = combineLatest([
    this.resultsSubject,
    this.statusFilterSubject,
  ]).pipe(
    map(([results, filter]) =>
      filter === 'all' ? results : results.filter((r) => r.status === filter),
    ),
  );

  constructor(private readonly vsCodeApi: VsCodeApiService) {
    this.vsCodeApi.messages$.subscribe((msg) => this.handleMessage(msg));
  }

  /** Set the status filter for the results pane. */
  setStatusFilter(filter: StatusFilter): void {
    this.statusFilterSubject.next(filter);
  }

  // ─── Message handling ────────────────────────────────────

  private handleMessage(msg: ExtensionMessage): void {
    switch (msg.type) {
      case 'clear':
        this.reset();
        break;

      case 'runStarted':
        this.reset();
        this.currentFileSubject.next(msg.data.file);
        this.phaseSubject.next('resolving');
        break;

      case 'resolution':
        this.resolutionSubject.next(msg.data);
        this.phaseSubject.next('discovering');
        break;

      case 'testsDiscovered':
        this.discoveredTestsSubject.next(msg.data);
        this.phaseSubject.next('running');
        break;

      case 'testResult': {
        const current = this.resultsSubject.value;
        this.resultsSubject.next([...current, msg.data]);
        break;
      }

      case 'runComplete':
        this.runCompleteSubject.next(msg.data);
        this.phaseSubject.next('complete');
        // If no results were streamed, use the ones from runComplete
        if (
          this.resultsSubject.value.length === 0 &&
          msg.data.results.length > 0
        ) {
          this.resultsSubject.next(msg.data.results);
        }
        break;

      case 'consoleLog': {
        const logs = this.consoleLogsSubject.value;
        this.consoleLogsSubject.next([...logs, msg.data]);
        break;
      }

      case 'consoleLogsUpdate':
        // Replace entire console log array (enriched with line numbers after run)
        this.consoleLogsSubject.next(msg.data);
        break;

      case 'cachedResult':
        this.cachedResultSubject.next(msg.data);
        break;
    }
  }

  private reset(): void {
    this.phaseSubject.next('idle');
    this.resolutionSubject.next(null);
    this.discoveredTestsSubject.next([]);
    this.resultsSubject.next([]);
    this.runCompleteSubject.next(null);
    this.consoleLogsSubject.next([]);
    this.currentFileSubject.next(null);
    this.cachedResultSubject.next(null);
    this.statusFilterSubject.next('all');
  }
}
