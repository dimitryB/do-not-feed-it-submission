import { launchFood, pressE, slamHatch, type ArcadeCommand, type ArcadeState } from "../../lib/game/arcade.ts";

/** Apply and record inputs together, admitting at most one command per rules tick. */
export function applyGameCommand(state: ArcadeState, commands: ArcadeCommand[], command: ArcadeCommand): boolean {
  // The replay format requires strictly increasing ticks. For example, a
  // launch and an immediately pressed hatch can otherwise both succeed
  // between animation frames and produce a shift the verifier cannot replay.
  const previous = commands.at(-1);
  if (command.tick !== state.tick || (previous && previous.tick >= command.tick)) return false;
  const accepted = command.kind === "hatch" ? slamHatch(state)
    : command.kind === "e" ? pressE(state)
    : launchFood(state, command.ingredient, command.angle, command.power);
  if (accepted) commands.push({ ...command });
  return accepted;
}
