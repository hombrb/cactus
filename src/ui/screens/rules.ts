import type { Settings } from "../settings";

/** French rules, mirroring docs/01, adapted to the selected preset. */
export function renderRules(root: HTMLElement, settings: Settings, onBack: () => void): void {
  const school = settings.preset === "school";

  const powers = school
    ? `<li><b>8</b> — regarde une de tes cartes.</li>`
    : `
      <li><b>7</b> ou <b>8</b> — regarde une de tes cartes.</li>
      <li><b>9</b> ou <b>10</b> — regarde une carte de l'adversaire.</li>
      <li><b>Valet</b> ou <b>Dame</b> — échange à l'aveugle une de tes cartes contre une des siennes.</li>
      <li><b>Roi noir</b> — regarde une carte de chaque, puis décide d'échanger ou non.</li>`;

  const values = school
    ? `<li>Tous les <b>Rois</b> valent 0.</li>
       <li><b>Valet</b> et <b>Dame</b> valent 10, l'<b>As</b> vaut 1.</li>
       <li>Les autres cartes valent leur numéro.</li>`
    : `<li><b>Roi rouge</b> ♥ ♦ vaut 0 — la meilleure carte du jeu.</li>
       <li><b>Roi noir</b> ♠ ♣ vaut 13 — la pire, mais elle a le meilleur pouvoir.</li>
       <li><b>Dame</b> 12, <b>Valet</b> 11, <b>As</b> 1.</li>
       <li>Les autres cartes valent leur numéro.</li>`;

  const ending = school
    ? `<p>Quand tu penses avoir <b>5 points ou moins</b>, annonce <b>Cactus</b> à la fin de ton tour.
        L'adversaire joue un dernier tour, puis on retourne tout. Tous ceux à 5 ou moins « ont cactus ».</p>`
    : `<p>Annonce <b>Cactus</b> à la fin de ton tour quand tu penses être le plus bas.
        L'adversaire joue un dernier tour, puis on retourne tout.</p>
       <p>Si tu es bien le plus bas, tu marques <b>0</b>. Sinon — <b>y compris en cas d'égalité</b> —
        ton total est <b>doublé</b>. Annoncer est un pari.</p>`;

  const snap = settings.snap
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
          <p>Avoir le <b>total le plus bas</b>. Tu as quatre cartes face cachée devant toi
             et tu n'en connais que deux au départ : le jeu est un exercice de mémoire et de pari.</p>
        </section>

        <section>
          <h3>Valeurs</h3>
          <ul>${values}</ul>
        </section>

        <section>
          <h3>Ton tour</h3>
          <p>Une seule action :</p>
          <ul>
            <li><b>Piocher</b>, puis soit poser la carte sur une des tiennes (celle qu'elle remplace part à la défausse),
                soit la <b>défausser directement</b> — et là son pouvoir s'active.</li>
            <li><b>Prendre la défausse</b>, et l'échanger obligatoirement contre une de tes cartes. Aucun pouvoir.</li>
          </ul>
          <p class="callout">Un pouvoir ne s'active que sur une carte <b>piochée puis défaussée</b>.
             Utiliser une carte pour sa valeur ou pour son pouvoir : il faut choisir.</p>
        </section>

        <section>
          <h3>Pouvoirs</h3>
          <ul>${powers}</ul>
          <p>Viser une carte interdite coûte une carte de pénalité et met fin à ton tour.</p>
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
            ${settings.snap ? "<li><b>Glisser vers le centre</b> — défausse rapide.</li>" : ""}
          </ul>
        </section>
      </article>
    </div>
  `;

  root.querySelector('[data-act="back"]')!.addEventListener("click", onBack);
}
