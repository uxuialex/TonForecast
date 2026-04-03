import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    STATUS_RESOLVED_DRAW,
    STATUS_RESOLVED_NO,
    STATUS_RESOLVED_YES,
    TonForecastMarket,
    deriveEffectiveStatus,
    outcomeToText,
    statusToText,
} from '../wrappers/TonForecastMarket';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const contractAddress = await ui.inputAddress('TonForecastMarket address');

    const contract = provider.open(
        TonForecastMarket.createFromAddress(Address.parse(contractAddress.toString())),
    );

    const state = await contract.getMarketState();
    const effectiveStatus = deriveEffectiveStatus(state);
    ui.write(`Status: ${statusToText(effectiveStatus)}`);
    ui.write(`Resolved outcome: ${outcomeToText(state.resolvedOutcome)}`);

    if (
        effectiveStatus !== STATUS_RESOLVED_YES &&
        effectiveStatus !== STATUS_RESOLVED_NO &&
        effectiveStatus !== STATUS_RESOLVED_DRAW
    ) {
        ui.write('Claim aborted: market is not resolved yet.');
        return;
    }

    await contract.sendClaimReward(provider.sender(), 50_000_000n);
    ui.setActionPrompt('Waiting for claim_reward transaction confirmation...');
    await provider.waitForLastTransaction();
    ui.clearActionPrompt();

    ui.write(`claim_reward sent to ${contract.address.toString()}`);
}
