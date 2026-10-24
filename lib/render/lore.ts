import type { ArcadeState, Ingredient } from '../game/arcade';

/**
 * The lore, in words: this module is every line
 * of it the player reads. Nothing here is read by the rules: the rules keep
 * their kitchen words (MAGNET MOUTH, UTENSIL, DOUBLE BANK…) because their
 * traces and fixtures are frozen, and the screen translates on the way out.
 *
 * The double-meaning rule: every crypto word must also be literally true of
 * what is on screen. HARD FORK is a fork, SLIPPAGE is drool, TOKEN BURN is a
 * fire. A judge on a compressed stream who does not know the slang still sees
 * what happened. No prices, crashes, rugs, hacks or exploits; no real people.
 */

// ---- the coins and what they turn it into.

/** The three mutations, as the chips, the deck, the legend and the help name them. */
export const TOKEN_TRAITS: Record<Ingredient, string> = { metal: 'HODL jaws', balloon: 'Gas belly', pepper: 'Turbo breath' };

/**
 * How each coin flies, in plain words: the deck, the help and the legend say
 * it where the player picks a coin (tone rule 7: literal where you act).
 */
export const TOKEN_FLIGHT: Record<Ingredient, string> = { metal: 'Heavy', balloon: 'Floats', pepper: 'Straight' };

/** What it wants, by ticker. */
export const CRAVING_LINES: Record<Ingredient, string> = { metal: 'IT WANTS BTC.', balloon: 'IT WANTS ETH.', pepper: 'IT WANTS HEMI.' };

// ---- the rules' labels, translated.

/**
 * Rule labels to lore copy, applied in order as substring replacements, so a
 * suffix (×2, +500) rides through untouched. Longer phrases first.
 */
const PHRASES: readonly [string, string][] = [
  ['MAGNET MOUTH', 'HODL JAWS'],
  ['BALLOON BELLY', 'GAS BELLY'],
  ['FIRE BREATH', 'TURBO BREATH'],
  ['OFF THE BELLY', 'OFF THE GAS BELLY'],
  ['DOUBLE BANK', 'MULTI-HOP'],
  ['TRIPLE BANK', 'TRIPLE HOP'],
  // A piece of junk the renderer could not identify is a wallet; a known fork says HARD FORK (`CAPTIONS.fork`).
  ['UTENSIL', 'COLD STORAGE'],
  ['FORK IN THE WORKS', 'FORKED.'],
  ['BITTEN', 'FRONT-RUN'],
  ['TANTRUM', 'MAXI TANTRUM'],
  ['IT ATE THE VENT', 'EXTRACTOR: EATEN'],
  ['THE LAST SERVING', 'ONE TX PENDING'],
  // The rules' crates on the rail are blocks on a chain.
  ['CRATE', 'BLOCK'],
];
export function tokenCopy(label: string): string {
  let out = label;
  for (const [from, to] of PHRASES) if (out.includes(from)) out = out.split(from).join(to);
  return out;
}

// ---- the captions the renderer says on its own.

/**
 * One caption per thing that happens. `size` is the font size the renderer
 * draws it at, and `card` marks the boxed one-word cards; `tests/lore.test.mjs`
 * holds each to the width of the caption slot.
 */
export const CAPTIONS = {
  craved: 'ORDER FILLED.',
  // A coin eaten while it was waiting for a different one: eaten, grudgingly, and the look on its face.
  notThat: 'NOT THAT.',
  gasSpike: 'GAS SPIKE.',
  reverted: 'REVERTED.',
  dropped: 'TX DROPPED.',
  fork: (points: number) => `HARD FORK +${points}`,
  wallet: (points: number) => `COLD STORAGE +${points}`,
  walletJam: 'TX STUCK.',
  turbo: "TURBO'D.",
  burn: 'TOKEN BURN.',
  inhale: 'IT INHALES',
  breath: 'TURBO BREATH',
  scaling: 'SCALING.',
  noRoom: 'STATE BLOAT.',
  tantrum: 'MAXI TANTRUM.',
  sneeze: 'SNEEZE.',
  slippage: 'SLIPPAGE.',
  // The community's running answer to every "when?" — and the creature is, literally, coming out.
  lunge: 'IT IS STILL COMING.',
  // Max, Oct 7: "I wonder if there's something somebody could do in game where veHEMI is a weapon." The first breath of a shift.
  weapon: 'veHEMI IS A WEAPON.',
  // Max, Oct 7, on waiting for blocks: "just because Bitcoin being Bitcoin." Only ever said of a Bitcoin on the floor.
  btcMiss: 'BITCOIN BEING BITCOIN.',
  frenzy: 'FOMO',
  combo: 'COMBO',
  // A block on the chain under the ceiling, broken open by its own coin: the
  // coins inside pour into the mouth. A literal block, and a literal reward.
  blockReward: 'BLOCK REWARD.',
  // A block lowered out of the ceiling says whose it is (BLOCK_NAMES).
  bitcoinBlock: 'BITCOIN BLOCK.',
  etherBlock: 'ETHER BLOCK.',
  hemiBlock: 'HEMI BLOCK.',
  // A block nobody broke is hoisted back up through the ceiling: the block was missed.
  blockMissed: 'MISSED THE BLOCK.',
  // A coin that is not the block's own glances off it.
  wrongToken: 'WRONG TOKEN.',
} as const;

