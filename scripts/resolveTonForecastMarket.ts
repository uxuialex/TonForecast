import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    STATUS_LOCKED,
    STATUS_OPEN,
    formatPrice6,
    outcomeToText,
    statusToText,
    TonForecastMarket,
} from '../wrappers/TonForecastMarket';
// @ts-expect-error Shared resolver policy is authored in JS and consumed at runtime.
import { evaluateResolutionQuotes, formatResolutionQuotes } from '../apps/api/src/lib/marketResolvePolicy.js';
// @ts-expect-error Shared quote loader is authored in JS and consumed at runtime.
import { getResolutionQuoteCandidates } from '../apps/api/src/lib/stonApi.js';

function isManualResolveEnabled() {
    return process.env.ALLOW_MANUAL_RESOLVE?.trim() === '1';
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    if (!isManualResolveEnabled()) {
        throw new Error('Manual resolve is disabled by default. Set ALLOW_MANUAL_RESOLVE=1 only for emergency maintenance.');
    }

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

    if (!state.assetIdText) {
        throw new Error('market asset id is missing');
    }

    const decision = evaluateResolutionQuotes({
        assetIdText: state.assetIdText,
        direction: state.direction,
        threshold: state.threshold,
        quotes: await getResolutionQuoteCandidates(state.assetIdText),
    });
    if (!decision.ok) {
        throw new Error(`Resolver quote policy blocked settlement: ${decision.reason}`);
    }

    const finalPrice = decision.finalPrice;
    const expectedOutcome = decision.outcome;

    ui.write(`Current status: ${statusToText(state.status)}`);
    ui.write(`Threshold: $${formatPrice6(state.threshold)}`);
    ui.write(`Automatic final price: $${formatPrice6(finalPrice)}`);
    ui.write(`Price sources: ${formatResolutionQuotes(decision.quotes)}`);
    ui.write(`Spread: ${decision.spreadBps}bps`);
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
