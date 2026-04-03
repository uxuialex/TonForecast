import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import {
    buildMarketQuestion,
    DIRECTION_ABOVE,
    ERR_OPPOSITE_SIDE_BET,
    ERR_UNCONTESTED,
    MIN_BET,
    OUTCOME_YES,
    STATUS_RESOLVED_YES,
    TonForecastMarket,
    derivePositionSummary,
    toPrice6,
} from '../wrappers/TonForecastMarket';

describe('TonForecastMarket happy path', () => {
    let code: Cell;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let resolver: SandboxContract<TreasuryContract>;
    let yesBettor: SandboxContract<TreasuryContract>;
    let noBettor: SandboxContract<TreasuryContract>;
    let contract: SandboxContract<TonForecastMarket>;

    beforeAll(async () => {
        code = await compile('TonForecastMarket');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        resolver = await blockchain.treasury('resolver');
        yesBettor = await blockchain.treasury('yes-bettor');
        noBettor = await blockchain.treasury('no-bettor');

        contract = blockchain.openContract(
            TonForecastMarket.createFromConfig(
                {
                    ownerAddress: owner.address,
                    resolverAddress: resolver.address,
                    deploymentSalt: 2n,
                },
                code,
            ),
        );

        await contract.sendDeploy(owner.getSender(), toNano('0.05'));

        const now = BigInt(blockchain.now ?? Math.floor(Date.now() / 1000));
        await contract.sendCreateMarket(owner.getSender(), toNano('0.05'), {
            marketId: 7n,
            assetId: 'TON',
            threshold: toPrice6('3.42'),
            direction: DIRECTION_ABOVE,
            closeTime: now + 5n,
            resolveTime: now + 10n,
        });
    });

    it('runs create -> bet yes/no -> resolve -> claim', async () => {
        let state = await contract.getMarketState();
        expect(buildMarketQuestion(state)).toBe('Will TON be above $3.420000?');

        await contract.sendBetYes(yesBettor.getSender(), toNano('10'));
        await contract.sendBetNo(noBettor.getSender(), toNano('5'));

        state = await contract.getMarketState();
        expect(state.yesPool).toBe(toNano('10'));
        expect(state.noPool).toBe(toNano('5'));

        blockchain.now = Number(state.resolveTime + 1n);

        const resolveResult = await contract.sendResolveMarket(
            resolver.getSender(),
            toNano('0.05'),
            toPrice6('3.50'),
        );

        expect(resolveResult.transactions).toHaveTransaction({
            from: resolver.address,
            to: contract.address,
            success: true,
        });

        state = await contract.getMarketState();
        expect(state.status).toBe(STATUS_RESOLVED_YES);
        expect(state.resolvedOutcome).toBe(OUTCOME_YES);

        const claimablePosition = derivePositionSummary(
            state,
            await contract.getUserStake(yesBettor.address),
        );
        expect(claimablePosition.positionStatus).toBe('CLAIMABLE');
        expect(claimablePosition.isClaimable).toBe(true);
        expect(claimablePosition.protocolFee).toBe(toNano('0.1'));
        expect(claimablePosition.payout).toBe(toNano('14.9'));

        const claimResult = await contract.sendClaimReward(
            yesBettor.getSender(),
            toNano('0.05'),
        );

        expect(claimResult.transactions).toHaveTransaction({
            from: yesBettor.address,
            to: contract.address,
            success: true,
        });
        expect(claimResult.transactions).toHaveTransaction({
            from: contract.address,
            to: yesBettor.address,
            success: true,
        });
        expect(claimResult.transactions).toHaveTransaction({
            from: contract.address,
            to: resolver.address,
            success: true,
        });

        const userStake = await contract.getUserStake(yesBettor.address);
        const claimedPosition = derivePositionSummary(state, userStake);
        expect(userStake.claimed).toBe(true);
        expect(userStake.yesAmount).toBe(toNano('10'));
        expect(claimedPosition.positionStatus).toBe('CLAIMED');

        const loserStake = await contract.getUserStake(noBettor.address);
        const loserPosition = derivePositionSummary(state, loserStake);
        expect(loserStake.claimed).toBe(false);
        expect(loserStake.noAmount).toBe(toNano('5'));
        expect(loserPosition.positionStatus).toBe('LOST');
    });

    it('rejects betting both sides from one address', async () => {
        await contract.sendBetYes(yesBettor.getSender(), toNano('1'));

        const result = await contract.sendBetNo(yesBettor.getSender(), toNano('1'));

        expect(result.transactions).toHaveTransaction({
            from: yesBettor.address,
            to: contract.address,
            success: false,
            exitCode: ERR_OPPOSITE_SIDE_BET,
        });
    });

    it('exposes min bet as 0.001 TON for scripts and UI guards', async () => {
        expect(MIN_BET).toBe(1_000_000n);
    });

    it('rejects resolve when market is uncontested', async () => {
        await contract.sendBetYes(yesBettor.getSender(), toNano('1'));
        const state = await contract.getMarketState();
        blockchain.now = Number(state.resolveTime + 1n);

        const result = await contract.sendResolveMarket(
            resolver.getSender(),
            toNano('0.05'),
            toPrice6('3.50'),
        );

        expect(result.transactions).toHaveTransaction({
            from: resolver.address,
            to: contract.address,
            success: false,
            exitCode: ERR_UNCONTESTED,
        });
    });
});
