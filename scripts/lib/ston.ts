import { Address } from '@ton/core';
import { formatPrice6, toPrice6 } from '../../wrappers/TonForecastMarket';

const STON_API_BASE = 'https://api.ston.fi';

type StonAsset = {
    contract_address: string;
    symbol: string | null;
    display_name?: string | null;
    default_symbol?: boolean;
    dex_price_usd?: string | null;
    dex_usd_price?: string | null;
};

type AssetsResponse = {
    asset_list: StonAsset[];
};

export type StonAssetQuote = {
    symbol: string;
    contractAddress: Address;
    priceUsd: bigint;
};

export async function fetchDefaultAssetQuote(symbol: string): Promise<StonAssetQuote> {
    const response = await fetch(`${STON_API_BASE}/v1/assets`);
    if (!response.ok) {
        throw new Error(`STON API returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as AssetsResponse;
    const match = payload.asset_list.find(
        (item) => item.symbol === symbol && item.default_symbol === true && item.dex_price_usd,
    );

    if (!match || !match.dex_price_usd) {
        throw new Error(`No default STON asset quote found for ${symbol}`);
    }

    return {
        symbol,
        contractAddress: Address.parse(match.contract_address),
        priceUsd: toPrice6(match.dex_price_usd),
    };
}

export async function fetchAssetQuoteByAddress(contractAddress: Address | string): Promise<StonAssetQuote> {
    const target = typeof contractAddress === 'string'
        ? Address.parse(contractAddress)
        : contractAddress;

    const response = await fetch(`${STON_API_BASE}/v1/assets`);
    if (!response.ok) {
        throw new Error(`STON API returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as AssetsResponse;
    const targetText = target.toString();
    const match = payload.asset_list.find((item) => {
        if (!item.contract_address || !item.dex_price_usd || !item.symbol) {
            return false;
        }

        try {
            return Address.parse(item.contract_address).toString() === targetText;
        } catch {
            return false;
        }
    });

    if (!match || !match.dex_price_usd || !match.symbol) {
        throw new Error(`No STON asset quote found for ${targetText}`);
    }

    return {
        symbol: match.symbol,
        contractAddress: Address.parse(match.contract_address),
        priceUsd: toPrice6(match.dex_price_usd),
    };
}

export function buildSuggestedThreshold(priceUsd: bigint, direction: 'above' | 'below'): bigint {
    if (direction === 'above') {
        return (priceUsd * 101n) / 100n;
    }
    return (priceUsd * 99n) / 100n;
}

export function describeSuggestedThreshold(priceUsd: bigint, threshold: bigint, direction: 'above' | 'below') {
    return [
        `Current price: $${formatPrice6(priceUsd)}`,
        `Suggested threshold for ${direction}: $${formatPrice6(threshold)}`,
    ].join('\n');
}
