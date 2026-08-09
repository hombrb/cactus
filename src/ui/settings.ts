import { forTable, school, standard } from "../engine/config";
import type { RuleConfig } from "../engine/types";

export type PresetName = "standard" | "school";

export interface Settings {
  preset: PresetName;
  snap: boolean;
  names: [string, string];
  scoreLimit: number | null;
}

const KEY = "cactus.settings.v1";

export const defaultSettings: Settings = {
  preset: "standard",
  snap: true,
  names: ["Joueur 1", "Joueur 2"],
  scoreLimit: 100,
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
  const cfg = forTable(base, s.snap);
  if (s.preset === "school") return cfg;
  return { ...cfg, match: { ...cfg.match, scoreLimit: s.scoreLimit } };
}
