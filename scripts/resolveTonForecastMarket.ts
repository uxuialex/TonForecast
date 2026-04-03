import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    DIRECTION_ABOVE,
    DIRECTION_BELOW,
    OUTCOME_DRAW,
    OUTCOME_NO,
    OUTCOME_YES,
    STATUS_LOCKED,
    STATUS_OPEN,
    formatPrice6,
    outcomeToText,
    statusToText,
    TonForecastMarket,
} from '../wrappers/TonForecastMarket';
import { fetchDefaultAssetQuote } from './lib/ston';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const contractAddress = await ui.inputAddress('TonForecastMarket address');

    const contract = provider.open(TonForecastMarket.createFromAddress(Address.parse(contractAddress.toString())));
    const state = await contract.getMarketState();
    const now = BigInt(Math.floor(Date.now() / 1000));

    if (state.status !== STATUS_OPEN && state.status !== STATUS_LOCKED) {
        ui.write(`Skip: market already finalized with status ${statusToText(state.status)}`);
        return;
    }

    if (state.resolveTime > now) {
        ui.write(`Skip: resolve_time ${state.resolveTime} is still in the future`);
        return;
    }

    let finalPrice = state.finalPrice;
    let priceSource = 'unknown';

    try {
        if (state.assetIdText) {
            const quote = await fetchDefaultAssetQuote(state.assetIdText);
            finalPrice = quote.priceUsd;
            priceSource = `STON API default symbol ${quote.symbol}`;
        } else {
            throw new Error('market asset id is missing');
        }
    } catch (error) {
        throw new Error(`Automatic price fetch failed: ${(error as Error).message}`);
    }

    let expectedOutcome = OUTCOME_NO;
    if (
        (state.direction === DIRECTION_ABOVE && finalPrice > state.threshold) ||
        (state.direction === DIRECTION_BELOW && finalPrice < state.threshold)
    ) {
        expectedOutcome = OUTCOME_YES;
    } else if (finalPrice === state.threshold) {
        expectedOutcome = OUTCOME_DRAW;
    }

    ui.write(`Current status: ${statusToText(state.status)}`);
    ui.write(`Threshold: $${formatPrice6(state.threshold)}`);
    ui.write(`Automatic final price: $${formatPrice6(finalPrice)}`);
    ui.write(`Price source: ${priceSource}`);
    ui.write(`Expected outcome: ${outcomeToText(expectedOutcome)}`);

    await contract.sendResolveMarket(
        provider.sender(),
        50_000_000n,
        finalPrice,
    );

    ui.setActionPrompt('Waiting for resolve_market transaction confirmation...');
    await provider.waitForLastTransaction();
    ui.clearActionPrompt();

    const nextState = await contract.getMarketState();
    ui.write(`resolve_market sent for ${contract.address.toString()}`);
    ui.write(`Resolved status: ${statusToText(nextState.status)}`);
    ui.write(`Resolved outcome: ${outcomeToText(nextState.resolvedOutcome)}`);
    ui.write(`Stored final price: $${formatPrice6(nextState.finalPrice)}`);
}