/** What each block says as it comes down: the coin that opens it. */
export const BLOCK_NAMES: Record<Ingredient, string> = {
  metal: CAPTIONS.bitcoinBlock, balloon: CAPTIONS.etherBlock, pepper: CAPTIONS.hemiBlock,
};

/**
 * The caption for a coin on the floor: Bitcoin being Bitcoin; anything else a
 * dropped transaction, except one miss in two, which gets one of the hosts'
 * verdicts — on running twenty minutes over, on running a minute over, on
 * whether there is a puzzle in it yet (by event id, so a replay says the same).
 */
export function missCaption(ingredient?: Ingredient | null, seed = 2): string {
  if (ingredient === 'metal') return CAPTIONS.btcMiss;
  const k = Math.abs(Math.floor(seed)) % 4;
  return k === 0 ? TALKBACK.miss : k === 1 ? TALKBACK.shrug : k === 2 ? CAPTIONS.dropped : TALKBACK.notYet;
}

/** A coin off the shut teeth: REVERTED., or one clank in three Rick's verdict on his own permission issues. */
export function revertCaption(seed: number): string {
  return Math.abs(Math.floor(seed)) % 3 === 2 ? TALKBACK.technical : CAPTIONS.reverted;
}

/** What it spits when FOMO starts: Rick's "Oh, doctor" the first time, then the room letting it cook, in turn (`n` is the shift's frenzy count, 0-based). */
export function frenzyLine(n: number): string {
  return Math.abs(Math.floor(n)) % 2 === 0 ? TALKBACK.frenzy : TALKBACK.cook;
}

/** A craving ignored: MAXI TANTRUM., or every other time John's verdict on an idea he did not like. */
export function tantrumCaption(seed: number): string {
  return Math.abs(Math.floor(seed)) % 2 === 0 ? CAPTIONS.tantrum : TALKBACK.tantrum;
}

/**
 * The creature talks back in the hosts' own words. Where the old captions
 * said NOM., it spits back a line from Midweek with Max or the Office Hours:
 * the catch lines in turn (so a judge hears a new one each time), the stuffed
 * ones when it was not even hungry, Rick's "Oh, doctor" when FOMO starts.
 * Short enough for the caption slot, true of the moment, never a name; the
 * sources and timestamps are in docs/QUOTES.md.
 */
export const TALKBACK = {
  catch: [
    'HEY MAN, FIBER.',
    "WE'RE GAMING.",
    "THAT'S REALLY SICK.",
    'I DOUBLE DARE YOU.',
    'DING, DING, DING.',
    'THIS LOOKS GREAT.',
    "LET'S HAVE SOME FUN.",
    'I RESPECT IT.',
    'ENJOY IT. LOVE LIFE.',
    'FOR THE LOLS.',
    'PRETTY ON BRAND.',
    "THAT'S COMMITMENT.",
    'AND BOOM.',
    'I DID IT.',
    'WELL PLAYED.',
    'OH MY GOODNESS.',
    'THE SOUND EFFECTS WORK.',
  ],
  stuffed: ["UNLESS IT'S OVERFLOWING.", 'GOT YOUR CARBS IN.', 'TWO FULL TURKEYS.', 'REASONABLE PEOPLE.'],
  frenzy: 'OH, DOCTOR.',
  // Oct 20, 54:58: the room letting the ZK rant run. A frenzy in a kitchen is the creature cooking; the second FOMO of a shift says so.
  cook: 'LET HIM COOK.',
  miss: "WE'VE DONE WORSE.",
  shrug: 'WELL, WHATEVER.',
  // Oct 21, 26:33: "Does it have a puzzle game component?" "Shockingly, no." "Not yet." A coin on the floor is not in the mouth yet.
  notYet: 'NOT YET.',
  // Oct 21, 51:57: "I have permission issues. That's technical." A coin off the shut teeth is a permission issue.
  technical: "THAT'S TECHNICAL.",
  tantrum: 'NOPE. HATE IT.',
} as const;

