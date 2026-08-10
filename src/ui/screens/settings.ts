import { configFrom, type Settings } from "../settings";
import { summarisePowers } from "../rules-text";

export function renderSettings(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
  onEditPowers: () => void,
  onBack: () => void,
): void {
  root.innerHTML = `
    <div class="screen screen--sheet">
      <header class="sheet__head">
        <button class="btn btn--icon" type="button" data-act="back" aria-label="retour">←</button>
        <h2>Réglages</h2>
      </header>

      <section class="field">
        <label class="field__label" for="p1">Joueur 1 (en bas)</label>
        <input class="field__input" id="p1" type="text" maxlength="14" value="${escape(settings.names[0])}">
      </section>

      <section class="field">
        <label class="field__label" for="p2">Joueur 2 (en haut)</label>
        <input class="field__input" id="p2" type="text" maxlength="14" value="${escape(settings.names[1])}">
      </section>

      <section class="field">
        <span class="field__label">Règles</span>
        <div class="choice" role="radiogroup">
          <button class="choice__opt" type="button" data-preset="standard" role="radio">
            <b>Standard</b>
            <small>Roi rouge 0, Roi noir 13, Dame 12, Valet 11.</small>
          </button>
          <button class="choice__opt" type="button" data-preset="school" role="radio">
            <b>Scolaire</b>
            <small>Tous les Rois à 0, figures à 10, partie en 5 manches.</small>
          </button>
        </div>
      </section>

      <section class="field">
        <span class="field__label">Pouvoirs</span>
        <button class="choice__opt" type="button" data-act="powers">
          <b data-powers-summary></b>
          <small data-powers-note></small>
        </button>
      </section>

      <section class="field field--row">
        <span>
          <span class="field__label">Défausse rapide</span>
          <small class="field__note">Glisse une carte vers le centre quand elle a la même valeur.</small>
        </span>
        <button class="toggle" type="button" data-act="snap" role="switch"></button>
      </section>

      <section class="field field--row">
        <span>
          <span class="field__label">Carte retournée au départ</span>
          <small class="field__note">Ouvre la défausse avec une carte. Sinon la défausse commence vide.</small>
        </span>
        <button class="toggle" type="button" data-act="seed" role="switch"></button>
      </section>

      <section class="field field--row">
        <span>
          <span class="field__label">Prendre la défausse</span>
          <small class="field__note">Prendre le dessus de la défausse au lieu de piocher, échange obligatoire.</small>
        </span>
        <button class="toggle" type="button" data-act="take" role="switch"></button>
      </section>

      <section class="field field--row">
        <span>
          <span class="field__label">Fin de tour automatique</span>
          <small class="field__note">Le tour passe tout seul, et tu peux encore dire Cactus pendant que l'autre joue.</small>
        </span>
        <button class="toggle" type="button" data-act="after" role="switch"></button>
      </section>

      <section class="field field--row" data-limit>
        <span>
          <span class="field__label">Fin de partie</span>
          <small class="field__note">Total de points à ne pas atteindre.</small>
        </span>
        <div class="choice choice--inline">
          <button class="choice__opt" type="button" data-limit-value="50">50</button>
          <button class="choice__opt" type="button" data-limit-value="100">100</button>
          <button class="choice__opt" type="button" data-limit-value="200">200</button>
        </div>
      </section>
    </div>
  `;

  const current = { ...settings, names: [...settings.names] as [string, string] };

  const paintToggle = (act: string, on: boolean) => {
    const el = root.querySelector<HTMLElement>(`[data-act="${act}"]`)!;
    el.dataset.on = String(on);
    el.setAttribute("aria-checked", String(on));
  };

  const paint = () => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-preset]")) {
      el.dataset.on = String(el.dataset.preset === current.preset);
      el.setAttribute("aria-checked", String(el.dataset.preset === current.preset));
    }
    paintToggle("snap", current.snap);
    paintToggle("seed", current.seedDiscard);
    paintToggle("take", current.takeFromDiscard);
    paintToggle("after", current.announceAfterTurn);

    // Read the summary back from the assembled config rather than from
    // `current.powers`, so a null override still shows the preset's real map.
    root.querySelector<HTMLElement>("[data-powers-summary]")!.textContent =
      summarisePowers(configFrom(current));
    root.querySelector<HTMLElement>("[data-powers-note]")!.textContent =
      current.powers === null ? "Pouvoirs du preset — touche pour changer" : "Pouvoirs personnalisés";

    // The school preset ends on a fixed number of rounds, so a score limit
    // would be meaningless there.
    root.querySelector<HTMLElement>("[data-limit]")!.hidden = current.preset === "school";
    for (const el of root.querySelectorAll<HTMLElement>("[data-limit-value]")) {
      el.dataset.on = String(Number(el.dataset.limitValue) === current.scoreLimit);
    }
  };

  const commit = () => {
    paint();
    onChange({ ...current, names: [...current.names] as [string, string] });
  };

  root.querySelector('[data-act="back"]')!.addEventListener("click", onBack);
  root.querySelector('[data-act="powers"]')!.addEventListener("click", onEditPowers);

  for (const el of root.querySelectorAll<HTMLElement>("[data-preset]")) {
    el.addEventListener("click", () => {
      current.preset = el.dataset.preset === "school" ? "school" : "standard";
      commit();
    });
  }

  const bindToggle = (
    act: string,
    key: "snap" | "seedDiscard" | "takeFromDiscard" | "announceAfterTurn",
  ) => {
    root.querySelector(`[data-act="${act}"]`)!.addEventListener("click", () => {
      current[key] = !current[key];
      commit();
    });
  };
  bindToggle("snap", "snap");
  bindToggle("seed", "seedDiscard");
  bindToggle("take", "takeFromDiscard");
  bindToggle("after", "announceAfterTurn");

  for (const el of root.querySelectorAll<HTMLElement>("[data-limit-value]")) {
    el.addEventListener("click", () => {
      current.scoreLimit = Number(el.dataset.limitValue);
      commit();
    });
  }

  const bindName = (id: string, index: 0 | 1) => {
    const input = root.querySelector<HTMLInputElement>(`#${id}`)!;
    input.addEventListener("input", () => {
      current.names[index] = input.value;
      onChange({ ...current, names: [...current.names] as [string, string] });
    });
  };
  bindName("p1", 0);
  bindName("p2", 1);

  paint();
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
