tolk 1.3

const ERR_UNSUPPORTED_MESSAGE = 0xffff;
const ERR_NOT_OWNER = 100;
const ERR_NOT_RESOLVER = 101;
const ERR_ALREADY_CREATED = 102;
const ERR_MARKET_NOT_CREATED = 103;
const ERR_BAD_DIRECTION = 104;
const ERR_BAD_TIMESTAMPS = 105;
const ERR_BAD_TOKEN = 106;
const ERR_MARKET_CLOSED = 107;
const ERR_ZERO_BET = 108;
const ERR_ALREADY_RESOLVED = 109;
const ERR_NOT_RESOLVED = 110;
const ERR_ALREADY_CLAIMED = 111;
const ERR_NOT_WINNER = 112;
const ERR_BAD_POOL = 113;
const ERR_BET_TOO_SMALL = 114;
const ERR_OPPOSITE_SIDE_BET = 115;
const ERR_UNCONTESTED = 116;
const ERR_BAD_ADDRESS = 117;

const STATUS_UNINITIALIZED = 0 as uint8;
const STATUS_OPEN = 1 as uint8;
const STATUS_LOCKED = 2 as uint8;
const STATUS_RESOLVED_YES = 3 as uint8;
const STATUS_RESOLVED_NO = 4 as uint8;

const DIRECTION_ABOVE = 0 as uint8;
const DIRECTION_BELOW = 1 as uint8;

const OUTCOME_NONE = 0 as uint8;
const OUTCOME_YES = 1 as uint8;
const OUTCOME_NO = 2 as uint8;

const TOKEN_TON = stringToBase256("TON") as uint64;
const TOKEN_STON = stringToBase256("STON") as uint64;
const TOKEN_TSTON = stringToBase256("tsTON") as uint64;
const TOKEN_UTYA = stringToBase256("UTYA") as uint64;
const TOKEN_MAJOR = stringToBase256("MAJOR") as uint64;
const TOKEN_REDO = stringToBase256("REDO") as uint64;
const MIN_BET = ton("0.001");

// Prices are stored as fixed-point integers with 6 decimals.
// Example: $3.420000 is stored as 3420000.

struct UserStake {
    yesAmount: coins;
    noAmount: coins;
    claimed: bool;
}

struct MarketMeta {
    marketId: uint64;
    assetId: uint64;
    threshold: uint128;
    direction: uint8;
    closeTime: uint64;
    resolveTime: uint64;
}

struct MarketRuntime {
    status: uint8;
    yesPool: coins;
    noPool: coins;
    finalPrice: uint128;
    resolvedOutcome: uint8;
}

struct Storage {
    ownerAddress: address;
    resolverAddress: address;
    deploymentSalt: uint64;
    marketMeta: Cell<MarketMeta>;
    marketRuntime: Cell<MarketRuntime>;
    userStakes: map<address, UserStake>;
}

