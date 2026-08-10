import { newSeed } from "../engine/rng";
import { createMatch } from "../engine/turn";
import type { RoomSettings } from "../net/room-config";
import { LocalClient, type GameClient } from "./client";
import { Board } from "./game/board";
import { renderLobby } from "./screens/lobby";
import { renderMenu } from "./screens/menu";
import { renderPowers } from "./screens/powers";
import { renderRules } from "./screens/rules";
import { renderSettings } from "./screens/settings";
import { configFrom, loadSettings, saveSettings, type Settings } from "./settings";

type Screen = "menu" | "rules" | "settings" | "powers" | "lobby" | "game";

export class App {
  private settings: Settings = loadSettings();
  private board: Board | null = null;
  private client: GameClient | null = null;
  private disposeScreen: (() => void) | null = null;

  constructor(private readonly root: HTMLElement) {
    this.go("menu");
  }

  private go(screen: Screen): void {
    this.teardown();
    this.root.dataset.screen = screen;

    switch (screen) {
      case "menu":
        renderMenu(this.root, {
          onPlay: () => this.go("game"),
          onOnline: () => this.go("lobby"),
          onRules: () => this.go("rules"),
          onSettings: () => this.go("settings"),
        });
        break;

      case "rules":
        renderRules(this.root, configFrom(this.settings), () => this.go("menu"));
        break;

      case "settings":
        renderSettings(
          this.root,
          this.settings,
          (next) => this.update(next),
          () => this.go("powers"),
          () => this.go("menu"),
        );
        break;

      case "powers":
        renderPowers(
          this.root,
          configFrom(this.settings).powers.map,
          (powers) => this.update({ ...this.settings, powers }),
          () => this.go("settings"),
        );
        break;

      case "lobby":
        this.disposeScreen = renderLobby(this.root, {
          defaultName: this.settings.names[0],
          settings: this.roomSettings(),
          onBack: () => this.go("menu"),
          onPlay: (client) => this.startOnline(client),
        });
        break;

      case "game":
        this.startLocal();
        break;
    }
  }

  /** The host's own preferences become the room's rules (docs/10 §2). */
  private roomSettings(): RoomSettings {
    return {
      preset: this.settings.preset,
      snap: this.settings.snap,
      scoreLimit: this.settings.scoreLimit,
      powers: this.settings.powers,
      seedDiscard: this.settings.seedDiscard,
      takeFromDiscard: this.settings.takeFromDiscard,
      announceAfterTurn: this.settings.announceAfterTurn,
    };
  }

  private update(next: Settings): void {
    this.settings = next;
    saveSettings(next);
  }

  private teardown(): void {
    this.disposeScreen?.();
    this.disposeScreen = null;
    this.board?.destroy();
    this.board = null;
    this.client?.destroy();
    this.client = null;
  }

  private startLocal(): void {
    const [name1, name2] = this.settings.names;
    // ?seed=... makes a deal reproducible, which is how the screenshot script
    // drives a specific situation. Harmless in production: the seed is only
    // ever known to whoever typed it.
    const forced = new URLSearchParams(location.search).get("seed");
    // Flat table: this device holds both seats, so it builds both projections.
    // An online client is the same renderer with a one-seat client.
    const client = new LocalClient(
      createMatch({
        config: configFrom(this.settings),
        players: [
          { id: "p1", name: name1 },
          { id: "p2", name: name2 },
        ],
        seed: forced && forced.length > 0 ? forced : newSeed(),
      }),
    );

    this.mount(client);
    client.dispatch({ type: "StartMatch", playerId: "p1" });
  }

  /**
   * The lobby hands over a client that is already connected and already past
   * LOBBY, so unlike the local game there is nothing left to dispatch.
   */
  private startOnline(client: GameClient): void {
    this.teardown();
    this.root.dataset.screen = "game";
    this.mount(client);
  }

  private mount(client: GameClient): void {
    this.root.innerHTML = "";
    this.client = client;
    this.board = new Board(this.root, client, () => this.go("menu"));
  }
}
