/** Bounded public projections; credentials and session cookies stay out of state. */
export interface ControlPrincipal {
  id: string;
  username: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  capabilities: readonly string[];
  revision: number;
}

export interface ControlStatus { claimed: boolean; bootstrapConfigured: boolean; }
export interface ControlSessionProjection { principal: ControlPrincipal; expiresAt: string; }
export interface ControlSessionResponse extends ControlSessionProjection { csrfToken: string; }