/** The `n`-th thing it says on a catch (0-based), from the stuffed lines when it was not hungry. */
export function catchLine(n: number, stuffed: boolean): string {
  const pool: readonly string[] = stuffed ? TALKBACK.stuffed : TALKBACK.catch;
  return pool[((Math.floor(n) % pool.length) + pool.length) % pool.length];
}

/**
 * The caption for a fork caught in its mouth. One in three is GLAMSTERDAM, the
 * next Ethereum hard fork, which the hosts cannot stop saying; the rest are
 * HARD FORK. `seed` is the event's id, so a replay says the same thing.
 */
export function forkCaption(seed: number, points: number): string {
  return Math.abs(Math.floor(seed)) % 3 === 0 ? `GLAMSTERDAM +${points}` : CAPTIONS.fork(points);
}

// ---- the night's end.

/** The cause line, by the rules' failure reason. */
export const CAUSES: Record<NonNullable<ArcadeState['failureReason']>, string> = {
  'empty-belly': 'OUT OF GAS.',
  'kitchen-destroyed': 'THE KITCHEN GOT REKT.',
  'outgrew-the-kitchen': 'IT REACHED SUPERFINALITY.',
};

/**
 * One joke per ending, by `state.ending` (0–3, smallest to largest): gas money,
 * a block, the mempool, the chain. Nothing about anyone's holdings, treasuries
 * or foundations — with REKT and a report on screen those read as an exploit.
 */
export const ENDING_JOKES: readonly string[] = [
  'IT ATE THE GAS MONEY.',
  'IT ATE A WHOLE BLOCK.',
  'IT ATE THE MEMPOOL.',
  'IT ATE THE CHAIN.',
];

/** The wallet tier it ended the night at, by `state.ending`, with its line on the report. */
export const WALLET_TIERS: readonly { tier: string; line: string }[] = [
  { tier: 'Shrimp', line: 'Wallet tier: shrimp. Everyone starts somewhere.' },
  { tier: 'Dolphin', line: 'Wallet tier: dolphin. It is getting ideas.' },
  { tier: 'Shark', line: 'Wallet tier: shark. The whales have noticed.' },
  { tier: 'Whale', line: 'Wallet tier: whale. The whale alerts are about it now.' },
];

/** The report's headline: the night lost, or a new personal best (or the twelve-minute cap survived). */
export const HEADLINES = {
  over: ['IT’S SO', 'OVER.'],
  back: ['WE’RE SO', 'BACK.'],
} as const;

// ---- the extras.

/**
 * Press E. Contest 1's judges could not get a game's E key to work on stream
 * and it became the hosts' running joke ("Press E, Jeremy." "I pressed E. I
 * did it."). Now and then the creature spits out a PRESS E sign
 * (`./pressE.ts`); pressing E while it is up is a hit (PRESS_E_HIT, a burst of
 * coins, ding ding ding). Pressing E any other time gets these, a little drier
 * each time. E never touches the rules.
 */
export const PRESS_E: readonly string[] = ['YOU PRESSED E.', 'NOTHING HAPPENED.', 'E IS NOT A TOKEN.', 'WAIT FOR IT.'];
/** What a hit says, as a card. */
export const PRESS_E_HIT = 'IT WORKED.';
/** The line for the `count`-th press (1-based); the last line repeats. */
export const pressELine = (count: number) => PRESS_E[Math.min(PRESS_E.length - 1, Math.max(0, Math.floor(count) - 1))];

