import { useIntl, type IntlShape } from 'react-intl';
import type { CurrencyCode } from './index';
import { usePref } from './index';

/**
 * Placeholder display rates (USD → currency) until billing returns localized
 * prices. Charges stay in USD (Stripe, D-006); this only changes how prices
 * read for the chosen currency preference.
 */
export const MOCK_USD_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 150,
  TWD: 32,
  HKD: 7.8,
  KRW: 1350,
  IDR: 15800,
  THB: 36,
  VND: 25000,
  BRL: 5,
};

export function convertUsd(usd: number, currency: CurrencyCode): number {
  return usd * (MOCK_USD_RATES[currency] ?? 1);
}

/**
 * A USD price in the chosen currency through Intl. USD keeps the house style:
 * whole amounts without cents ($15), others with cents ($39.17). Other
 * currencies use their own minor units.
 */
export function formatPrice(intl: Pick<IntlShape, 'formatNumber'>, usd: number, currency: CurrencyCode = 'USD'): string {
  if (currency === 'USD') {
    const whole = Number.isInteger(usd);
    return intl.formatNumber(usd, { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  }
  const v = convertUsd(usd, currency);
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const whole = Number.isInteger(Math.round(v * 10 ** digits) / 10 ** digits);
  return intl.formatNumber(v, { style: 'currency', currency, minimumFractionDigits: whole ? 0 : digits, maximumFractionDigits: digits });
}

/** `formatPrice` bound to the current locale and currency preference. */
export function useFormatPrice(): (usd: number) => string {
  const intl = useIntl();
  const currency = usePref('currency');
  return (usd: number) => formatPrice(intl, usd, currency);
}
