// TonForecastMarket.tact
//
// MVP skeleton only. This file documents the intended onchain layout and
// message surface for the short-term prediction market contract.

const STATUS_OPEN: Int = 0;
const STATUS_LOCKED: Int = 1;
const STATUS_RESOLVED_YES: Int = 2;
const STATUS_RESOLVED_NO: Int = 3;

message CreateMarket {
    asset: Int;
    direction: Int;
    thresholdUsd: Int;
    durationSeconds: Int;
    creationPriceUsd: Int;
}

message BetYes {}
message BetNo {}

message ResolveMarket {
    finalPriceUsd: Int;
}

message Claim {}

struct Position {
    yesAmount: Int;
    noAmount: Int;
    claimed: Bool;
}

contract TonForecastMarket {
    creator: Address;
    resolver: Address;
    asset: Int;
    direction: Int;
    thresholdUsd: Int;
    creationPriceUsd: Int;
    createdAt: Int;
    closesAt: Int;
    resolvesAt: Int;
    finalPriceUsd: Int;
    status: Int;
    poolYes: Int;
    poolNo: Int;
    positions: map<Address, Position>;

    init(
        creator: Address,
        resolver: Address,
        asset: Int,
        direction: Int,
        thresholdUsd: Int,
        durationSeconds: Int,
        creationPriceUsd: Int
    ) {
        self.creator = creator;
        self.resolver = resolver;
        self.asset = asset;
        self.direction = direction;
        self.thresholdUsd = thresholdUsd;
        self.creationPriceUsd = creationPriceUsd;
        self.createdAt = now();
        self.closesAt = self.createdAt + durationSeconds;
        self.resolvesAt = self.closesAt;
        self.finalPriceUsd = 0;
        self.status = STATUS_OPEN;
        self.poolYes = 0;
        self.poolNo = 0;
    }

    receive(msg: BetYes) {
        self.ensureOpen();
        require(context().value > 0, "zero bet");

        let sender = sender();
        let position = self.positions.get(sender);
        let nextYes = context().value;
        let nextNo = 0;
        let claimed = false;

        if (position != null) {
            nextYes = position!!.yesAmount + context().value;
            nextNo = position!!.noAmount;
            claimed = position!!.claimed;
        }

        self.positions.set(sender, Position {
            yesAmount: nextYes,
            noAmount: nextNo,
            claimed: claimed
        });
        self.poolYes = self.poolYes + context().value;
    }

    receive(msg: BetNo) {
        self.ensureOpen();
        require(context().value > 0, "zero bet");

        let sender = sender();
        let position = self.positions.get(sender);
        let nextYes = 0;
        let nextNo = context().value;
        let claimed = false;

        if (position != null) {
            nextYes = position!!.yesAmount;
            nextNo = position!!.noAmount + context().value;
            claimed = position!!.claimed;
        }

        self.positions.set(sender, Position {
            yesAmount: nextYes,
            noAmount: nextNo,
            claimed: claimed
        });
        self.poolNo = self.poolNo + context().value;
    }

    receive(msg: ResolveMarket) {
        require(sender() == self.resolver, "resolver only");
        require(self.status < STATUS_RESOLVED_YES, "already resolved");

        if (now() >= self.closesAt && self.status == STATUS_OPEN) {
            self.status = STATUS_LOCKED;
        }

        require(self.status == STATUS_LOCKED || now() >= self.resolvesAt, "not ready");

        self.finalPriceUsd = msg.finalPriceUsd;
        self.status = self.computeOutcome(msg.finalPriceUsd);
    }

    receive(msg: Claim) {
        require(self.status == STATUS_RESOLVED_YES || self.status == STATUS_RESOLVED_NO, "not resolved");

        let sender = sender();
        let position = self.positions.get(sender);
        require(position != null, "no position");
        require(!position!!.claimed, "already claimed");

        let userStake = self.status == STATUS_RESOLVED_YES ? position!!.yesAmount : position!!.noAmount;
        let winnerPool = self.status == STATUS_RESOLVED_YES ? self.poolYes : self.poolNo;
        let loserPool = self.status == STATUS_RESOLVED_YES ? self.poolNo : self.poolYes;

        require(userStake > 0, "not winner");
        require(winnerPool > 0, "invalid pool");

        let payout = (userStake * (winnerPool + loserPool)) / winnerPool;

        self.positions.set(sender, Position {
            yesAmount: position!!.yesAmount,
            noAmount: position!!.noAmount,
            claimed: true
        });

        send(SendParameters {
            to: sender,
            value: payout,
            bounce: false
        });
    }

    fun ensureOpen() {
        if (now() >= self.closesAt && self.status == STATUS_OPEN) {
            self.status = STATUS_LOCKED;
        }

        require(self.status == STATUS_OPEN, "market closed");
    }

    fun computeOutcome(finalPriceUsd: Int): Int {
        if (self.direction == 0) {
            return finalPriceUsd > self.thresholdUsd ? STATUS_RESOLVED_YES : STATUS_RESOLVED_NO;
        }

        return finalPriceUsd < self.thresholdUsd ? STATUS_RESOLVED_YES : STATUS_RESOLVED_NO;
    }

    get fun marketState(): (Int, Int, Int, Int, Int, Int, Int) {
        return (
            self.asset,
            self.direction,
            self.thresholdUsd,
            self.status,
            self.poolYes,
            self.poolNo,
            self.finalPriceUsd
        );
    }
}
