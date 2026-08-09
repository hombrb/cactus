// Who this browser is, for as long as it keeps its localStorage — docs/10 §2.
//
// There are no accounts. A player is a `playerId` plus a display name, and the
// `playerId` is the whole of the credential: whoever presents it to a room is
// treated as that seat. It is therefore minted from `crypto.randomUUID` and
// must never be shown, logged, or put in a join link. The spec also mentions a
// separate rejoin token; with an unguessable id that token would be a second
// copy of the same secret, so there is deliberately only one.

const KEY = "cactus.identity.v1";

export interface Identity {
  readonly playerId: string;
  readonly name: string;
}

function mintId(): string {
  // randomUUID needs a secure context; a room needs a server anyway, so in
  // practice this is always https. The fallback keeps dev over plain http sane.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function loadIdentity(name: string): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<Identity>;
      if (typeof parsed.playerId === "string" && parsed.playerId.length > 0) {
        const identity = { playerId: parsed.playerId, name };
        localStorage.setItem(KEY, JSON.stringify(identity));
        return identity;
      }
    }
  } catch {
    // Private browsing: the player simply cannot rejoin after a reload.
  }

  const identity = { playerId: mintId(), name };
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // Same as above — a fresh id every load is a worse experience, not a bug.
  }
  return identity;
}