fun Storage.load(): Storage {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

// Helper for wrappers/deploy scripts to build initial storage data.
fun createInitialStorage(ownerAddress: address, resolverAddress: address, deploymentSalt: uint64): Storage {
    val (_, ownerHash) = ownerAddress.getWorkchainAndHash();
    val (_, resolverHash) = resolverAddress.getWorkchainAndHash();
    assert (ownerHash != 0) throw ERR_BAD_ADDRESS;
    assert (resolverHash != 0) throw ERR_BAD_ADDRESS;

    return {
        ownerAddress,
        resolverAddress,
        deploymentSalt,
        marketMeta: MarketMeta {
            marketId: 0,
            assetId: 0,
            threshold: 0,
            direction: DIRECTION_ABOVE,
            closeTime: 0,
            resolveTime: 0,
        }.toCell(),
        marketRuntime: MarketRuntime {
            status: STATUS_UNINITIALIZED,
            yesPool: 0,
            noPool: 0,
            finalPrice: 0,
            resolvedOutcome: OUTCOME_NONE,
        }.toCell(),
        userStakes: createEmptyMap(),
    };
}

struct (0x6357b5ef) CreateMarket {
    marketId: uint64;
    assetId: uint64;
    threshold: uint128;
    direction: uint8;
    closeTime: uint64;
    resolveTime: uint64;
}

struct (0x26489d83) BetYes {}
struct (0x67633db7) BetNo {}

struct (0x9dfc7b54) ResolveMarket {
    finalPrice: uint128;
}

struct (0x3b4f6c92) ClaimReward {}

struct (0x7ef41230) RewardPaid {
    marketId: uint64;
    payout: coins;
    outcome: uint8;
}

type AllowedMessage = CreateMarket | BetYes | BetNo | ResolveMarket | ClaimReward;

fun isSupportedAssetId(assetId: uint64): bool {
    return assetId == TOKEN_TON ||
        assetId == TOKEN_STON ||
        assetId == TOKEN_TSTON ||
        assetId == TOKEN_UTYA ||
        assetId == TOKEN_MAJOR ||
        assetId == TOKEN_REDO;
}

fun Storage.getMarketMeta(self): MarketMeta {
    val meta = lazy self.marketMeta.load();
    return meta;
}

fun Storage.setMarketMeta(mutate self, data: MarketMeta) {
    self.marketMeta = data.toCell();
}

fun Storage.getMarketRuntime(self): MarketRuntime {
    val runtime = lazy self.marketRuntime.load();
    return runtime;
}

fun Storage.setMarketRuntime(mutate self, data: MarketRuntime) {
    self.marketRuntime = data.toCell();
}

fun Storage.lockIfNeeded(mutate self) {
    val meta = self.getMarketMeta();
    var runtime = self.getMarketRuntime();
    if (runtime.status == STATUS_OPEN && blockchain.now() >= meta.closeTime) {
        runtime.status = STATUS_LOCKED;
        self.setMarketRuntime(runtime);
    }
}

fun Storage.requireOpen(mutate self) {
    val runtime = self.getMarketRuntime();
    assert (runtime.status != STATUS_UNINITIALIZED) throw ERR_MARKET_NOT_CREATED;
    self.lockIfNeeded();
    assert (self.getMarketRuntime().status == STATUS_OPEN) throw ERR_MARKET_CLOSED;
}

fun Storage.requireResolved(self) {
    val runtime = self.getMarketRuntime();
    assert (
        runtime.status == STATUS_RESOLVED_YES || runtime.status == STATUS_RESOLVED_NO
    ) throw ERR_NOT_RESOLVED;
}

fun Storage.getUserStake(self, userAddress: address): UserStake {
    val lookup = self.userStakes.get(userAddress);
    if (lookup.isFound) {
        return lookup.loadValue();
    }
    return {
        yesAmount: 0,
        noAmount: 0,
        claimed: false,
    };
}

fun calculateOutcome(direction: uint8, threshold: uint128, finalPrice: uint128): uint8 {
    if (direction == DIRECTION_ABOVE) {
        return finalPrice > threshold ? OUTCOME_YES : OUTCOME_NO;
    }
    return finalPrice < threshold ? OUTCOME_YES : OUTCOME_NO;
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        CreateMarket => {
            var storage = lazy Storage.load();
            var meta = storage.getMarketMeta();
            var runtime = storage.getMarketRuntime();
            val (_, ownerHash) = storage.ownerAddress.getWorkchainAndHash();
            val (_, resolverHash) = storage.resolverAddress.getWorkchainAndHash();

            assert (ownerHash != 0) throw ERR_BAD_ADDRESS;
            assert (resolverHash != 0) throw ERR_BAD_ADDRESS;
            assert (in.senderAddress == storage.ownerAddress) throw ERR_NOT_OWNER;
            assert (runtime.status == STATUS_UNINITIALIZED) throw ERR_ALREADY_CREATED;
            assert (msg.direction == DIRECTION_ABOVE || msg.direction == DIRECTION_BELOW) throw ERR_BAD_DIRECTION;
            assert (msg.closeTime > blockchain.now()) throw ERR_BAD_TIMESTAMPS;
            assert (msg.resolveTime >= msg.closeTime) throw ERR_BAD_TIMESTAMPS;
            assert (isSupportedAssetId(msg.assetId)) throw ERR_BAD_TOKEN;

            meta.marketId = msg.marketId;
            meta.assetId = msg.assetId;
            meta.threshold = msg.threshold;
            meta.direction = msg.direction;
            meta.closeTime = msg.closeTime;
            meta.resolveTime = msg.resolveTime;
            runtime.status = STATUS_OPEN;
            storage.setMarketMeta(meta);
            storage.setMarketRuntime(runtime);
            storage.save();
        }

        BetYes => {
            var storage = lazy Storage.load();
            storage.requireOpen();
            assert (in.valueCoins > 0) throw ERR_ZERO_BET;
            assert (in.valueCoins >= MIN_BET) throw ERR_BET_TOO_SMALL;

            val currentStake = storage.getUserStake(in.senderAddress);
            assert (currentStake.noAmount == 0) throw ERR_OPPOSITE_SIDE_BET;
            var runtime = storage.getMarketRuntime();
            runtime.yesPool += in.valueCoins;
            storage.setMarketRuntime(runtime);
            storage.userStakes.set(in.senderAddress, {
                yesAmount: currentStake.yesAmount + in.valueCoins,
                noAmount: currentStake.noAmount,
                claimed: currentStake.claimed,
            });
            storage.save();
        }

        BetNo => {
            var storage = lazy Storage.load();
            storage.requireOpen();
            assert (in.valueCoins > 0) throw ERR_ZERO_BET;
            assert (in.valueCoins >= MIN_BET) throw ERR_BET_TOO_SMALL;

            val currentStake = storage.getUserStake(in.senderAddress);
            assert (currentStake.yesAmount == 0) throw ERR_OPPOSITE_SIDE_BET;
            var runtime = storage.getMarketRuntime();
            runtime.noPool += in.valueCoins;
            storage.setMarketRuntime(runtime);
            storage.userStakes.set(in.senderAddress, {
                yesAmount: currentStake.yesAmount,
                noAmount: currentStake.noAmount + in.valueCoins,
                claimed: currentStake.claimed,
            });
            storage.save();
        }

        ResolveMarket => {
            var storage = lazy Storage.load();
            val meta = storage.getMarketMeta();
            var runtime = storage.getMarketRuntime();

            assert (runtime.status != STATUS_UNINITIALIZED) throw ERR_MARKET_NOT_CREATED;
            assert (in.senderAddress == storage.resolverAddress) throw ERR_NOT_RESOLVER;

            if (blockchain.now() >= meta.closeTime && runtime.status == STATUS_OPEN) {
                runtime.status = STATUS_LOCKED;
                storage.setMarketRuntime(runtime);
            }

            runtime = storage.getMarketRuntime();
            assert (runtime.status == STATUS_LOCKED) throw ERR_MARKET_CLOSED;
            assert (blockchain.now() >= meta.resolveTime) throw ERR_BAD_TIMESTAMPS;
            assert (runtime.resolvedOutcome == OUTCOME_NONE) throw ERR_ALREADY_RESOLVED;
            assert (runtime.yesPool > 0) throw ERR_UNCONTESTED;
            assert (runtime.noPool > 0) throw ERR_UNCONTESTED;

            runtime.finalPrice = msg.finalPrice;
            runtime.resolvedOutcome = calculateOutcome(
                meta.direction,
                meta.threshold,
                msg.finalPrice,
            );
            runtime.status = runtime.resolvedOutcome == OUTCOME_YES
                ? STATUS_RESOLVED_YES
                : STATUS_RESOLVED_NO;
            storage.setMarketRuntime(runtime);
            storage.save();
        }

        ClaimReward => {
            var storage = lazy Storage.load();
            storage.requireResolved();
            val meta = storage.getMarketMeta();
            val runtime = storage.getMarketRuntime();

            val currentStake = storage.getUserStake(in.senderAddress);
            assert (!currentStake.claimed) throw ERR_ALREADY_CLAIMED;

            val winningStake = runtime.resolvedOutcome == OUTCOME_YES
                ? currentStake.yesAmount
                : currentStake.noAmount;
            val winningPool = runtime.resolvedOutcome == OUTCOME_YES
                ? runtime.yesPool
                : runtime.noPool;
            val losingPool = runtime.resolvedOutcome == OUTCOME_YES
                ? runtime.noPool
                : runtime.yesPool;

            assert (winningStake > 0) throw ERR_NOT_WINNER;
            assert (winningPool > 0) throw ERR_BAD_POOL;

            val payout = (winningStake * (winningPool + losingPool)) / winningPool;

            storage.userStakes.set(in.senderAddress, {
                yesAmount: currentStake.yesAmount,
                noAmount: currentStake.noAmount,
                claimed: true,
            });
            storage.save();

            val payoutMsg = createMessage({
                bounce: BounceMode.NoBounce,
                value: payout,
                dest: in.senderAddress,
                body: RewardPaid {
                    marketId: meta.marketId,
                    payout,
                    outcome: runtime.resolvedOutcome,
                },
            });
            payoutMsg.send(SEND_MODE_REGULAR);
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_UNSUPPORTED_MESSAGE;
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {}

get fun get_market_state(): (
    uint64,
    uint64,
    uint128,
    uint8,
    uint64,
    uint64,
    uint8,
    coins,
    coins,
    uint128,
    uint8
) {
    val storage = lazy Storage.load();
    val meta = storage.getMarketMeta();
    val runtime = storage.getMarketRuntime();
    return (
        meta.marketId,
        meta.assetId,
        meta.threshold,
        meta.direction,
        meta.closeTime,
        meta.resolveTime,
        runtime.status,
        runtime.yesPool,
        runtime.noPool,
        runtime.finalPrice,
        runtime.resolvedOutcome,
    );
}

get fun get_user_stake(userAddress: address): (coins, coins, bool) {
    val storage = lazy Storage.load();
    val stake = storage.getUserStake(userAddress);
    return (stake.yesAmount, stake.noAmount, stake.claimed);
}
