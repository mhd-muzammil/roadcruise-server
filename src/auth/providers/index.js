import { EmailPasswordProvider } from "./EmailPasswordProvider.js";
import { GoogleProvider } from "./GoogleProvider.js";

/**
 * Provider registry. Add a provider = add a class + one line here. The
 * AuthService resolves providers by name; nothing else changes.
 *   future: microsoft, apple, github, facebook
 */
const REGISTRY = {
  local: new EmailPasswordProvider(),
  google: new GoogleProvider(),
};

export function getProvider(name) {
  const p = REGISTRY[name];
  if (!p) throw new Error(`Unknown auth provider: ${name}`);
  return p;
}

export const availableProviders = () => Object.keys(REGISTRY);

export default getProvider;
