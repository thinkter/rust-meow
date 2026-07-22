import type { ChatParticipant } from "./types";

export const PARTICIPANT_ROW_HEIGHT = 54;
export const PARTICIPANT_HEADER_HEIGHT = 30;
export const PARTICIPANT_OVERSCAN = 6;

export type ParticipantRosterRow =
  | { kind: "header"; key: string; label: string }
  | { kind: "participant"; key: string; participant: ChatParticipant; position: number };

export function participantRosterRows(
  participants: readonly ChatParticipant[],
  sectioned: boolean,
): ParticipantRosterRow[] {
  if (!sectioned) {
    return participants.map((participant, index) => ({
      kind: "participant", key: participant.participantId, participant, position: index + 1,
    }));
  }
  const admins = participants.filter((participant) => participant.isAdmin || participant.isSuperAdmin);
  const members = participants.filter((participant) => !participant.isAdmin && !participant.isSuperAdmin);
  const result: ParticipantRosterRow[] = [];
  let position = 0;
  if (admins.length > 0) {
    result.push({ kind: "header", key: "admins", label: `ADMINS — ${admins.length}` });
    for (const participant of admins) {
      position += 1;
      result.push({ kind: "participant", key: participant.participantId, participant, position });
    }
  }
  if (members.length > 0) {
    result.push({ kind: "header", key: "members", label: `MEMBERS — ${members.length}` });
    for (const participant of members) {
      position += 1;
      result.push({ kind: "participant", key: participant.participantId, participant, position });
    }
  }
  return result;
}

/** Upper-bound used by the performance regression harness. */
export function participantDomBudget(viewportHeight: number, scale = 1): number {
  return Math.ceil(viewportHeight / (PARTICIPANT_ROW_HEIGHT * scale)) + PARTICIPANT_OVERSCAN * 2 + 2;
}
