import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractABI,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
} from '@ton/core';

export const STATUS_UNINITIALIZED = 0;
export const STATUS_OPEN = 1;
export const STATUS_LOCKED = 2;
export const STATUS_RESOLVED_YES = 3;
export const STATUS_RESOLVED_NO = 4;
export const STATUS_RESOLVED_DRAW = 5;

export const DIRECTION_ABOVE = 0;
export const DIRECTION_BELOW = 1;

export const OUTCOME_NONE = 0;
export const OUTCOME_YES = 1;
export const OUTCOME_NO = 2;
export const OUTCOME_DRAW = 3;
export const ERR_BAD_TIMESTAMPS = 105;
export const ERR_MARKET_CLOSED = 107;
export const ERR_BET_TOO_SMALL = 114;
export const ERR_OPPOSITE_SIDE_BET = 115;
export const ERR_UNCONTESTED = 116;
export const ERR_BAD_ADDRESS = 117;
export const MIN_BET = 1_000_000n;
export const PROTOCOL_FEE_BPS = 200n;
export const BPS_SCALE = 10_000n;

export const OP_CREATE_MARKET = 0x6357b5ef;
export const OP_BET_YES = 0x26489d83;
export const OP_BET_NO = 0x67633db7;
export const OP_RESOLVE_MARKET = 0x9dfc7b54;
export const OP_CLAIM_REWARD = 0x3b4f6c92;

export type TonForecastMarketConfig = {
    ownerAddress: Address;
    resolverAddress: Address;
    treasuryAddress: Address;
    deploymentSalt: bigint;
};

export type MarketConfigState = {
    ownerAddress: Address;
    resolverAddress: Address;
    treasuryAddress: Address;
    deploymentSalt: bigint;
};

export type CreateMarketParams = {
    marketId: bigint;
    assetId: string | bigint;
    threshold: bigint;
    direction: typeof DIRECTION_ABOVE | typeof DIRECTION_BELOW;
    closeTime: bigint;
    resolveTime: bigint;
};

export type MarketState = {
    marketId: bigint;
    assetId: bigint;
    assetIdText: string;
    threshold: bigint;
    direction: number;
    closeTime: bigint;
    resolveTime: bigint;
    status: number;
    yesPool: bigint;
    noPool: bigint;
    finalPrice: bigint;
    resolvedOutcome: number;
};

export type UserStakeState = {
    yesAmount: bigint;
    noAmount: bigint;
    claimed: boolean;
};

export type PositionSide = 'yes' | 'no' | 'mixed' | 'none';

export type PositionStatus =
    | 'NO_POSITION'
    | 'OPEN'
    | 'LOCKED'
    | 'CLAIMABLE'
    | 'CLAIMED'
    | 'WON'
    | 'LOST';

export type PositionSummary = {
    side: PositionSide;
    totalStake: bigint;
    winningStake: bigint;
    protocolFee: bigint;
    payout: bigint;
    claimed: boolean;
    isResolved: boolean;
    isWinner: boolean;
    isClaimable: boolean;
    positionStatus: PositionStatus;
    effectiveMarketStatus: number;
};

