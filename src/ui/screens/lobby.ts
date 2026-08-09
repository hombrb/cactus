// Create or join a room, then wait for the host to start — docs/10 §2.
//
// The screen has two lives. Before a socket exists it is a form: a name, and
// either "create" or a six-character code. After the room welcomes you it
// becomes the waiting room, and it hands over to the board the moment the match
// leaves LOBBY.

import { CODE_LENGTH, normaliseRoomCode } from "../../net/protocol";
import type { RoomSettings } from "../../net/room-config";
import { loadIdentity } from "../identity";
import { RemoteClient } from "../remote-client";

export interface LobbyActions {
  /** Called once the match starts; the app swaps in the board. */
  readonly onPlay: (client: RemoteClient) => void;
  readonly onBack: () => void;
  readonly defaultName: string;
  readonly settings: RoomSettings;
}

export function renderLobby(root: HTMLElement, actions: LobbyActions): () => void {
  let client: RemoteClient | null = null;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  root.innerHTML = `
    <div class="screen screen--lobby">
      <header class="brand brand--compact">
        <h1 class="brand__title">Jouer à plusieurs</h1>
        <p class="brand__sub">un téléphone par joueur</p>
      </header>

      <form class="lobby" data-step="form">
        <label class="field">
          <span class="field__label">Ton pseudo</span>
          <input class="field__input" name="name" maxlength="16" autocomplete="nickname"
                 enterkeyhint="done" required>
        </label>

        <button class="btn btn--big" data-kind="accent" type="button" data-act="create">
          Créer une partie
        </button>

        <p class="lobby__or">ou rejoindre avec un code</p>

        <label class="field">
          <span class="field__label">Code de la partie</span>
          <input class="field__input field__input--code" name="code" maxlength="${CODE_LENGTH}"
                 autocapitalize="characters" autocomplete="off" spellcheck="false"
                 inputmode="text" enterkeyhint="go" placeholder="ABC234">
        </label>

        <button class="btn btn--big" type="submit" data-act="join">Rejoindre</button>
        <p class="lobby__error" data-role="error" hidden></p>
        <button class="btn" type="button" data-act="back">Retour</button>
      </form>

      <div class="lobby" data-step="waiting" hidden>
        <p class="lobby__codelabel">Code de la partie</p>
        <p class="lobby__code" data-role="code"></p>
        <p class="lobby__hint">Donne ce code à l'autre joueur.</p>
        <ul class="lobby__players" data-role="players"></ul>
        <button class="btn btn--big" data-kind="accent" type="button" data-act="start" hidden>
          Démarrer
        </button>
        <p class="lobby__hint" data-role="wait"></p>
        <button class="btn" type="button" data-act="leave">Quitter</button>
      </div>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>('[data-step="form"]')!;
  const waiting = root.querySelector<HTMLElement>('[data-step="waiting"]')!;
  const nameInput = root.querySelector<HTMLInputElement>('input[name="name"]')!;
  const codeInput = root.querySelector<HTMLInputElement>('input[name="code"]')!;
  const errorEl = root.querySelector<HTMLElement>('[data-role="error"]')!;
  const codeEl = root.querySelector<HTMLElement>('[data-role="code"]')!;
  const playersEl = root.querySelector<HTMLElement>('[data-role="players"]')!;
  const waitEl = root.querySelector<HTMLElement>('[data-role="wait"]')!;
  const startBtn = root.querySelector<HTMLButtonElement>('[data-act="start"]')!;
  const createBtn = root.querySelector<HTMLButtonElement>('[data-act="create"]')!;
  const joinBtn = root.querySelector<HTMLButtonElement>('[data-act="join"]')!;

  nameInput.value = actions.defaultName;
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase();
  });

  function fail(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
    createBtn.disabled = false;
    joinBtn.disabled = false;
  }

  function busy(): void {
    errorEl.hidden = true;
    createBtn.disabled = true;
    joinBtn.disabled = true;
  }

  async function connect(code: string): Promise<void> {
    const name = nameInput.value.trim() || actions.defaultName;
    const identity = loadIdentity(name);

    // A failed WebSocket handshake does not expose its HTTP status to the page,
    // so ask over plain HTTP first. Without this, a typo and a match that has
    // already started produce the same unhelpful message.
    try {
      const probe = await fetch(`/api/room/socket?code=${encodeURIComponent(code)}`);
      if (probe.status === 404) {
        fail(`Aucune partie avec le code ${code}.`);
        return;
      }
    } catch {
      fail("Pas de connexion au serveur.");
      return;
    }

    try {
      const connected = await RemoteClient.connect({
        url: location.origin,
        code,
        playerId: identity.playerId,
        name: identity.name,
      });
      if (disposed) {
        connected.destroy();
        return;
      }
      client = connected;
      form.hidden = true;
      waiting.hidden = false;
      codeEl.textContent = code;
      unsubscribe = connected.subscribe(() => paint());
      paint();
    } catch {
      // The room exists — the probe just said so — so the realistic causes are
      // a match already under way or the connection dropping.
      fail("Impossible de rejoindre : la partie a peut-être déjà commencé.");
    }
  }

  function paint(): void {
    if (client === null) return;
    const view = client.view(client.seats[0]!);

    if (view.phase !== "LOBBY") {
      const started = client;
      client = null;
      unsubscribe?.();
      unsubscribe = null;
      actions.onPlay(started);
      return;
    }

    playersEl.innerHTML = "";
    for (const player of view.players) {
      const li = document.createElement("li");
      li.className = "lobby__player";
      li.textContent = player.name;
      if (player.id === view.hostId) li.dataset.host = "1";
      if (player.id === view.you) li.dataset.you = "1";
      if (!player.connected) li.dataset.away = "1";
      playersEl.append(li);
    }

    // Two players for now; the engine already handles more, the board does not.
    const isHost = view.you === view.hostId;
    const enough = view.players.filter((p) => p.connected).length >= 2;
    startBtn.hidden = !isHost;
    startBtn.disabled = !enough;
    waitEl.textContent = isHost
      ? enough
        ? ""
        : "En attente d'un autre joueur"
      : "En attente du lancement par l'hôte";
  }

  createBtn.addEventListener("click", async () => {
    busy();
    try {
      const response = await fetch("/api/room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(actions.settings),
      });
      const body = (await response.json()) as { code?: string };
      if (typeof body.code !== "string") throw new Error("NO_CODE");
      await connect(body.code);
    } catch {
      fail("Impossible de créer la partie. Réessaie dans un instant.");
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = normaliseRoomCode(codeInput.value);
    if (code === null) {
      fail(`Un code fait ${CODE_LENGTH} caractères, sans O ni I.`);
      return;
    }
    busy();
    await connect(code);
  });

  startBtn.addEventListener("click", () => {
    if (client === null) return;
    client.dispatch({ type: "StartMatch", playerId: client.seats[0]! });
  });

  root.querySelector('[data-act="back"]')!.addEventListener("click", actions.onBack);
  root.querySelector('[data-act="leave"]')!.addEventListener("click", () => {
    client?.destroy();
    client = null;
    actions.onBack();
  });

  return () => {
    disposed = true;
    unsubscribe?.();
    // Only tears down a client the board did not take over: onPlay clears it.
    client?.destroy();
    client = null;
  };
}
