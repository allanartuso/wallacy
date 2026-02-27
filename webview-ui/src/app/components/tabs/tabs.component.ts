import {AsyncPipe} from "@angular/common";
import {Component, EventEmitter, Input, Output} from "@angular/core";
import {Observable, map} from "rxjs";
import {TestStateService} from "../../services/test-state.service";

@Component({
  selector: "app-tabs",
  standalone: true,
  imports: [AsyncPipe],
  templateUrl: "./tabs.component.html",
  styleUrl: "./tabs.component.scss",
})
export class TabsComponent {
  @Input() activeTab: "results" | "console" = "results";
  @Output() tabChange = new EventEmitter<"results" | "console">();

  readonly consoleCount$: Observable<number>;

  constructor(private readonly state: TestStateService) {
    this.consoleCount$ = this.state.consoleLogs$.pipe(map((logs) => logs.length));
  }

  selectTab(tab: "results" | "console"): void {
    this.tabChange.emit(tab);
  }
}
