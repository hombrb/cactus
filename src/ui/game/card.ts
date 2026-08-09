import { SUIT_SYMBOL, rankLabel } from "../../engine/cards";
import type { Card } from "../../engine/types";

export type CardFace = "back" | "face" | "empty";

/**
 * Rank and suit are printed in two opposite corners, the second rotated 180° —
 * exactly like real playing cards. That is what makes the shared discard pile
 * legible from both ends of the table.
 */
export function createCardElement(className = "card"): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.dataset.face = "back";
  el.innerHTML = `
    <span class="card__corner card__corner--a"><b></b><i></i></span>
    <span class="card__pip"></span>
    <span class="card__corner card__corner--b"><b></b><i></i></span>
  `;
  return el;
}

export function paintCard(el: HTMLElement, face: CardFace, card?: Card): void {
  el.dataset.face = face;

  if (face !== "face" || !card) {
    el.removeAttribute("data-suit");
    el.setAttribute("aria-label", face === "empty" ? "emplacement vide" : "carte cachée");
    return;
  }

  const symbol = SUIT_SYMBOL[card.suit];
  const label = rankLabel(card.rank);
  el.dataset.suit = card.suit;

  for (const corner of el.querySelectorAll<HTMLElement>(".card__corner")) {
    corner.querySelector("b")!.textContent = label;
    corner.querySelector("i")!.textContent = symbol;
  }
  el.querySelector<HTMLElement>(".card__pip")!.textContent = symbol;
  el.setAttribute("aria-label", `${label} ${symbol}`);
}