/** Halloween on the title (see `./season.ts`): the tag, the lede's first line and Munch's costume. */
export const HALLOWEEN = {
  tag: 'TRICK OR TOKEN',
  ledeFirst: 'Proposal #004 passed. Nobody enforces it.',
  costume: 'Costume: a whale. It is working on it.',
} as const;

// ---- scripture.

/**
 * The hosts' own words, set as verses: the speaker is the book and the stream
 * timestamp is chapter and verse, so "Max 13:06" reads like scripture. Every
 * line is from the auto-captions of a Hemi stream (stutters removed), cited
 * at the start of its passage. Lines about the work, the game or the speaker
 * themselves, in good humour; nothing religious and nothing at anyone's
 * expense. They go where people read for a moment (title, pause, help, the
 * report, the sound mix), never in a caption. When the speaker is not certain
 * the book is the show. Every verse is listed in docs/QUOTES.md.
 */
export interface Verse {
  text: string;
  /** The book: who said it, or the show when that is not certain. */
  who: string;
  /** Chapter and verse: minutes and seconds into the stream. */
  at: string;
  show: 'Midweek with Max' | 'Office Hours';
  date: string;
}
const verse = (text: string, who: string, at: string, show: Verse['show'], date: string): Verse => ({ text, who, at, show, date });

/**
 * Asked "When Hemi flying car" on Oct 20 (1:00:56 into the stream, so chapter
 * 60), Max said one would be a fun addition to a contest game "just for the
 * meme value". The car crosses the title on every visit (./flyingCar.ts);
 * this is the first visit's verse, so a judge on a fresh browser gets the
 * words and the car together.
 */
const CAR_VERSE = verse('If somebody would like to build a Hemi flying car on Hemi network.', 'Max', '60:56', 'Midweek with Max', 'Oct 20');

export const VERSES = {
  /** One per visit, under the title. The first visit's is the flying car's. */
  title: [
    CAR_VERSE,
    verse('A new lens to look at Bitcoin through.', 'Max', '18:30', 'Midweek with Max', 'Oct 6'),
    verse("So they exist. Let's use it. Let's have some fun.", 'Marco', '11:49', 'Midweek with Max', 'Sept 15'),
    verse('So a guy walks into a blockchain.', 'Jeremy', '46:31', 'Office Hours', 'Sept 23'),
    verse("Art does not need utility. If it has to have utility, it's not art.", 'John', '7:37', 'Midweek with Max', 'Oct 13'),
    // The captions read "and uh I forgetting to sleep": "uh" is a stutter and the
    // stray "I" is the start of "I'm" — the likeliest audio, and it drops nothing.
    verse("I have been building games myself and I'm forgetting to sleep.", 'Rick', '72:08', 'Midweek with Max', 'Oct 20'),
  ],
  /** One per pause. Judges pause to talk. ("Let him cook" moved to the FOMO caption, Oct 22: a frenzy is the creature cooking.) */
  pause: [
    verse('The ZK talk will continue until questions come in.', 'Max', '13:06', 'Midweek with Max', 'Sept 15'),
    verse('Me, derailed? Never. Come on.', 'Max', '28:44', 'Midweek with Max', 'Sept 29'),
    verse('Complex systems are complex.', 'John', '52:07', 'Midweek with Max', 'Oct 6'),
    // The ZK rant, by its author ("all my rants"). A pause is a nap.
    verse('Repackage all my rants on Midweek as like a sleep series about ZK proofs.', 'Max', '55:15', 'Midweek with Max', 'Oct 20'),
  ],
  /** Under the title on the visits the flying car crosses behind it. */
  car: CAR_VERSE,
  /** The whitepaper's epigraph. */
  help: verse('Whatever you do with the tokens is cool, but the biggest thing is make a good game.', 'John', '28:24', 'Midweek with Max', 'Oct 13'),
  /** Cited in the whitepaper's first step. */
  sloth: verse('I have the hand-eye coordination of a sloth.', 'Max', '29:25', 'Office Hours', 'Oct 7'),
  /** Under the restart button. */
  restart: verse('Your job is to make us want to keep giving those games quarters.', 'John', '29:29', 'Midweek with Max', 'Oct 13'),
  /** Cited on a new personal best. The speaker is not certain (Rick answers it), so the book is the show. */
  newBest: verse('Flashing lights and loud noises. Ding, ding, ding, ding, ding.', 'Midweek with Max', '29:46', 'Midweek with Max', 'Oct 13'),
  /** The sound mix: the music is original, and nothing is sampled. */
  sound: verse('The real horror is copyright strikes.', 'Office Hours', '16:10', 'Office Hours', 'Oct 7'),
} as const;

