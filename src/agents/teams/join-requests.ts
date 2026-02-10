/**
 * In-memory storage for team join requests.
 * Join requests are ephemeral and not persisted to disk.
 */

export type JoinRequest = {
  requestId: string;
  teamId: string;
  requesterSessionKey: string;
  requestedRole: string;
  message?: string;
  requestedAt: number;
};

const joinRequests = new Map<string, JoinRequest>();

/**
 * Add a join request.
 */
export function addJoinRequest(request: JoinRequest): void {
  joinRequests.set(request.requestId, request);
}

/**
 * Get a join request by ID.
 */
export function getJoinRequest(requestId: string): JoinRequest | null {
  return joinRequests.get(requestId) ?? null;
}

/**
 * List join requests for a team.
 */
export function listJoinRequestsForTeam(teamId: string): JoinRequest[] {
  return Array.from(joinRequests.values()).filter((req) => req.teamId === teamId);
}

/**
 * Remove a join request (after approval/rejection).
 */
export function removeJoinRequest(requestId: string): boolean {
  return joinRequests.delete(requestId);
}

/**
 * Check if a requester already has a pending request for a team.
 */
export function hasPendingRequest(teamId: string, requesterSessionKey: string): boolean {
  return Array.from(joinRequests.values()).some(
    (req) => req.teamId === teamId && req.requesterSessionKey === requesterSessionKey,
  );
}
