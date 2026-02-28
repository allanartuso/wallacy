import {AsyncPipe, DecimalPipe} from "@angular/common";
import {Component, inject} from "@angular/core";
import {Observable, combineLatest, map} from "rxjs";
import {CachedResultInfo, TestStateService} from "../../services/test-state.service";
import {TestResult} from "../../services/vscode-api.service";

interface Summary {
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
}

@Component({
  selector: "app-summary-bar",
  standalone: true,
  imports: [AsyncPipe, DecimalPipe],
  templateUrl: "./summary-bar.component.html",
  styleUrl: "./summary-bar.component.scss",
})
export class SummaryBarComponent {
  private readonly state = inject(TestStateService);

  readonly summary$: Observable<Summary | null> = this.state.results$.pipe(
    map((results) => {
      if (results.length === 0) {
        return null;
      }
      return {
        passed: results.filter((r: TestResult) => r.status === "passed").length,
        failed: results.filter((r: TestResult) => r.status === "failed").length,
        skipped: results.filter((r: TestResult) => r.status === "skipped").length,
        duration: results.reduce((sum: number, r: TestResult) => sum + (r.duration || 0), 0),
      };
    }),
  );

  readonly visible$: Observable<boolean> = combineLatest([this.state.phase$, this.state.results$]).pipe(
    map(([phase, results]) => results.length > 0 || phase === "running" || phase === "complete"),
  );

  readonly cached$: Observable<CachedResultInfo | null> = this.state.cachedResult$;
}
