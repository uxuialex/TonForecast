import { Address, fromNano, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    buildMarketQuestion,
    deriveEffectiveStatus,
    MIN_BET,
    STATUS_OPEN,
    statusToText,
    TonForecastMarket,
} from '../wrappers/TonForecastMarket';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const contractAddress = await ui.inputAddress('TonForecastMarket address');
    const side = await ui.choose('Side', ['yes', 'no'] as const, (item) => item);
    const amountInput = await ui.input('Bet amount in TON');

    const contract = provider.open(
        TonForecastMarket.createFromAddress(Address.parse(contractAddress.toString())),
    );

    const state = await contract.getMarketState();
    const effectiveStatus = deriveEffectiveStatus(state);
    const amount = toNano(amountInput);

    ui.write(buildMarketQuestion(state));
    ui.write(`Current status: ${statusToText(effectiveStatus)}`);

    if (effectiveStatus !== STATUS_OPEN) {
        ui.write('Bet aborted: market is not OPEN.');
        return;
    }

    if (amount < MIN_BET) {
        ui.write(`Bet aborted: minimum bet is ${fromNano(MIN_BET)} TON.`);
        return;
    }

    await contract.sendBet(provider.sender(), amount, side);
    ui.setActionPrompt('Waiting for bet transaction confirmation...');
    await provider.waitForLastTransaction();
    ui.clearActionPrompt();

    const nextState = await contract.getMarketState();

    ui.write(`bet_${side} sent to ${contract.address.toString()}`);
    ui.write(`YES pool=${fromNano(nextState.yesPool)} TON`);
    ui.write(`NO pool=${fromNano(nextState.noPool)} TON`);
}
