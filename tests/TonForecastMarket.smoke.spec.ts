import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import {
    DIRECTION_ABOVE,
    STATUS_OPEN,
    TonForecastMarket,
    toPrice6,
} from '../wrappers/TonForecastMarket';

describe('TonForecastMarket smoke', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('TonForecastMarket');
    });

    it('deploys, creates a market and reads state', async () => {
        const blockchain = await Blockchain.create();

        const owner = await blockchain.treasury('owner');
        const resolver = await blockchain.treasury('resolver');

        const contract = blockchain.openContract(
            TonForecastMarket.createFromConfig(
                {
                    ownerAddress: owner.address,
                    resolverAddress: resolver.address,
                    deploymentSalt: 1n,
                },
                code,
            ),
        );

        const deployResult = await contract.sendDeploy(owner.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({
            from: owner.address,
            to: contract.address,
            deploy: true,
            success: true,
        });

        const now = BigInt(blockchain.now ?? Math.floor(Date.now() / 1000));

        const createResult = await contract.sendCreateMarket(owner.getSender(), toNano('0.05'), {
            marketId: 1n,
            assetId: 'TON',
            threshold: toPrice6('3.42'),
            direction: DIRECTION_ABOVE,
            closeTime: now + 60n,
            resolveTime: now + 90n,
        });

        expect(createResult.transactions).toHaveTransaction({
            from: owner.address,
            to: contract.address,
            success: true,
        });

        const state = await contract.getMarketState();
        expect(state.marketId).toBe(1n);
        expect(state.assetIdText).toBe('TON');
        expect(state.threshold).toBe(toPrice6('3.42'));
        expect(state.status).toBe(STATUS_OPEN);
    });
});
