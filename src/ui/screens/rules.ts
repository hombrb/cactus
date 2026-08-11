import type { RuleConfig } from "../../engine/types";
import { describePowers, describeSetup, describeTurn, describeValues } from "../rules-text";

/**
 * French rules, mirroring docs/01 — derived from the config in force.
 *
 * It takes a `RuleConfig` rather than `Settings` on purpose: the same screen
 * has to be able to describe a room's rules, which arrive as a config and never
 * as a preset name.
 */
export function renderRules(root: HTMLElement, cfg: RuleConfig, onBack: () => void): void {
  const powerLines = describePowers(cfg);
  const powers =
    powerLines.length === 0
      ? `<p>Aucune carte n'a de pouvoir dans cette variante.</p>`
      : `<ul>${powerLines
          .map((l) => `<li><b>${l.ranks}</b> — ${l.effect}</li>`)
          .join("")}</ul>
         <p>Viser une carte interdite coûte une carte de pénalité et met fin à ton tour.</p>`;

  const threshold = cfg.announce.requiresThreshold;
  // The moment you may announce is a rule, so it is read from the config like
  // everything else on this screen.
  const when =
    cfg.announce.timing === "AFTER_TURN"
      ? "après avoir joué — et encore pendant que l'adversaire joue, tant qu'il n'a pas fini son tour"
      : "à la fin de ton tour, avant de le terminer";
  const ending =
    threshold !== null
      ? `<p>Quand tu penses avoir <b>${threshold} points ou moins</b>, annonce <b>Cactus</b> ${when}.
          L'adversaire joue un dernier tour, puis on retourne tout. Tous ceux à ${threshold} ou moins « ont cactus ».</p>`
      : `<p>Annonce <b>Cactus</b> ${when}, quand tu penses être le plus bas.
          L'adversaire joue un dernier tour, puis on retourne tout.</p>
         <p>Si tu es bien le plus bas, tu marques <b>0</b>. Sinon${
           cfg.scoring.tieCountsAsFailure ? " — <b>y compris en cas d'égalité</b> —" : ""
         }
          ton total est <b>doublé</b>. Annoncer est un pari.</p>`;

  const snap = cfg.snap.enabled
    ? `<section>
         <h3>Défausse rapide</h3>
         <p>À tout moment, si une de tes cartes a la <b>même valeur</b> que le dessus de la défausse,
            <b>glisse-la vers le centre</b>. Réussi : la carte disparaît pour de bon et ta case reste vide.
            Raté : elle revient face cachée et tu prends une carte de pénalité.</p>
       </section>`
    : "";

  root.innerHTML = `
    <div class="screen screen--sheet">
      <header class="sheet__head">
        <button class="btn btn--icon" type="button" data-act="back" aria-label="retour">←</button>
        <h2>Règles</h2>
      </header>

      <article class="prose">
        <section>
          <h3>But du jeu</h3>
          <p>Avoir le <b>total le plus bas</b>. ${describeSetup(cfg)}
             Le jeu est un exercice de mémoire et de pari.</p>
        </section>

        <section>
          <h3>Valeurs</h3>
          <ul>${describeValues(cfg)
            .map((v) => `<li>${v}</li>`)
            .join("")}</ul>
        </section>

        <section>
          <h3>Ton tour</h3>
          <p>Une seule action :</p>
          <ul>${describeTurn(cfg)
            .map((t) => `<li>${t}</li>`)
            .join("")}</ul>
          <p class="callout">${
            cfg.powers.onHandDiscard
              ? `Un pouvoir s'active sur une carte <b>piochée puis défaussée</b>, et aussi sur
                 une carte <b>de ton jeu qui part à la défausse</b>. La carte que tu gardes,
                 elle, ne fait rien.`
              : `Un pouvoir ne s'active que sur une carte <b>piochée puis défaussée</b>.
                 Utiliser une carte pour sa valeur ou pour son pouvoir : il faut choisir.`
          }</p>
        </section>

        <section>
          <h3>Pouvoirs</h3>
          ${powers}
        </section>

        ${snap}

        <section>
          <h3>Fin de manche</h3>
          ${ending}
        </section>

        <section>
          <h3>Gestes</h3>
          <ul>
            <li><b>Toucher</b> — poser une carte, choisir une cible.</li>
            <li><b>Maintenir</b> — regarder une carte quand tu y as droit. Elle se cache dès que tu relâches, et tu n'y as droit qu'une fois.</li>
            ${cfg.snap.enabled ? "<li><b>Glisser vers le centre</b> — défausse rapide.</li>" : ""}
          </ul>
        </section>
      </article>
    </div>
  `;

  root.querySelector('[data-act="back"]')!.addEventListener("click", onBack);
}
