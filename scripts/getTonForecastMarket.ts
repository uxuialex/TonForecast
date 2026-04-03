import { Address, fromNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    buildMarketQuestion,
    deriveEffectiveStatus,
    directionToText,
    formatPrice6,
    outcomeToText,
    statusToText,
    TonForecastMarket,
} from '../wrappers/TonForecastMarket';

function formatTimestamp(timestamp: bigint) {
    if (timestamp === 0n) {
        return 'n/a';
    }

    const date = new Date(Number(timestamp) * 1000);
    return `${date.toISOString()} | local ${date.toLocaleString()}`;
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const contractAddress = await ui.inputAddress('TonForecastMarket address');

    const contract = provider.open(
        TonForecastMarket.createFromAddress(Address.parse(contractAddress.toString())),
    );

    const state = await contract.getMarketState();
    const effectiveStatus = deriveEffectiveStatus(state);

    ui.write(`Address: ${contract.address.toString()}`);
    ui.write(`Market #${state.marketId.toString()}`);
    ui.write(`Asset: ${state.assetIdText}`);
    ui.write(`Question: ${buildMarketQuestion(state)}`);
    ui.write(`Resolved: ${outcomeToText(state.resolvedOutcome)}`);
    ui.write(`Status: ${statusToText(effectiveStatus)}`);
    ui.write(`Direction: ${directionToText(state.direction)}`);
    ui.write(`Threshold: $${formatPrice6(state.threshold)}`);
    ui.write(`Final price: ${state.finalPrice === 0n ? 'n/a' : `$${formatPrice6(state.finalPrice)}`}`);
    ui.write(`Close time: ${formatTimestamp(state.closeTime)}`);
    ui.write(`Resolve time: ${formatTimestamp(state.resolveTime)}`);
    ui.write(`YES pool: ${fromNano(state.yesPool)} TON`);
    ui.write(`NO pool: ${fromNano(state.noPool)} TON`);
}
