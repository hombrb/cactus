// The powers editor.
//
// `powers.map` has always been free data in the engine; this is the screen that
// finally lets a player reach it. It edits an override that composes with
// either preset, rather than inventing a third preset — the values, the scoring
// and the match length still come from Standard or Scolaire.

import { POWER_RANK_KEYS, SELECTABLE_POWERS, school, standard } from "../../engine/config";
import type { PowerKind, PowerMap, RankKey } from "../../engine/types";
import { POWER_LABELS, rankLabel } from "../rules-text";

/** One-tap starting points. The third is the variant this screen was built for. */
const STARTERS: readonly { id: string; label: string; note: string; map: PowerMap }[] = [
  {
    id: "standard",
    label: "Standard",
    note: "7·8, 9·10, V·D, Roi noir",
    map: standard.powers.map,
  },
  {
    id: "school",
    label: "Scolaire",
    note: "le 8 seul",
    map: school.powers.map,
  },
  {
    id: "seven-jack",
    label: "7 et Valet",
    note: "le 7 chez toi, le Valet chez l'adversaire",
    map: { "7": "PEEK_OWN", J: "PEEK_OPPONENT" },
  },
];

function normalise(map: PowerMap | null): Record<RankKey, PowerKind> {
  const out: Record<RankKey, PowerKind> = {};
  for (const key of POWER_RANK_KEYS) out[key] = map?.[key] ?? "NONE";
  return out;
}

/** Drops the NONE entries: an absent rank already means no power (docs/02). */
function compact(rows: Record<RankKey, PowerKind>): PowerMap {
  const out: Record<RankKey, PowerKind> = {};
  for (const key of POWER_RANK_KEYS) if (rows[key] !== "NONE") out[key] = rows[key]!;
  return out;
}

function sameMap(a: PowerMap, b: PowerMap): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export function renderPowers(
  root: HTMLElement,
  /** The map in force — the preset's own when nothing has been customised. */
  current: PowerMap,
  onChange: (next: PowerMap | null) => void,
  onBack: () => void,
): void {
  const rows = normalise(current);

  root.innerHTML = `
    <div class="screen screen--sheet">
      <header class="sheet__head">
        <button class="btn btn--icon" type="button" data-act="back" aria-label="retour">←</button>
        <h2>Pouvoirs</h2>
      </header>

      <p class="field__note">
        Un pouvoir s'active sur une carte qui <b>part à la défausse</b>, jamais sur une
        carte que tu gardes. Lesquelles exactement dépend de Réglages ; l'écran Règles le
        dit. Touche une ligne pour changer son pouvoir.
      </p>

      <section class="field">
        <span class="field__label">Départs rapides</span>
        <div class="choice">
          ${STARTERS.map(
            (s) => `
            <button class="choice__opt" type="button" data-starter="${s.id}">
              <b>${s.label}</b><small>${s.note}</small>
            </button>`,
          ).join("")}
        </div>
      </section>

      <section class="field">
        <span class="field__label">Carte par carte</span>
        <ul class="powers">
          ${POWER_RANK_KEYS.map(
            (key) => `
            <li>
              <button class="powers__row" type="button" data-rank="${key}">
                <span class="powers__rank">${rankLabel(key)}</span>
                <span class="powers__kind" data-kind></span>
              </button>
            </li>`,
          ).join("")}
        </ul>
      </section>

      <button class="btn" type="button" data-act="clear">Revenir aux pouvoirs du preset</button>
    </div>
  `;

  const paint = () => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-rank]")) {
      const kind = rows[el.dataset.rank!]!;
      el.querySelector<HTMLElement>("[data-kind]")!.textContent = POWER_LABELS[kind];
      el.dataset.on = String(kind !== "NONE");
    }
    const map = compact(rows);
    for (const el of root.querySelectorAll<HTMLElement>("[data-starter]")) {
      const starter = STARTERS.find((s) => s.id === el.dataset.starter)!;
      el.dataset.on = String(sameMap(map, compact(normalise(starter.map))));
    }
  };

  const commit = () => {
    paint();
    onChange(compact(rows));
  };

  root.querySelector('[data-act="back"]')!.addEventListener("click", onBack);

  root.querySelector('[data-act="clear"]')!.addEventListener("click", () => {
    onChange(null);
    onBack();
  });

  for (const el of root.querySelectorAll<HTMLElement>("[data-starter]")) {
    el.addEventListener("click", () => {
      const starter = STARTERS.find((s) => s.id === el.dataset.starter)!;
      Object.assign(rows, normalise(starter.map));
      commit();
    });
  }

  // Cycling rather than a radio group per rank: fourteen ranks × five powers is
  // seventy controls on a 390 px screen otherwise.
  for (const el of root.querySelectorAll<HTMLElement>("[data-rank]")) {
    el.addEventListener("click", () => {
      const key = el.dataset.rank!;
      const at = SELECTABLE_POWERS.indexOf(rows[key]!);
      rows[key] = SELECTABLE_POWERS[(at + 1) % SELECTABLE_POWERS.length]!;
      commit();
    });
  }

  paint();
}
