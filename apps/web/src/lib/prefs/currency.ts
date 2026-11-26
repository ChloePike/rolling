import { useIntl, type IntlShape } from 'react-intl';
import type { CurrencyCode } from './index';

/**
 * Prices are shown and charged in USD only (D-019): pricing config is in USD
 * and Stripe charges USD, so there is no currency preference and no display
 * conversion. Formatting still follows the language through Intl (`$1,234.50`,
 * `1.234,50 $`). The `currency` argument is accepted for old callers and ignored.
 */
export function formatPrice(intl: Pick<IntlShape, 'formatNumber'>, usd: number, _currency?: CurrencyCode): string {
  const whole = Number.isInteger(usd);
  return intl.formatNumber(usd, { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** `formatPrice` bound to the current locale. */
export function useFormatPrice(): (usd: number) => string {
  const intl = useIntl();
  return (usd: number) => formatPrice(intl, usd);
}
