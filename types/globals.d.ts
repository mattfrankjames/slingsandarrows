/**
 * Ambient declarations for things the browser doesn't know about.
 *
 * The Netlify Identity widget is loaded from a <script> tag, so it exists on
 * `window` at runtime but is invisible to the type checker. Declaring the
 * handful of members we actually call keeps `checkJs` honest without pulling
 * in a dependency for a library we are migrating away from in Phase 4.
 */

interface NetlifyIdentityUser {
  email: string;
  jwt(): Promise<string>;
}

interface NetlifyIdentityWidget {
  init(options?: { APIUrl?: string }): void;
  currentUser(): NetlifyIdentityUser | null;
  logout(): void;
  close(): void;
  open(tab?: string): void;
  on(event: 'init' | 'login' | 'logout' | 'error', handler: (arg?: any) => void): void;
}

interface Window {
  netlifyIdentity?: NetlifyIdentityWidget;
}
