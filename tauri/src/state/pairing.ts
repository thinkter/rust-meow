export interface PairingAuthSnapshot {
  paired: boolean;
  loggedIn: boolean;
}

export interface PairingStartupDecision {
  screen: "pairing" | "chats";
  startPairing: boolean;
}

export type QrPhase = "waiting" | "active" | "expired";

export interface QrPresentation {
  phase: QrPhase;
  secondsRemaining: number;
}

export function pairingStartupDecision(auth: PairingAuthSnapshot): PairingStartupDecision {
  if (auth.paired) return { screen: "chats", startPairing: false };
  return { screen: "pairing", startPairing: true };
}

export function qrPresentation(code: string, expiresAtMs: number, nowMs: number): QrPresentation {
  if (!code) return { phase: "waiting", secondsRemaining: 0 };
  if (expiresAtMs > 0 && nowMs >= expiresAtMs) {
    return { phase: "expired", secondsRemaining: 0 };
  }
  return {
    phase: "active",
    secondsRemaining: expiresAtMs > 0 ? Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1_000)) : 0,
  };
}