/** Every verse, for the tests and the docs. */
export const ALL_VERSES: readonly Verse[] = [
  ...VERSES.title, ...VERSES.pause, VERSES.help, VERSES.sloth, VERSES.restart, VERSES.newBest, VERSES.sound,
];

/** The `n`-th verse of a list, wrapping. */
export const verseAt = (list: readonly Verse[], n: number): Verse => list[((Math.floor(n) % list.length) + list.length) % list.length];

// ---- the ledger: filing a shift on Hemi (docs/CHAIN.md §8).

/**
 * Every word the chain layer shows: the button on the epoch report, the
 * status captions as it files, the plain reasons when it cannot, the
 * leaderboard strip. Captions are uppercase and end on a full stop, and each
 * crypto word is true of what is happening: REPLAYING. while the verifier
 * replays the trace, PENDING. while the transaction is pending, FILED. once
 * the contract recorded it. Everything the player must act on is plain
 * (rule 7): "Sign it in your wallet.", "Retry", "Skip". No prices, no
 * promises; the only money word is the gas the player pays.
 */
export const LEDGER = {
  /** The one button on the report. */
  button: 'File this shift on Hemi',
  /** Under the button, once, small. True: one transaction, the player pays. */
  gas: 'One transaction. You pay the gas (a fraction of a cent on Hemi).',
  /** The grey line when there is nothing to file. */
  practice: 'Practice shift. Not filed.',
  skipped: 'Not filed.',
  /** The header label: practice, or the chain and the shift number. */
  header: {
    practice: 'LOCAL PRACTICE',
    hemi: 'HEMI MAINNET',
    chain: (id: number) => `CHAIN ${id}`,
    shift: (n: number) => `SHIFT #${n}`,
  },
  /** One caption per step, in the game's caption voice. */
  captions: {
    connecting: 'CONNECTING.',
    attesting: 'REPLAYING.',
    signing: 'SIGNING.',
    sending: 'SENDING.',
    confirming: 'PENDING.',
    filed: 'FILED.',
    failed: 'NOT FILED.',
  },
  /** The plain line beside each caption. `chain` is "Hemi", or the chain's name when it is not Hemi. */
  lines: {
    connecting: 'Approve the connection in your wallet.',
    attesting: 'Replaying your shift…',
    signing: 'Sign it in your wallet.',
    sending: 'Sending…',
    confirming: (chain: string) => `Pending on ${chain}`,
    stalled: (chain: string) => `Still pending on ${chain}. Check again in a minute.`,
    block: (block: string) => `Block ${block}`,
    /** FILED. without a transaction of its own: the contract said DuplicateRun and `usedRunIds` confirmed the shift is on the chain. The line is the link to the registry's explorer page when there is one. */
    already: (chain: string) => `This shift was already on ${chain}.`,
    alreadyLink: (chain: string) => `This shift was already on ${chain} ↗`,
    explorer: (chain: string) => `View on ${chain} Explorer ↗`,
    /** The record behind the filing: the trace whose hash the contract holds, for anyone to replay. */
    trace: 'Trace ↗',
    traceTitle: 'The shift’s trace: its keccak is the traceHash in the transaction. Replay it with scripts/verify-filing.mjs.',
    best: (chain: string, score: string) => `Your best on ${chain}: ${score}`,
    /** The verified contribution and the epoch's pile it went into (docs/CHAIN.md §10.4). */
    pile: (epoch: string, btc: number, eth: number, hemi: number) => `Filed into epoch ${epoch}’s pile: ${btc} BTC · ${eth} ETH · ${hemi} HEMI.`,
    /** Past a wallet's three filings in an epoch: recorded and ranked, but the contract fed nothing to the pile (no PileFed). */
    pileFull: (epoch: string) => `Epoch ${epoch}’s pile takes three shifts a wallet; yours are in. This one counts for the board.`,
    /** No receipt of ours (DuplicateRun: filed elsewhere): what the shift fed, without claiming which pile, if any, it went into. */
    pileUnknownEpoch: (btc: number, eth: number, hemi: number) => `This shift: ${btc} BTC · ${eth} ETH · ${hemi} HEMI.`,
  },
  actions: { retry: 'Retry', skip: 'Skip', cancel: 'Cancel', check: 'Check again' },
  /** Why it was not filed, by the failure code, in plain words. */
  reasons: {
    no_wallet: 'No wallet found in this browser.',
    rejected: 'You cancelled it in your wallet.',
    wrong_chain: (chain: string) => `Your wallet is on another chain. Switch to ${chain} and retry.`,
    insufficient_funds: (chain: string) => `Not enough ETH on ${chain} to pay the gas.`,
    reverted: 'The contract refused it.',
    reverted_onchain: 'The transaction reverted.',
    network: (chain: string) => `${chain} did not answer. Check your connection and retry.`,
    timeout: 'The verifier took too long. Retry.',
    disabled: 'Filing is switched off right now.',
    rate_limited: 'Too many requests. Wait a minute and retry.',
    bad_request: 'The verifier did not accept this shift.',
    unknown_ticket: 'The ticket for this shift was not found.',
    expired_ticket: 'The ticket for this shift expired.',
    invalid_trace: 'The verifier could not replay this shift.',
    run_not_over: 'The verifier says this shift is not over yet.',
    payload_conflict: 'This shift was already attested with a different trace.',
    player_conflict: 'This shift was signed for another wallet. Switch back to it and retry.',
    replaced: 'The transaction was replaced or cancelled in your wallet. Nothing was filed.',
    out_of_bounds: 'The verifier refused this shift’s numbers.',
    unavailable: 'The verifier is unavailable. Retry in a moment.',
    bad_response: 'The verifier’s answer did not make sense.',
    mismatch: 'The verifier’s numbers do not match this shift. Nothing was signed.',
    clock: 'Your computer’s clock looks off. Check the time and retry.',
    unknown: 'Something went wrong.',
  },
  /** The contract's own refusals, decoded, in plain words. */
  reverts: {
    InvalidResult: 'The contract refused the result: a number is out of bounds.',
    InvalidSignature: 'The contract refused a signature.',
    DuplicateRun: 'This shift was already filed.',
    WrongVersion: 'The rules changed since this shift. It cannot be filed.',
    Expired: 'The signature expired before it was filed.',
  },
  /** The leaderboard strip under the diet line. */
  top: {
    title: 'TOP KEEPERS',
    stale: (minutes: number) => `(as of ${minutes} min ago)`,
    empty: 'Nobody has filed a shift this epoch.',
  },
  /** A filing from before a reload, on the title. */
  last: {
    pending: (chain: string) => `Your last shift is still pending on ${chain}.`,
    filed: (chain: string) => `Your last shift was filed on ${chain}.`,
    reverted: 'Your last shift was not filed: the transaction reverted.',
  },
} as const;

