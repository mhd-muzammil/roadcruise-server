import { config } from "../config/payment.config.js";
import { MockGateway } from "./MockGateway.js";
import { RazorpayGateway } from "./RazorpayGateway.js";

/**
 * Gateway factory + registry. Selected by PAYMENT_PROVIDER. Mock is the default
 * so the system runs with zero credentials. Add a vendor = add a class + one
 * line here; business logic is untouched.
 */
const REGISTRY = {
  mock: () => new MockGateway(),
  razorpay: () => new RazorpayGateway(),
  // stripe / cashfree / phonepe / paypal -> register adapters here
};

let instance = null;

export function getGateway() {
  if (instance) return instance;
  const factory = REGISTRY[config.provider];
  if (!factory) {
    throw new Error(
      `Unknown PAYMENT_PROVIDER "${config.provider}". Available: ${Object.keys(REGISTRY).join(", ")}`
    );
  }
  instance = factory();
  return instance;
}

/** test seam — reset the cached gateway (used by unit tests). */
export function _resetGateway() {
  instance = null;
}

export default getGateway;
