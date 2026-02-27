import {AsyncPipe} from "@angular/common";
import {Component} from "@angular/core";
import {TestStateService} from "../../services/test-state.service";
import {VsCodeApiService} from "../../services/vscode-api.service";

@Component({
  selector: "app-header",
  standalone: true,
  imports: [AsyncPipe],
  templateUrl: "./header.component.html",
  styleUrl: "./header.component.scss",
})
export class HeaderComponent {
  readonly resolution$;
  readonly phase$;

  constructor(
    private readonly state: TestStateService,
    private readonly vsCodeApi: VsCodeApiService,
  ) {
    this.resolution$ = this.state.resolution$;
    this.phase$ = this.state.phase$;
  }

  rerun(): void {
    this.vsCodeApi.rerun();
  }
}
