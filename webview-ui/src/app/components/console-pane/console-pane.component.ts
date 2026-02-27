import {AsyncPipe} from "@angular/common";
import {Component} from "@angular/core";
import {Observable, map} from "rxjs";
import {TestStateService} from "../../services/test-state.service";
import {ConsoleLogEntry, VsCodeApiService} from "../../services/vscode-api.service";
import {ansiToHtml, basename} from "../../utils/ansi";

@Component({
  selector: "app-console-pane",
  standalone: true,
  imports: [AsyncPipe],
  templateUrl: "./console-pane.component.html",
  styleUrl: "./console-pane.component.scss",
})
export class ConsolePaneComponent {
  readonly consoleLogs$: Observable<ConsoleLogEntry[]>;
  readonly hasLogs$: Observable<boolean>;

  constructor(
    private readonly state: TestStateService,
    private readonly vsCodeApi: VsCodeApiService,
  ) {
    this.consoleLogs$ = this.state.consoleLogs$;
    this.hasLogs$ = this.consoleLogs$.pipe(map((logs) => logs.length > 0));
  }

  getEntryClass(entry: ConsoleLogEntry): string {
    return `con-entry con-${entry.stream}`;
  }

  getSourceLabel(entry: ConsoleLogEntry): string {
    if (!entry.file) {
      return "";
    }
    const name = basename(entry.file);
    return entry.line ? `${name}:${entry.line}` : name;
  }

  getContentHtml(entry: ConsoleLogEntry): string {
    return ansiToHtml(entry.content);
  }

  openSource(entry: ConsoleLogEntry): void {
    if (entry.file) {
      this.vsCodeApi.openFile(entry.file, entry.line);
    }
  }
}
