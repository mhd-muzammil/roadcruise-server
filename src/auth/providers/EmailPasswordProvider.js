import { AuthProvider } from "./AuthProvider.js";
import { findByEmail } from "../core/userService.js";

/**
 * EmailPasswordProvider — represents the EXISTING local auth within the provider
 * abstraction. NOTE: the live POST /api/auth/login route is intentionally left
 * untouched (zero breaking changes); this provider exists so the unified model
 * recognizes "local" as a first-class provider and future code can authenticate
 * uniformly. It mirrors the existing plaintext comparison exactly.
 */
export class EmailPasswordProvider extends AuthProvider {
  get name() {
    return "local";
  }
  async authenticate({ email, password }) {
    const user = findByEmail(email);
    if (!user || user.password == null || user.password !== password) {
      const err = new Error("Invalid email or password");
      err.code = "INVALID_CREDENTIALS";
      throw err;
    }
    return {
      provider: "local",
      sub: null,
      email: user.email,
      emailVerified: !!user.emailVerified,
      name: user.name,
      picture: user.avatar || null,
    };
  }
}

export default EmailPasswordProvider;
