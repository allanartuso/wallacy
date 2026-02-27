import {Component} from "@angular/core";
import {ConsolePaneComponent} from "./components/console-pane/console-pane.component";
import {HeaderComponent} from "./components/header/header.component";
import {ResultsPaneComponent} from "./components/results-pane/results-pane.component";
import {SummaryBarComponent} from "./components/summary-bar/summary-bar.component";
import {TabsComponent} from "./components/tabs/tabs.component";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [HeaderComponent, SummaryBarComponent, TabsComponent, ResultsPaneComponent, ConsolePaneComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
})
export class AppComponent {
  activeTab: "results" | "console" = "results";

  onTabChange(tab: "results" | "console"): void {
    this.activeTab = tab;
  }
}
