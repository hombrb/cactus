import { forTable, parsePowerMap, school, standard, withPowerMap } from "../engine/config";
import type { PowerMap, RuleConfig } from "../engine/types";

export type PresetName = "standard" | "school";

export interface Settings {
  preset: PresetName;
  snap: boolean;
  names: [string, string];
  scoreLimit: number | null;
  /** null keeps the preset's own powers — see `src/ui/screens/powers.ts`. */
  powers: PowerMap | null;
  seedDiscard: boolean;
  takeFromDiscard: boolean;
  /** The turn ends by itself, and "Cactus" can still be said after it. */
  announceAfterTurn: boolean;
}

const KEY = "cactus.settings.v1";

export const defaultSettings: Settings = {
  preset: "standard",
  snap: true,
  names: ["Joueur 1", "Joueur 2"],
  scoreLimit: 100,
  powers: null,
  seedDiscard: true,
  takeFromDiscard: true,
  announceAfterTurn: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      preset: parsed.preset === "school" ? "school" : "standard",
      snap: parsed.snap !== false,
      names: [
        parsed.names?.[0]?.trim() || defaultSettings.names[0],
        parsed.names?.[1]?.trim() || defaultSettings.names[1],
      ],
      scoreLimit:
        parsed.scoreLimit === null || typeof parsed.scoreLimit === "number"
          ? parsed.scoreLimit
          : defaultSettings.scoreLimit,
      // Added after v1 shipped. Absent in stored settings, so both the missing
      // case and a hand-edited one have to degrade quietly rather than throw —
      // hence no key bump and no migration.
      powers: parsePowerMap(parsed.powers),
      seedDiscard: parsed.seedDiscard !== false,
      takeFromDiscard: parsed.takeFromDiscard !== false,
      announceAfterTurn: parsed.announceAfterTurn !== false,
    };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private browsing or a full quota: settings just do not persist.
  }
}

/** Settings → the engine's RuleConfig, always in flat-table timing. */
export function configFrom(s: Settings): RuleConfig {
  const base = s.preset === "school" ? school : standard;
  const cfg = withPowerMap(
    {
      ...forTable(base, s.snap),
      deck: { ...base.deck, seedDiscard: s.seedDiscard },
      turn: { ...base.turn, takeFromDiscard: s.takeFromDiscard },
      announce: {
        ...base.announce,
        timing: s.announceAfterTurn ? "AFTER_TURN" : "END_OF_TURN",
      },
    },
    s.powers,
  );
  if (s.preset === "school") return cfg;
  return { ...cfg, match: { ...cfg.match, scoreLimit: s.scoreLimit } };
}
