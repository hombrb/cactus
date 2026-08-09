import { newSeed } from "../engine/rng";
import { createMatch } from "../engine/turn";
import { Board } from "./game/board";
import { renderMenu } from "./screens/menu";
import { renderRules } from "./screens/rules";
import { renderSettings } from "./screens/settings";
import { configFrom, loadSettings, saveSettings, type Settings } from "./settings";
import { Store } from "./store";

type Screen = "menu" | "rules" | "settings" | "game";

export class App {
  private settings: Settings = loadSettings();
  private board: Board | null = null;

  constructor(private readonly root: HTMLElement) {
    this.go("menu");
  }

  private go(screen: Screen): void {
    this.board?.destroy();
    this.board = null;
    this.root.dataset.screen = screen;

    switch (screen) {
      case "menu":
        renderMenu(this.root, {
          onPlay: () => this.go("game"),
          onRules: () => this.go("rules"),
          onSettings: () => this.go("settings"),
        });
        break;

      case "rules":
        renderRules(this.root, this.settings, () => this.go("menu"));
        break;

      case "settings":
        renderSettings(
          this.root,
          this.settings,
          (next) => {
            this.settings = next;
            saveSettings(next);
          },
          () => this.go("menu"),
        );
        break;

      case "game":
        this.startGame();
        break;
    }
  }

  private startGame(): void {
    const [name1, name2] = this.settings.names;
    // ?seed=... makes a deal reproducible, which is how the screenshot script
    // drives a specific situation. Harmless in production: the seed is only
    // ever known to whoever typed it.
    const forced = new URLSearchParams(location.search).get("seed");
    const store = new Store(
      createMatch({
        config: configFrom(this.settings),
        players: [
          { id: "p1", name: name1 },
          { id: "p2", name: name2 },
        ],
        seed: forced && forced.length > 0 ? forced : newSeed(),
      }),
    );

    this.root.innerHTML = "";
    this.board = new Board(this.root, store, () => this.go("menu"));
    store.dispatch({ type: "StartMatch", playerId: "p1" });
  }
}
