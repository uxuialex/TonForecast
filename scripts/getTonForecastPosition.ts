import { Address, fromNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    TonForecastMarket,
    buildMarketQuestion,
    derivePositionSummary,
    outcomeToText,
    positionStatusToText,
    statusToText,
} from '../wrappers/TonForecastMarket';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const senderAddress = provider.sender().address;
    const contractAddress = await ui.inputAddress('TonForecastMarket address');
    const positionAddress = await ui.inputAddress(
        'Position address',
        senderAddress ?? undefined,
    );

    const contract = provider.open(
        TonForecastMarket.createFromAddress(Address.parse(contractAddress.toString())),
    );

    const marketState = await contract.getMarketState();
    const stake = await contract.getUserStake(Address.parse(positionAddress.toString()));
    const summary = derivePositionSummary(marketState, stake);

    ui.write(`Address: ${contract.address.toString()}`);
    ui.write(`Position owner: ${positionAddress.toString()}`);
    ui.write(`Question: ${buildMarketQuestion(marketState)}`);
    ui.write(`Market status: ${statusToText(summary.effectiveMarketStatus)}`);
    ui.write(`Market outcome: ${outcomeToText(marketState.resolvedOutcome)}`);
    ui.write(`Position status: ${positionStatusToText(summary.positionStatus)}`);
    ui.write(`Side: ${summary.side}`);
    ui.write(`YES stake: ${fromNano(stake.yesAmount)} TON`);
    ui.write(`NO stake: ${fromNano(stake.noAmount)} TON`);
    ui.write(`Total stake: ${fromNano(summary.totalStake)} TON`);
    ui.write(`Claimed: ${summary.claimed ? 'yes' : 'no'}`);
    ui.write(`Claimable: ${summary.isClaimable ? 'yes' : 'no'}`);
    ui.write(`Estimated payout: ${fromNano(summary.payout)} TON`);
}
