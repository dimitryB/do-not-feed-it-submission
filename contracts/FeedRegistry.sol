// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Do Not Feed It — FeedRegistry v1 (docs/CHAIN.md §4–§5).
//
// Built on the dual-signature registry pattern of the author's Proof of
// Patience (same copyright holder). Not deployed, not audited.

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title FeedRegistry
/// @notice The record of filed shifts: a verifier-attested, player-signed
///         RunResult per run, each player's best, and the community pile — the
///         coins fed by token, per epoch and all time. A wallet's first
///         PILE_FILINGS_PER_EPOCH filings in an epoch feed the pile; later ones
///         still count for its best and the board (docs/CHAIN.md §7).
/// @dev Trust model (docs/CHAIN.md §2): the verifier replays the rules and
///      signs what it derived; the player's signature is attribution. Neither
///      signature proves a human played. The bounds here are defence in depth,
///      not proof of play. No funds, no token, no approvals, no external calls,
///      no upgradeability.
contract FeedRegistry is EIP712, Ownable2Step, Pausable {
    // ---------------------------------------------------------------- types

    /// @dev Field order is the EIP-712 typehash; it matches lib/chain/types.ts.
    struct RunResult {
        bytes32 runId;
        bytes32 gameVersion;
        address player;
        uint64 score;
        uint32 durationTicks;
        uint32 totalFeeds;
        uint32 btcFed;
        uint32 ethFed;
        uint32 hemiFed;
        uint32 bestCombo;
        uint32 frenzies;
        uint32 sizeCenti;
        uint8 ending;
        uint8 cause;
        bytes32 seed;
        bytes32 traceHash;
        bytes32 snapshotHash;
        uint64 deadline;
    }

    /// @dev One storage slot: coins fed by token and the filings that fed them, for a window.
    struct Diet {
        uint64 btc;
        uint64 eth;
        uint64 hemi;
        uint64 runs;
    }

    /// @dev One storage slot per player.
    struct Keeper {
        uint64 bestScore;
        uint32 bestUptime;
        uint32 runs;
    }

    // ------------------------------------------------------------ constants

    bytes32 private constant RESULT_TYPEHASH = keccak256(
        "RunResult(bytes32 runId,bytes32 gameVersion,address player,uint64 score,uint32 durationTicks,uint32 totalFeeds,uint32 btcFed,uint32 ethFed,uint32 hemiFed,uint32 bestCombo,uint32 frenzies,uint32 sizeCenti,uint8 ending,uint8 cause,bytes32 seed,bytes32 traceHash,bytes32 snapshotHash,uint64 deadline)"
    );
    bytes32 private constant ATTESTATION_TYPEHASH = keccak256("VerifierAttestation(bytes32 resultHash)");

    /// @notice Twelve minutes at 60 ticks a second: ARENA.maxTicks.
    uint32 public constant MAX_DURATION_TICKS = 43_200;
    /// @notice The shortest gap between two launches (a frenzy's cooldown): ARENA.frenzyCooldownTicks.
    uint32 public constant FEED_COOLDOWN_TICKS = 15;
    /// @notice Coins a broken crate pours into the mouth with no launch and no chew: TUNING.crateCoins.
    uint32 public constant CRATE_COINS = 3;
    /// @notice The shortest gap between two crates: TUNING.crateGapMin.
    uint32 public constant CRATE_GAP_MIN = 120;
    /// @notice Catches in a row that start a frenzy: TUNING.frenzyAt.
    uint32 public constant FEEDS_PER_FRENZY = 5;
    /// @notice Size ×100. TUNING.sizeMax is 2.4; this is loose.
    uint32 public constant MAX_SIZE_CENTI = 1_000;
    uint8 public constant MAX_ENDING = 3;
    uint8 public constant MAX_CAUSE = 2;
    /// @notice Loose: the theoretical maximum per tick is far lower (test/FeedRegistry.ts derives it from TUNING).
    uint64 public constant MAX_SCORE_PER_TICK = 4_000;
    /// @notice How far ahead of the block a deadline may be.
    uint64 public constant SIGNATURE_WINDOW = 30 minutes;
    uint64 public constant MIN_EPOCH_SECONDS = 1 hours;
    /// @notice How many of a wallet's filings in one epoch feed the pile. One wallet is not one
    ///         human; this bounds what a single wallet can do to the next creature, not a person.
    uint32 public constant PILE_FILINGS_PER_EPOCH = 3;

    // ------------------------------------------------------------ immutables

    /// @notice The deploy block's timestamp; epoch 0 starts here.
    uint64 public immutable GENESIS;
    uint64 public immutable EPOCH_SECONDS;

    // --------------------------------------------------------------- storage

    address public verifier;
    bytes32 public activeGameVersion;
    mapping(bytes32 runId => bool) public usedRunIds;
    mapping(address player => Keeper) private _keepers;
    mapping(uint64 epoch => Diet) private _epochDiet;
    mapping(uint64 epoch => mapping(address player => uint32)) private _filings;
    Diet private _allTime;

    // ---------------------------------------------------------------- events

    event ResultRecorded(
        bytes32 indexed runId,
        address indexed player,
        bytes32 indexed gameVersion,
        uint64 score,
        uint32 durationTicks,
        uint32 btcFed,
        uint32 ethFed,
        uint32 hemiFed,
        uint32 bestCombo,
        uint32 frenzies,
        uint32 sizeCenti,
        uint8 ending,
        uint8 cause,
        uint64 epoch,
        bytes32 snapshotHash,
        bytes32 traceHash
    );
    /// @notice This filing's coins went into the epoch's pile (and the all-time pile). Emitted
    ///         after its ResultRecorded, only for a wallet's first PILE_FILINGS_PER_EPOCH filings.
    event PileFed(bytes32 indexed runId, address indexed player, uint64 indexed epoch, uint32 btcFed, uint32 ethFed, uint32 hemiFed);
    event VerifierChanged(address indexed previousVerifier, address indexed nextVerifier);
    event GameVersionChanged(bytes32 indexed previousVersion, bytes32 indexed nextVersion);

    // ---------------------------------------------------------------- errors

    /// @dev A field out of bounds, a zero id or address, a deadline past the window, or a bad constructor/setter argument.
    error InvalidResult();
    /// @dev A signature that is malformed or not from the expected signer (player or verifier).
    error InvalidSignature();
    /// @dev The runId has been filed before. One-time, regardless of version.
    error DuplicateRun();
    /// @dev The result's gameVersion is not `activeGameVersion`.
    error WrongVersion();
    /// @dev The deadline is in the past.
    error Expired();
    error NotRenounceable();

    // ----------------------------------------------------------- constructor

    /// @param initialOwner    Owner (Ownable2Step: a transfer must be accepted).
    /// @param initialVerifier The verifier key that signs attestations.
    /// @param gameVersion     `gameVersionId(GAME_VERSION)`; see lib/chain/types.ts.
    /// @param epochSeconds    Epoch length; at least one hour. 86,400 at deploy.
    constructor(address initialOwner, address initialVerifier, bytes32 gameVersion, uint64 epochSeconds)
        EIP712("Do Not Feed It", "1")
        Ownable(initialOwner)
    {
        if (initialVerifier == address(0) || gameVersion == bytes32(0) || epochSeconds < MIN_EPOCH_SECONDS) {
            revert InvalidResult();
        }
        verifier = initialVerifier;
        activeGameVersion = gameVersion;
        GENESIS = uint64(block.timestamp);
        EPOCH_SECONDS = epochSeconds;
        emit VerifierChanged(address(0), initialVerifier);
        emit GameVersionChanged(bytes32(0), gameVersion);
    }

    // ------------------------------------------------------------------ file

    /// @notice File a shift. Anyone may send: a relayer cannot change a signed field.
    /// @param r                 The result the verifier derived and both parties signed.
    /// @param playerSignature   `r.player`'s EIP-712 signature over RunResult.
    /// @param verifierSignature The verifier's EIP-712 signature over VerifierAttestation(resultHash).
    function submitResult(RunResult calldata r, bytes calldata playerSignature, bytes calldata verifierSignature)
        external
        whenNotPaused
    {
        // Replay.
        if (usedRunIds[r.runId]) revert DuplicateRun();
        if (r.runId == bytes32(0) || r.player == address(0)) revert InvalidResult();

        // Version.
        if (r.gameVersion != activeGameVersion) revert WrongVersion();

        // Window: block.timestamp <= deadline <= block.timestamp + SIGNATURE_WINDOW.
        if (r.deadline < block.timestamp) revert Expired();
        if (r.deadline > block.timestamp + SIGNATURE_WINDOW) revert InvalidResult();

        // Bounds. Sums and products in uint256 so a hostile field cannot panic instead of reverting cleanly.
        if (r.durationTicks == 0 || r.durationTicks > MAX_DURATION_TICKS) revert InvalidResult();
        // Feeds: one launch per cooldown, plus every coin a crate could have poured.
        if (r.totalFeeds > r.durationTicks / FEED_COOLDOWN_TICKS + 1 + CRATE_COINS * (r.durationTicks / CRATE_GAP_MIN + 1)) revert InvalidResult();
        if (uint256(r.btcFed) + uint256(r.ethFed) + uint256(r.hemiFed) != r.totalFeeds) revert InvalidResult();
        if (r.bestCombo > r.totalFeeds) revert InvalidResult();
        if (r.frenzies > r.totalFeeds / FEEDS_PER_FRENZY + 1) revert InvalidResult();
        if (r.sizeCenti > MAX_SIZE_CENTI) revert InvalidResult();
        if (r.ending > MAX_ENDING || r.cause > MAX_CAUSE) revert InvalidResult();
        if (uint256(r.score) > uint256(r.durationTicks) * MAX_SCORE_PER_TICK) revert InvalidResult();

        // Signatures. tryRecover: a malformed signature is InvalidSignature, not an ECDSA error.
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, r)));
        (address signer,,) = ECDSA.tryRecover(digest, playerSignature);
        if (signer != r.player) revert InvalidSignature();
        bytes32 attestation = _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, digest)));
        (signer,,) = ECDSA.tryRecover(attestation, verifierSignature);
        if (signer != verifier) revert InvalidSignature();

        // Effects.
        usedRunIds[r.runId] = true;
        Keeper storage keeper = _keepers[r.player];
        if (r.score > keeper.bestScore) keeper.bestScore = r.score;
        if (r.durationTicks > keeper.bestUptime) keeper.bestUptime = r.durationTicks;
        keeper.runs += 1;
        uint64 epoch = currentEpoch();
        uint32 filed = ++_filings[epoch][r.player];
        bool feedsPile = filed <= PILE_FILINGS_PER_EPOCH;
        if (feedsPile) {
            _feed(_epochDiet[epoch], r);
            _feed(_allTime, r);
        }

        // Sixteen arguments: the legacy codegen runs out of stack here, so the build is viaIR (hardhat.config.ts).
        emit ResultRecorded(
            r.runId, r.player, r.gameVersion,
            r.score, r.durationTicks, r.btcFed, r.ethFed, r.hemiFed,
            r.bestCombo, r.frenzies, r.sizeCenti, r.ending, r.cause,
            epoch, r.snapshotHash, r.traceHash
        );
        if (feedsPile) emit PileFed(r.runId, r.player, epoch, r.btcFed, r.ethFed, r.hemiFed);
    }

    function _feed(Diet storage pile, RunResult calldata r) private {
        pile.btc += r.btcFed;
        pile.eth += r.ethFed;
        pile.hemi += r.hemiFed;
        pile.runs += 1;
    }

    // ----------------------------------------------------------------- views

    function bestScore(address player) external view returns (uint64) {
        return _keepers[player].bestScore;
    }

    function bestUptime(address player) external view returns (uint32) {
        return _keepers[player].bestUptime;
    }

    function runs(address player) external view returns (uint32) {
        return _keepers[player].runs;
    }

    function currentEpoch() public view returns (uint64) {
        return epochOf(uint64(block.timestamp));
    }

    /// @notice `(timestamp - GENESIS) / EPOCH_SECONDS`; a timestamp before GENESIS is epoch 0.
    function epochOf(uint64 timestamp) public view returns (uint64) {
        if (timestamp < GENESIS) return 0;
        return (timestamp - GENESIS) / EPOCH_SECONDS;
    }

    /// @notice The pile for an epoch: coins fed by token, and the filings that fed it (each
    ///         wallet's first PILE_FILINGS_PER_EPOCH; `runs(player)` counts every filing).
    function diet(uint64 epoch) external view returns (uint64 btc, uint64 eth, uint64 hemi, uint64 runs_) {
        Diet storage pile = _epochDiet[epoch];
        return (pile.btc, pile.eth, pile.hemi, pile.runs);
    }

    /// @notice How many shifts a wallet has filed in an epoch (all of them, fed or not).
    function filingsIn(uint64 epoch, address player) external view returns (uint32) {
        return _filings[epoch][player];
    }

    function allTimeDiet() external view returns (uint64 btc, uint64 eth, uint64 hemi, uint64 runs_) {
        return (_allTime.btc, _allTime.eth, _allTime.hemi, _allTime.runs);
    }

    /// @notice What the community fed it most in an epoch: 0 none, 1 btc, 2 eth, 3 hemi.
    ///         A tie goes to the earlier token (btc before eth before hemi). Matches `dominantOf` in lib/chain/types.ts.
    function dominant(uint64 epoch) external view returns (uint8) {
        Diet storage pile = _epochDiet[epoch];
        (uint64 btc, uint64 eth, uint64 hemi) = (pile.btc, pile.eth, pile.hemi);
        if (btc == 0 && eth == 0 && hemi == 0) return 0;
        if (btc >= eth && btc >= hemi) return 1;
        if (eth >= hemi) return 2;
        return 3;
    }

    // ----------------------------------------------------------------- owner

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setVerifier(address nextVerifier) external onlyOwner {
        if (nextVerifier == address(0)) revert InvalidResult();
        emit VerifierChanged(verifier, nextVerifier);
        verifier = nextVerifier;
    }

    /// @notice Rotate the accepted rules. A runId filed under an earlier version stays used.
    function setGameVersion(bytes32 nextVersion) external onlyOwner {
        if (nextVersion == bytes32(0)) revert InvalidResult();
        emit GameVersionChanged(activeGameVersion, nextVersion);
        activeGameVersion = nextVersion;
    }

    /// @notice The owner cannot vanish: a registry with no owner could never be unpaused or re-keyed.
    function renounceOwnership() public view override onlyOwner {
        revert NotRenounceable();
    }
}
