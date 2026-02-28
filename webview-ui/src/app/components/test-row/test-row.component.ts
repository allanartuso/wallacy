import { NgClass } from '@angular/common';
import { Component, Input } from '@angular/core';
import {
  TestResult,
  VsCodeApiService,
} from '../../services/vscode-api.service';
import {
  ansiToHtml,
  basename,
  escapeHtml,
  formatValue,
  stripAnsi,
} from '../../utils/ansi';

@Component({
  selector: 'app-test-row',
  standalone: true,
  imports: [NgClass],
  templateUrl: './test-row.component.html',
  styleUrl: './test-row.component.scss',
})
export class TestRowComponent {
  @Input({ required: true }) result!: TestResult;
  expanded = false;
  errorExpanded = false;

  constructor(private readonly vsCodeApi: VsCodeApiService) {}

  ngOnInit(): void {
    // Auto-expand failed test rows (show error section)
    if (this.result.status === 'failed') {
      this.expanded = true;
    }
  }

  toggle(): void {
    this.expanded = !this.expanded;
  }

  toggleError(): void {
    this.errorExpanded = !this.errorExpanded;
  }

  get statusIcon(): string {
    switch (this.result.status) {
      case 'passed':
        return '✓';
      case 'failed':
        return '✗';
      default:
        return '○';
    }
  }

  get statusClass(): string {
    switch (this.result.status) {
      case 'passed':
        return 'si-pass';
      case 'failed':
        return 'si-fail';
      default:
        return 'si-skip';
    }
  }

  get suiteChain(): string {
    if (!this.result.suite?.length) {
      return '';
    }
    return this.result.suite.join(' › ') + ' › ';
  }

  get fileLabel(): string {
    if (!this.result.file) {
      return '';
    }
    const name = basename(this.result.file);
    return this.result.line ? `${name}:${this.result.line}` : name;
  }

  get errorMessage(): string {
    return stripAnsi(this.result.error?.message || 'Unknown error');
  }

  get hasExpectedActual(): boolean {
    return (
      this.result.error?.expected !== undefined ||
      this.result.error?.actual !== undefined
    );
  }

  get expectedFormatted(): string {
    return escapeHtml(formatValue(this.result.error?.expected));
  }

  get actualFormatted(): string {
    return escapeHtml(formatValue(this.result.error?.actual));
  }

  get diffHtml(): string {
    if (!this.result.error?.diff) {
      return '';
    }
    return this.renderAnsiDiff(this.result.error.diff);
  }

  get stackHtml(): string {
    if (!this.result.error?.stack) {
      return '';
    }
    return this.renderStack(this.result.error.stack);
  }

  openTestLocation(): void {
    if (this.result.file) {
      this.vsCodeApi.openFile(this.result.file, this.result.line);
    }
  }

  onStackLinkClick(event: Event): void {
    const target = event.target as HTMLElement;
    const link = target.closest('.stack-link') as HTMLElement;
    if (link) {
      const file = link.getAttribute('data-file');
      const line = parseInt(link.getAttribute('data-line') || '', 10);
      if (file) {
        this.vsCodeApi.openFile(file, isNaN(line) ? undefined : line);
      }
    }
  }

  private renderAnsiDiff(raw: string): string {
    const clean = stripAnsi(raw);
    const rawLines = raw.split('\n');
    const cleanLines = clean.split('\n');

    return rawLines
      .map((rl, i) => {
        const cl = (cleanLines[i] || '').trimStart();
        let lineClass = 'line-ctx';

        if (cl.startsWith('- Expected') || cl.startsWith('+ Received')) {
          lineClass = cl.startsWith('-') ? 'line-del' : 'line-add';
        } else if (cl.startsWith('@@')) {
          lineClass = 'line-hunk';
        } else if (cl.startsWith('+')) {
          lineClass = 'line-add';
        } else if (cl.startsWith('-')) {
          lineClass = 'line-del';
        }

        return `<span class="line ${lineClass}">${ansiToHtml(rl)}</span>`;
      })
      .join('');
  }

  private renderStack(stack: string): string {
    const clean = stripAnsi(stack);
    const lines = clean.split('\n');

    return lines
      .map((line) => {
        const m = line.match(
          /(?:at\s+.*?\(|\u276F\s*|at\s+)([A-Za-z]:[\\/].+?|\/[^\s]+?)(?::(\d+))(?::\d+)?\)?/,
        );
        if (m) {
          const [, file, ln] = m;
          const escaped = escapeHtml(line);
          const target = escapeHtml(`${file}:${ln}`);
          return escaped.replace(
            target,
            `<a class="stack-link" data-file="${escapeHtml(file)}" data-line="${ln}">${target}</a>`,
          );
        }
        return escapeHtml(line);
      })
      .join('\n');
  }
}
