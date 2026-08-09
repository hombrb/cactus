// What the host is allowed to choose when opening a room.
//
// The client sends these three answers, never a `RuleConfig`. The server builds
// the config from its own presets, so a client cannot invent a rule — it can
// only pick from the ones the game already has. That also keeps the create
// request tiny and the validation obvious.

import { school, standard } from "../engine/config";
import type { RuleConfig } from "../engine/types";

export type PresetName = "standard" | "school";

export interface RoomSettings {
  readonly preset: PresetName;
  readonly snap: boolean;
  readonly scoreLimit: number | null;
}

export const defaultRoomSettings: RoomSettings = {
  preset: "standard",
  snap: true,
  scoreLimit: 100,
};

const MAX_SCORE_LIMIT = 1000;

/** Never throws: anything unrecognised falls back to the default. */
export function parseRoomSettings(raw: unknown): RoomSettings {
  if (raw === null || typeof raw !== "object") return defaultRoomSettings;
  const input = raw as Partial<Record<keyof RoomSettings, unknown>>;

  const limit = input.scoreLimit;
  return {
    preset: input.preset === "school" ? "school" : "standard",
    snap: input.snap !== false,
    scoreLimit:
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.min(Math.max(Math.round(limit), 1), MAX_SCORE_LIMIT)
        : limit === null
          ? null
          : defaultRoomSettings.scoreLimit,
  };
}

/**
 * The online counterpart of `configFrom` in `src/ui/settings.ts`.
 *
 * The difference that matters is timing: the flat table sets every timer to
 * null, because a phone lying between two people has no need to hurry anybody.
 * A room does — a player who walks away must not freeze the table — so the
 * preset's own timings are kept.
 */
export function configForRoom(settings: RoomSettings): RuleConfig {
  const base = settings.preset === "school" ? school : standard;
  const withSnap: RuleConfig = { ...base, snap: { ...base.snap, enabled: settings.snap } };
  // The school preset counts rounds instead of points, so a score limit would
  // be a contradiction rather than a setting.
  if (settings.preset === "school") return withSnap;
  return { ...withSnap, match: { ...withSnap.match, scoreLimit: settings.scoreLimit } };
}