// ---- the inherited trait: last epoch's pile is tonight's creature (docs/CHAIN.md §10).

/** "6h 12m", "2h", "1m": the time left, whole minutes rounded up and never zero. */
function untilClose(secondsLeft: number): string {
  const minutes = Math.max(1, Math.ceil(secondsLeft / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h${rest > 0 ? ` ${rest}m` : ''}` : `${rest}m`;
}

/** The coins by ticker, as the diet line and the inherited line name them. */
export const TICKERS: Record<Ingredient, string> = { metal: 'BTC', balloon: 'ETH', pepper: 'HEMI' };

/**
 * The ledger page (`/ledger`): every filed shift, by epoch, and what each
 * epoch's pile did to the creature after it. Plain words where the reader
 * acts (tabs, links); the fiction's voice in the headings. Every crypto word
 * is true of what is shown: an epoch is an epoch, a pile is what was fed,
 * FILED is on chain.
 */
export const LEDGER_PAGE = {
  title: 'The ledger',
  eyebrow: (chain: string) => `THE LEDGER · ${chain.toUpperCase()}`,
  headline: ['WHAT EVERYONE', 'FED IT.'] as const,
  lede: 'Every shift filed on Hemi, epoch by epoch. Whatever a pile had most of, the creature after it comes in with.',
  back: '← Back to the kitchen',
  loading: 'Reading the ledger…',
  off: 'Filing is switched off right now. The ledger fills when shifts are filed on Hemi.',
  failed: 'The ledger did not answer. Try again in a minute.',
  /** The pile's shifts: a wallet's first three an epoch (docs/CHAIN.md §7); a fourth still ranks on the board. */
  allTime: (shifts: string) => `${shifts} shifts in the pile, all time`,
  epochsTitle: 'EPOCHS',
  epoch: (n: number) => `EPOCH ${n}`,
  now: 'NOW',
  nothingFed: 'Nothing fed yet.',
  nothingFedPast: 'Nobody fed it.',
  shifts: (n: number) => (n === 1 ? '1 shift in the pile' : `${n.toLocaleString('en-US')} shifts in the pile`),
  cameWith: 'CAME IN WITH',
  passesOn: 'PASSES ON',
  leading: 'LEADING',
  nothing: 'nothing',
  unknown: '—',
  from: (epoch: number) => `from epoch ${epoch}`,
  boardTitle: 'KEEPERS',
  tabAllTime: 'All time',
  tabEpoch: (n: number) => `Epoch ${n}`,
  columns: { rank: '#', keeper: 'Keeper', score: 'Score', uptime: 'Uptime', fed: 'Fed', size: 'Size', epoch: 'Epoch', proof: 'Proof' },
  emptyBoard: 'Nobody has filed a shift here yet.',
  emptyBoardPast: 'Nobody filed a shift that epoch.',
  trace: 'Trace ↗',
  tx: 'Tx ↗',
  registry: 'Registry ↗',
  indexed: (block: string) => `Indexed to block ${block}`,
  updated: (minutes: number) => (minutes < 1 ? 'updated just now' : `updated ${minutes} min ago`),
  stale: (minutes: number) => `Hemi did not answer: as of ${minutes} min ago`,
  verify: 'Every row is a ResultRecorded event on Hemi. Anyone can replay one: scripts/verify-filing.mjs.',
  /** On the title, beside TOP KEEPERS. */
  link: 'The ledger ↗',
} as const;

/**
 * What the community's diet did to the creature everyone plays next: the
 * title's line under the diet line, the tag on the chip for the level it came
 * in with, and the whitepaper's fourth step. The captions are uppercase with
 * a full stop and the double-meaning rule holds: it does have the jaws — the
 * chip is lit and they pull cutlery from the first tick. No prices, no
 * promises; filing is optional and the only money word is the gas.
 */
export const INHERITED = {
  /**
   * Two short captions for one line (they may wrap between themselves):
   * LAST EPOCH: 61% BTC. TONIGHT IT HAS HODL JAWS. `share` is the source
   * pile's largest share (0–1), or null when the client does not hold that
   * pile — then the first caption says only which coin was on top.
   */
  line(inherited: Ingredient, share: number | null): { last: string; tonight: string } {
    const ticker = TICKERS[inherited];
    const last = share === null || !Number.isFinite(share) ? `LAST EPOCH: ${ticker} ON TOP.` : `LAST EPOCH: ${Math.round(Math.max(0, Math.min(1, share)) * 100)}% ${ticker}.`;
    return { last, tonight: `TONIGHT IT HAS ${TOKEN_TRAITS[inherited].toUpperCase()}.` };
  },
  /**
   * When this epoch's pile closes and the next creature is bred from it —
   * literally true: the contract starts a new pile then. Whole minutes,
   * rounded up; hours when there are any. After the diet line, in its own
   * sentence case (`closesAfterDiet`); as the inherited line's caption only
   * when there is no diet line to follow (`closes`).
   */
  closes(secondsLeft: number): string {
    return `PILE CLOSES IN ${untilClose(secondsLeft).toUpperCase()}.`;
  },
  closesAfterDiet(secondsLeft: number, window: string): string {
    return window === 'this epoch' ? `The pile closes in ${untilClose(secondsLeft)}.` : `This epoch’s pile closes in ${untilClose(secondsLeft)}.`;
  },
  /** Under the trait's name on the chip, for the level it came in with. */
  tag: 'INHERITED',
  /** The whitepaper's fourth step. */
  help: {
    title: 'What everyone fed it, it keeps.',
    body: 'Each wallet’s first three shifts filed on Hemi in an epoch add their coins to the community pile; more still count for the board. Whichever coin the pile had the most of last epoch, tonight’s creature comes in with that coin’s trait already at level one, from the first tick. Filing is optional: one transaction from the epoch report, gas paid by you, and a practice shift never touches the chain.',
  },
} as const;
