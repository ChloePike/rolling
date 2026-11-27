import { useIntl, type IntlShape } from 'react-intl';
import type { CurrencyCode } from './index';

/**
 * Prices are shown and charged in USD only (D-019): pricing config is in USD
 * and Stripe charges USD, so there is no currency preference and no display
 * conversion. Formatting still follows the language through Intl (`$1,234.50`,
 * `1.234,50 $`). The `currency` argument is accepted for old callers and ignored.
 */
export function formatPrice(intl: Pick<IntlShape, 'formatNumber'>, usd: number, _currency?: CurrencyCode, options?: PriceOptions): string {
  const whole = Number.isInteger(usd);
  return intl.formatNumber(usd, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
    ...(options?.narrow && { currencyDisplay: 'narrowSymbol' }),
  });
}

export interface PriceOptions {
  /**
   * `$250` in every language (ko, zh-CN and zh-TW otherwise write `US$250`). Only for tight
   * tiles whose context already says USD, such as the top-up presets next to their Buy button.
   */
  narrow?: boolean;
}

/** `formatPrice` bound to the current locale. */
export function useFormatPrice(): (usd: number, options?: PriceOptions) => string {
  const intl = useIntl();
  return (usd: number, options?: PriceOptions) => formatPrice(intl, usd, undefined, options);
}
