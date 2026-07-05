// Auth seam for Phase 2 (cloud collab). v0.2.x is single-user local install —
// every row gets workspace_id = 'local'. When cloud auth lands, this helper
// reads the session cookie / JWT and returns the real user/workspace.
//
// Routes that need to attribute writes call getCurrentUser(c). Routes that
// list/filter rows route through it too, even though today the filter is a
// no-op (every row is 'local'). That way the retrofit is mechanical.

export interface CurrentUser {
  id: string;
  workspaceId: string;
}

export const LOCAL_USER: CurrentUser = { id: "local", workspaceId: "local" };

export function getCurrentUser(_c?: unknown): CurrentUser {
  return LOCAL_USER;
}