export function formatPrice6(value: bigint): string {
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const whole = abs / 1_000_000n;
    const fraction = String(abs % 1_000_000n).padStart(6, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

export function directionToText(direction: number): 'above' | 'below' | 'unknown' {
    if (direction === DIRECTION_ABOVE) {
        return 'above';
    }
    if (direction === DIRECTION_BELOW) {
        return 'below';
    }
    return 'unknown';
}

export function statusToText(status: number): string {
    switch (status) {
        case STATUS_UNINITIALIZED:
            return 'UNINITIALIZED';
        case STATUS_OPEN:
            return 'OPEN';
        case STATUS_LOCKED:
            return 'LOCKED';
        case STATUS_RESOLVED_YES:
            return 'RESOLVED_YES';
        case STATUS_RESOLVED_NO:
            return 'RESOLVED_NO';
        case STATUS_RESOLVED_DRAW:
            return 'RESOLVED_DRAW';
        default:
            return `UNKNOWN_${status}`;
    }
}

export function deriveEffectiveStatus(
    state: Pick<MarketState, 'status' | 'closeTime' | 'resolveTime' | 'resolvedOutcome'>,
    nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): number {
    if (state.status === STATUS_OPEN && state.resolvedOutcome === OUTCOME_NONE) {
        if (nowSec >= state.resolveTime) {
            return STATUS_LOCKED;
        }
        if (nowSec >= state.closeTime) {
            return STATUS_LOCKED;
        }
    }

    return state.status;
}

export function outcomeToText(outcome: number): string {
    switch (outcome) {
        case OUTCOME_NONE:
            return 'NONE';
        case OUTCOME_YES:
            return 'YES';
        case OUTCOME_NO:
            return 'NO';
        case OUTCOME_DRAW:
            return 'DRAW';
        default:
            return `UNKNOWN_${outcome}`;
    }
}

export function positionStatusToText(status: PositionStatus): PositionStatus {
    return status;
}

export function derivePositionSide(stake: UserStakeState): PositionSide {
    const hasYes = stake.yesAmount > 0n;
    const hasNo = stake.noAmount > 0n;

    if (hasYes && hasNo) {
        return 'mixed';
    }
    if (hasYes) {
        return 'yes';
    }
    if (hasNo) {
        return 'no';
    }
    return 'none';
}

export function derivePositionSummary(
    market: MarketState,
    stake: UserStakeState,
    nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): PositionSummary {
    const effectiveMarketStatus = deriveEffectiveStatus(market, nowSec);
    const side = derivePositionSide(stake);
    const totalStake = stake.yesAmount + stake.noAmount;
    const isResolved =
        effectiveMarketStatus === STATUS_RESOLVED_YES ||
        effectiveMarketStatus === STATUS_RESOLVED_NO ||
        effectiveMarketStatus === STATUS_RESOLVED_DRAW;
    const winningStake = market.resolvedOutcome === OUTCOME_YES
        ? stake.yesAmount
        : market.resolvedOutcome === OUTCOME_NO
            ? stake.noAmount
            : market.resolvedOutcome === OUTCOME_DRAW
                ? totalStake
                : 0n;
    const winningPool = market.resolvedOutcome === OUTCOME_YES
        ? market.yesPool
        : market.resolvedOutcome === OUTCOME_NO
            ? market.noPool
            : market.resolvedOutcome === OUTCOME_DRAW
                ? totalStake
                : 0n;
    const totalPool = market.yesPool + market.noPool;
    const grossPayout = market.resolvedOutcome === OUTCOME_DRAW
        ? totalStake
        : winningStake > 0n && winningPool > 0n
        ? (winningStake * totalPool) / winningPool
        : 0n;
    const grossWinnings = market.resolvedOutcome === OUTCOME_DRAW
        ? 0n
        : grossPayout > winningStake
        ? grossPayout - winningStake
        : 0n;
    const protocolFee = (grossWinnings * PROTOCOL_FEE_BPS) / BPS_SCALE;
    const payout = grossPayout - protocolFee;
    const isWinner = isResolved && winningStake > 0n;
    const isClaimable = isWinner && !stake.claimed;

    let positionStatus: PositionStatus;
    if (totalStake === 0n) {
        positionStatus = 'NO_POSITION';
    } else if (stake.claimed) {
        positionStatus = 'CLAIMED';
    } else if (isClaimable) {
        positionStatus = 'CLAIMABLE';
    } else if (isWinner) {
        positionStatus = 'WON';
    } else if (isResolved) {
        positionStatus = 'LOST';
    } else if (effectiveMarketStatus === STATUS_LOCKED) {
        positionStatus = 'LOCKED';
    } else {
        positionStatus = 'OPEN';
    }

    return {
        side,
        totalStake,
        winningStake,
        protocolFee,
        payout,
        claimed: stake.claimed,
        isResolved,
        isWinner,
        isClaimable,
        positionStatus,
        effectiveMarketStatus,
    };
}

export function buildMarketQuestion(state: Pick<MarketState, 'assetIdText' | 'threshold' | 'direction'>): string {
    return `Will ${state.assetIdText} be ${directionToText(state.direction)} $${formatPrice6(state.threshold)}?`;
}

export function encodeAssetId(assetId: string): bigint {
    const bytes = Buffer.from(assetId, 'utf8');
    if (bytes.length > 8) {
        throw new Error(`Asset id "${assetId}" is too long for uint64 base256 encoding`);
    }

    let value = 0n;
    for (const byte of bytes) {
        value = (value << 8n) | BigInt(byte);
    }
    return value;
}

export function decodeAssetId(value: bigint): string {
    if (value === 0n) {
        return '';
    }

    const bytes: number[] = [];
    let current = value;
    while (current > 0n) {
        bytes.unshift(Number(current & 0xffn));
        current >>= 8n;
    }
    return Buffer.from(bytes).toString('utf8');
}

export function toPrice6(value: string | number): bigint {
    const text = String(value);
    const [wholePart, fractionPart = ''] = text.split('.');
    const normalizedFraction = (fractionPart + '000000').slice(0, 6);
    return BigInt(wholePart) * 1_000_000n + BigInt(normalizedFraction);
}

function isZeroAddress(address: Address): boolean {
    return [...address.hash].every((byte) => byte === 0);
}

export function tonForecastMarketConfigToCell(config: TonForecastMarketConfig): Cell {
    if (isZeroAddress(config.ownerAddress)) {
        throw new Error('ownerAddress must not be zero address');
    }
    if (isZeroAddress(config.resolverAddress)) {
        throw new Error('resolverAddress must not be zero address');
    }
    if (isZeroAddress(config.treasuryAddress)) {
        throw new Error('treasuryAddress must not be zero address');
    }

    const marketMeta = beginCell()
        .storeUint(0, 64)
        .storeUint(0, 64)
        .storeUint(0, 128)
        .storeUint(DIRECTION_ABOVE, 8)
        .storeUint(0, 64)
        .storeUint(0, 64)
        .endCell();

    const marketRuntime = beginCell()
        .storeUint(STATUS_UNINITIALIZED, 8)
        .storeCoins(0)
        .storeCoins(0)
        .storeUint(0, 128)
        .storeUint(OUTCOME_NONE, 8)
        .endCell();

    return beginCell()
        .storeAddress(config.ownerAddress)
        .storeAddress(config.resolverAddress)
        .storeAddress(config.treasuryAddress)
        .storeUint(config.deploymentSalt, 64)
        .storeRef(marketMeta)
        .storeRef(marketRuntime)
        .storeBit(0)
        .endCell();
}

export class TonForecastMarket implements Contract {
    abi: ContractABI = { name: 'TonForecastMarket' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new TonForecastMarket(address);
    }

    static createFromConfig(config: TonForecastMarketConfig, code: Cell, workchain = 0) {
        const data = tonForecastMarketConfigToCell(config);
        const init = { code, data };
        return new TonForecastMarket(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendCreateMarket(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: CreateMarketParams,
    ) {
        const assetId = typeof params.assetId === 'string'
            ? encodeAssetId(params.assetId)
            : params.assetId;

        const body = beginCell()
            .storeUint(OP_CREATE_MARKET, 32)
            .storeUint(params.marketId, 64)
            .storeUint(assetId, 64)
            .storeUint(params.threshold, 128)
            .storeUint(params.direction, 8)
            .storeUint(params.closeTime, 64)
            .storeUint(params.resolveTime, 64)
            .endCell();

        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        });
    }

    async sendBetYes(provider: ContractProvider, via: Sender, value: bigint) {
        const body = beginCell().storeUint(OP_BET_YES, 32).endCell();
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        });
    }

    async sendBetNo(provider: ContractProvider, via: Sender, value: bigint) {
        const body = beginCell().storeUint(OP_BET_NO, 32).endCell();
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        });
    }

    async sendBet(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        side: 'yes' | 'no',
    ) {
        if (side === 'yes') {
            return this.sendBetYes(provider, via, value);
        }
        return this.sendBetNo(provider, via, value);
    }

    async sendResolveMarket(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        finalPrice: bigint,
    ) {
        const body = beginCell()
            .storeUint(OP_RESOLVE_MARKET, 32)
            .storeUint(finalPrice, 128)
            .endCell();

        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        });
    }

    async sendClaimReward(provider: ContractProvider, via: Sender, value: bigint) {
        const body = beginCell().storeUint(OP_CLAIM_REWARD, 32).endCell();
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        });
    }

    async getMarketState(provider: ContractProvider): Promise<MarketState> {
        const result = await provider.get('get_market_state', []);
        const marketId = result.stack.readBigNumber();
        const assetId = result.stack.readBigNumber();
        const threshold = result.stack.readBigNumber();
        const direction = result.stack.readNumber();
        const closeTime = result.stack.readBigNumber();
        const resolveTime = result.stack.readBigNumber();
        const status = result.stack.readNumber();
        const yesPool = result.stack.readBigNumber();
        const noPool = result.stack.readBigNumber();
        const finalPrice = result.stack.readBigNumber();
        const resolvedOutcome = result.stack.readNumber();

        return {
            marketId,
            assetId,
            assetIdText: decodeAssetId(assetId),
            threshold,
            direction,
            closeTime,
            resolveTime,
            status,
            yesPool,
            noPool,
            finalPrice,
            resolvedOutcome,
        };
    }

    async getUserStake(provider: ContractProvider, userAddress: Address): Promise<UserStakeState> {
        const result = await provider.get('get_user_stake', [
            { type: 'slice', cell: beginCell().storeAddress(userAddress).endCell() },
        ]);

        return {
            yesAmount: result.stack.readBigNumber(),
            noAmount: result.stack.readBigNumber(),
            claimed: result.stack.readBoolean(),
        };
    }

    async getMarketConfig(provider: ContractProvider): Promise<MarketConfigState> {
        const result = await provider.get('get_market_config', []);

        return {
            ownerAddress: result.stack.readAddress(),
            resolverAddress: result.stack.readAddress(),
            treasuryAddress: result.stack.readAddress(),
            deploymentSalt: result.stack.readBigNumber(),
        };
    }
}
