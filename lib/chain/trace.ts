/**
 * The canonical trace: the run's commands and its end tick as bytes, and the
 * hash the contract records. docs/CHAIN.md §3. Shared by the Worker (which
 * hashes what it replayed) and the tests; the client never needs to hash.
 *
 * Layout, big-endian:
 *   u8 version (1) · u32 endTick · u16 count ·
 *   count × ( u32 tick · u8 kind [0 launch, 1 hatch, 2 press E] · u8 ingredient
 *             [0 metal, 1 balloon, 2 pepper, 255 none] · i8 angle · u8 power )
 */
import { keccak256, type Hex } from "viem";
import { ARENA, FOODS, type ArcadeCommand, type Ingredient } from "../game/arcade.ts";
import { PRESS_E_EVERY } from "../game/pressE.ts";

export const TRACE_VERSION = 1;
/** The rules' own cap, re-derived: one launch per frenzy cooldown, one hatch per hatch cooldown and one E per sign, plus two. */
export const MAX_COMMANDS = Math.ceil(ARENA.maxTicks / ARENA.frenzyCooldownTicks) + Math.ceil(ARENA.maxTicks / ARENA.hatchCooldown)
  + Math.ceil(ARENA.maxTicks / PRESS_E_EVERY) + 2;
const HEADER_BYTES = 1 + 4 + 2;
const COMMAND_BYTES = 4 + 1 + 1 + 1 + 1;
export const MAX_TRACE_BYTES = HEADER_BYTES + MAX_COMMANDS * COMMAND_BYTES;
/** The largest JSON body the attest route reads. Generous: a full trace is about 190 KB as JSON. */
export const MAX_TRACE_JSON_BYTES = 256 * 1024;

const INGREDIENT_CODE: Record<Ingredient, number> = { metal: 0, balloon: 1, pepper: 2 };

/**
 * Shape-check only: integers in range, ticks strictly increasing. Whether
 * each command is *accepted* at its tick is the replay's business.
 */
export function validateTrace(commands: unknown, endTick: unknown): asserts commands is ArcadeCommand[] {
  if (!Number.isSafeInteger(endTick) || (endTick as number) < 0 || (endTick as number) > ARENA.maxTicks) throw new Error("Invalid end tick");
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS) throw new Error("Invalid trace");
  let previous = -1;
  for (const command of commands) {
    if (!command || typeof command !== "object") throw new Error("Invalid trace");
    const c = command as Record<string, unknown>;
    if (!Number.isSafeInteger(c.tick) || (c.tick as number) <= previous || (c.tick as number) > (endTick as number)) throw new Error("Invalid trace");
    if (c.kind === "launch") {
      if (!FOODS.includes(c.ingredient as Ingredient)) throw new Error("Invalid trace");
      if (!Number.isInteger(c.angle) || (c.angle as number) < ARENA.minAngle || (c.angle as number) > ARENA.maxAngle) throw new Error("Invalid trace");
      if (!Number.isInteger(c.power) || (c.power as number) < ARENA.minPower || (c.power as number) > ARENA.maxPower) throw new Error("Invalid trace");
    } else if (c.kind !== "hatch" && c.kind !== "e") {
      throw new Error("Invalid trace");
    }
    previous = c.tick as number;
  }
}

/** Canonical bytes. Validates first, so a malformed trace never hashes. */
export function encodeTrace(commands: readonly ArcadeCommand[], endTick: number): Uint8Array {
  validateTrace(commands, endTick);
  const bytes = new Uint8Array(HEADER_BYTES + commands.length * COMMAND_BYTES);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint8(offset, TRACE_VERSION); offset += 1;
  view.setUint32(offset, endTick); offset += 4;
  view.setUint16(offset, commands.length); offset += 2;
  for (const command of commands) {
    view.setUint32(offset, command.tick); offset += 4;
    if (command.kind === "launch") {
      view.setUint8(offset, 0); view.setUint8(offset + 1, INGREDIENT_CODE[command.ingredient]);
      view.setInt8(offset + 2, command.angle); view.setUint8(offset + 3, command.power);
    } else {
      view.setUint8(offset, command.kind === "e" ? 2 : 1); view.setUint8(offset + 1, 255); view.setInt8(offset + 2, 0); view.setUint8(offset + 3, 0);
    }
    offset += 4;
  }
  return bytes;
}

/** Decode canonical bytes; the inverse of `encodeTrace`, for tests and tools. */
export function decodeTrace(bytes: Uint8Array): { commands: ArcadeCommand[]; endTick: number } {
  if (bytes.length < HEADER_BYTES) throw new Error("Invalid trace bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== TRACE_VERSION) throw new Error("Unknown trace version");
  const endTick = view.getUint32(1);
  const count = view.getUint16(5);
  if (bytes.length !== HEADER_BYTES + count * COMMAND_BYTES) throw new Error("Invalid trace bytes");
  const commands: ArcadeCommand[] = [];
  for (let i = 0, offset = HEADER_BYTES; i < count; i++, offset += COMMAND_BYTES) {
    const tick = view.getUint32(offset);
    const kind = view.getUint8(offset + 4);
    if (kind === 1 || kind === 2) {
      if (view.getUint8(offset + 5) !== 255 || view.getInt8(offset + 6) !== 0 || view.getUint8(offset + 7) !== 0) throw new Error("Invalid trace bytes");
      commands.push(kind === 1 ? { tick, kind: "hatch" } : { tick, kind: "e" });
    } else if (kind === 0) {
      const ingredient = FOODS[view.getUint8(offset + 5)];
      if (!ingredient) throw new Error("Invalid trace bytes");
      commands.push({ tick, kind: "launch", ingredient, angle: view.getInt8(offset + 6), power: view.getUint8(offset + 7) });
    } else {
      throw new Error("Invalid trace bytes");
    }
  }
  validateTrace(commands, endTick);
  return { commands, endTick };
}

export function traceHash(commands: readonly ArcadeCommand[], endTick: number): Hex {
  return keccak256(encodeTrace(commands, endTick));
}
