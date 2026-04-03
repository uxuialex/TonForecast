import { Address, fromNano, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    DIRECTION_ABOVE,
    DIRECTION_BELOW,
    formatPrice6,
    STATUS_UNINITIALIZED,
    statusToText,
    TonForecastMarket,
    toPrice6,
} from '../wrappers/TonForecastMarket';
import {
    buildSuggestedThreshold,
    describeSuggestedThreshold,
    fetchDefaultAssetQuote,
} from './lib/ston';

const TOKENS = ['TON', 'STON', 'tsTON', 'UTYA', 'MAJOR', 'REDO'] as const;
const DEFAULT_CLOSE_IN_SEC = 300n;
const DEFAULT_RESOLVE_DELAY_SEC = 10n;

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    const contractAddress = await ui.inputAddress('TonForecastMarket address');
    const token = await ui.choose('Token', [...TOKENS], (item) => item);
    const directionLabel = await ui.choose(
        'Direction',
        ['above', 'below'] as const,
        (item) => item,
    );
    const closeInSecInput = await ui.input(
        `Close in how many seconds? (default: ${DEFAULT_CLOSE_IN_SEC.toString()})`,
    );
    const resolveDelaySecInput = await ui.input(
        `Resolve delay after close in seconds? (default: ${DEFAULT_RESOLVE_DELAY_SEC.toString()})`,
    );
    const marketIdInput = await ui.input('Market id (uint64 integer)');

    const contract = provider.open(
        TonForecastMarket.createFromAddress(Address.parse(contractAddress.toString())),
    );

    const currentState = await contract.getMarketState();
    if (currentState.status !== STATUS_UNINITIALIZED) {
        ui.write(
            `Market already initialized on this contract. status=${currentState.status} marketId=${currentState.marketId}`,
        );
        return;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const closeInSec = closeInSecInput.trim()
        ? BigInt(closeInSecInput.trim())
        : DEFAULT_CLOSE_IN_SEC;
    const resolveDelaySec = resolveDelaySecInput.trim()
        ? BigInt(resolveDelaySecInput.trim())
        : DEFAULT_RESOLVE_DELAY_SEC;
    const closeTime = now + closeInSec;
    const resolveTime = closeTime + resolveDelaySec;
    const direction =
        directionLabel === 'above' ? DIRECTION_ABOVE : DIRECTION_BELOW;
    const quote = await fetchDefaultAssetQuote(token);
    const suggestedThreshold = buildSuggestedThreshold(quote.priceUsd, directionLabel);

    ui.write(describeSuggestedThreshold(quote.priceUsd, suggestedThreshold, directionLabel));

    const thresholdInput = await ui.input(
        `Threshold USD (press suggested value) -> ${formatPrice6(suggestedThreshold)}`,
    );
    const threshold = thresholdInput.trim()
        ? toPrice6(thresholdInput.trim())
        : suggestedThreshold;

    await contract.sendCreateMarket(provider.sender(), toNano('0.05'), {
        marketId: BigInt(marketIdInput),
        assetId: token,
        threshold,
        direction,
        closeTime,
        resolveTime,
    });

    ui.setActionPrompt('Waiting for create_market transaction confirmation...');
    await provider.waitForLastTransaction();
    ui.clearActionPrompt();

    const state = await contract.getMarketState();

    ui.write(`create_market sent to ${contract.address.toString()}`);
    ui.write(`market_id=${state.marketId.toString()}`);
    ui.write(`asset=${state.assetIdText}`);
    ui.write(`current_price=$${formatPrice6(quote.priceUsd)}`);
    ui.write(`threshold=$${formatPrice6(threshold)}`);
    ui.write(`direction=${directionLabel}`);
    ui.write(`close_time=${state.closeTime.toString()}`);
    ui.write(`resolve_time=${state.resolveTime.toString()}`);
    ui.write(`status=${statusToText(state.status)}`);
    ui.write(`yes_pool=${fromNano(state.yesPool)} TON`);
    ui.write(`no_pool=${fromNano(state.noPool)} TON`);
    ui.write(`auto_resolve_cmd=MARKET_ADDRESS=${contract.address.toString()} npm run resolver:auto`);
}
