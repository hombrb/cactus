// Finds a seed whose first stock card carries a given power, so the screenshot
// script can drive a specific situation. Run with: npx vite-node scripts/find-seed.ts
import { powerFor } from "../src/engine/cards";
import { table2p } from "../src/engine/config";
import { applyAction } from "../src/engine/reduce";
import { createMatch } from "../src/engine/turn";
import { cardOf } from "../src/engine/state";
import type { PowerKind } from "../src/engine/types";

function firstDraw(seed: string): PowerKind {
  let s = createMatch({
    config: table2p,
    players: [
      { id: "p1", name: "A" },
      { id: "p2", name: "B" },
    ],
    seed,
  });
  s = applyAction(s, { type: "StartMatch", playerId: "p1" }).state;
  const top = s.stock[0];
  return top ? powerFor(table2p, cardOf(s, top)) : "NONE";
}

const wanted: PowerKind[] = ["PEEK_OPPONENT", "PEEK_OWN", "LOOK_AND_SWAP", "BLIND_SWAP"];
const found: Partial<Record<PowerKind, string>> = {};

for (let i = 0; i < 5000 && Object.keys(found).length < wanted.length; i++) {
  const seed = `s${i}`;
  const power = firstDraw(seed);
  if (wanted.includes(power) && !found[power]) found[power] = seed;
}

console.log(JSON.stringify(found, null, 2));
