import { Prisma } from "@prisma/client";

interface PricingInput {
  priceIdr: number;
  appFeePercentage: number | Prisma.Decimal;
  gasFeeIdr: number;
  wealthPriceIdr: number;
}

interface PricingResult {
  wealthAmount: Prisma.Decimal;
  appFeeAmount: Prisma.Decimal;
  gasFeeAmount: Prisma.Decimal;
  totalIdr: Prisma.Decimal;
}

/**
 * 3-Component Pricing:
 *   totalIdr = priceIdr + (priceIdr * appFeePercentage / 100) + gasFeeIdr
 *   wealthAmount = totalIdr / wealthPriceIdr
 *   appFeeAmount = appFeeInIdr / wealthPriceIdr
 *   gasFeeAmount = gasFeeIdr / wealthPriceIdr
 */
export function calculatePricing(input: PricingInput): PricingResult {
  const priceIdr = new Prisma.Decimal(input.priceIdr);
  const appFeePercentage = new Prisma.Decimal(input.appFeePercentage.toString());
  const gasFeeIdr = new Prisma.Decimal(input.gasFeeIdr);
  const wealthPriceIdr = new Prisma.Decimal(input.wealthPriceIdr);

  const appFeeInIdr = priceIdr.mul(appFeePercentage).div(100);
  const totalIdr = priceIdr.add(appFeeInIdr).add(gasFeeIdr);

  const wealthAmount = totalIdr.div(wealthPriceIdr);
  const appFeeAmount = appFeeInIdr.div(wealthPriceIdr);
  const gasFeeAmount = gasFeeIdr.div(wealthPriceIdr);

  return { wealthAmount, appFeeAmount, gasFeeAmount, totalIdr };
}
