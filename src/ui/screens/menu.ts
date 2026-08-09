export interface MenuActions {
  onPlay: () => void;
  onOnline: () => void;
  onRules: () => void;
  onSettings: () => void;
}

export function renderMenu(root: HTMLElement, actions: MenuActions): void {
  root.innerHTML = `
    <div class="screen screen--menu">
      <header class="brand">
        <div class="brand__mark" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <h1 class="brand__title">Cactus</h1>
        <p class="brand__sub">à deux, sur un ou plusieurs téléphones</p>
      </header>

      <nav class="menu">
        <button class="btn btn--big" data-kind="accent" type="button" data-act="play">
          Jouer sur ce téléphone
        </button>
        <button class="btn btn--big" type="button" data-act="online">Jouer à plusieurs</button>
        <button class="btn btn--big" type="button" data-act="rules">Règles</button>
        <button class="btn btn--big" type="button" data-act="settings">Réglages</button>
      </nav>

      <p class="hint" data-install hidden>
        Astuce : <b>Partager</b> → <b>Sur l'écran d'accueil</b> pour jouer en plein écran.
      </p>
    </div>
  `;

  root.querySelector('[data-act="play"]')!.addEventListener("click", actions.onPlay);
  root.querySelector('[data-act="online"]')!.addEventListener("click", actions.onOnline);
  root.querySelector('[data-act="rules"]')!.addEventListener("click", actions.onRules);
  root.querySelector('[data-act="settings"]')!.addEventListener("click", actions.onSettings);

  maybeShowInstallHint(root);
}

/**
 * iOS cannot be prompted programmatically — the only route is the share sheet.
 * So the hint is shown to iOS Safari users who are not already installed, and
 * to nobody else.
 */
function maybeShowInstallHint(root: HTMLElement): void {
  const nav = navigator as Navigator & { standalone?: boolean };
  const isStandalone =
    nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIos && !isStandalone) {
    root.querySelector<HTMLElement>("[data-install]")!.hidden = false;
  }
}
