/** The provider adapter registry (plan §10.2). */
import type { ProviderAdapter, ProviderId } from "../types";
import { creemAdapter } from "./creem";
import { dodoAdapter } from "./dodo";
import { lemonSqueezyAdapter } from "./lemonsqueezy";
import { paddleAdapter } from "./paddle";
import { polarAdapter } from "./polar";
import { shopifyAdapter } from "./shopify";
import { stripeAdapter } from "./stripe";
import { wooCommerceAdapter } from "./woocommerce";

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  stripe: stripeAdapter,
  polar: polarAdapter,
  lemonsqueezy: lemonSqueezyAdapter,
  paddle: paddleAdapter,
  dodo: dodoAdapter,
  creem: creemAdapter,
  shopify: shopifyAdapter,
  woocommerce: wooCommerceAdapter,
};

export function adapterFor(provider: string): ProviderAdapter | null {
  return (ADAPTERS as Record<string, ProviderAdapter | undefined>)[provider] ?? null;
}
