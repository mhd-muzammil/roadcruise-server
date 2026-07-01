/**
 * AuthProvider contract. Each identity provider implements authenticate(),
 * returning a NORMALIZED profile the AuthService maps onto an ERP user.
 * Business logic (find/create/link/token) lives in AuthService and never knows
 * which provider was used — so Microsoft/Apple/GitHub/Facebook are added by
 * writing a new provider + registering it, with no changes to the login flow.
 *
 * Normalized profile shape:
 *   { provider, sub, email, emailVerified, name, picture }
 */
export class AuthProvider {
  get name() {
    return "base";
  }
  // eslint-disable-next-line no-unused-vars
  async authenticate(credentials) {
    throw new Error("authenticate not implemented");
  }
}

export default AuthProvider;
