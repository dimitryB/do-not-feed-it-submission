import assert from "node:assert/strict";
import test from "node:test";
import { discoverProviders, getProviders, pickProvider, providerId, refreshProviders, watchProviders } from "../lib/chain/wallet.ts";

const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];
const provider = (flags = {}) => ({ ...flags, requests: [], async request(args) { this.requests.push(args); return []; } });
const wallet = (name, rdns, injected = provider(), uuid = UUIDS[0]) => ({ info: { uuid, name, rdns, icon: "data:image/svg+xml,<svg/>" }, provider: injected });

function page(t, ethereum) {
  const previous = globalThis.window;
  const target = new EventTarget();
  target.ethereum = ethereum;
  globalThis.window = target;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  target.announce = (detail) => {
    const event = new Event("eip6963:announceProvider");
    Object.defineProperty(event, "detail", { value: detail });
    target.dispatchEvent(event);
  };
  return target;
}

test("late MetaMask remains discoverable after Brave and the initial 250 ms window", async (t) => {
  const target = page(t);
  const brave = wallet("Brave Wallet", "com.brave.wallet");
  const metamask = wallet("MetaMask", "io.metamask", provider(), UUIDS[1]);
  const changes = [];
  const stop = watchProviders((choices) => changes.push(choices.map((choice) => choice.info.name)));
  t.after(stop);
  target.announce(brave);
  await new Promise((resolve) => setTimeout(resolve, 270));
  target.announce(metamask);
  assert.deepEqual(changes.at(-1), ["MetaMask", "Brave Wallet"]);
  assert.deepEqual(getProviders().map((choice) => choice.provider), [metamask.provider, brave.provider]);
  assert.deepEqual([...brave.provider.requests, ...metamask.provider.requests], [], "discovery must not open either wallet");
});

test("closing a picker unsubscribes it but the page continues retaining announcements", (t) => {
  const target = page(t);
  const brave = wallet("Brave Wallet", "com.brave.wallet");
  const metamask = wallet("MetaMask", "io.metamask", provider(), UUIDS[1]);
  let notifications = 0;
  const stop = watchProviders(() => { notifications++; });
  target.announce(brave);
  stop();
  const before = notifications;
  target.announce(metamask);
  assert.equal(notifications, before, "an unmounted picker must receive no updates");
  let retained;
  const stopAgain = watchProviders((choices) => { retained = choices; });
  t.after(stopAgain);
  assert.deepEqual(retained.map((choice) => choice.info.name), ["MetaMask", "Brave Wallet"]);
});

test("announcements deduplicate by provider identity or valid UUID and ignore malformed details", (t) => {
  const target = page(t);
  const metamask = wallet("MetaMask", "io.metamask");
  const stop = watchProviders(() => {});
  t.after(stop);
  target.announce(metamask);
  target.announce({ ...metamask, info: { ...metamask.info, uuid: UUIDS[1] } });
  target.announce(wallet("Duplicate", "io.duplicate", provider(), UUIDS[0]));
  for (const invalid of [null, {}, { provider: provider() }, { ...metamask, info: {} },
    { ...metamask, info: { ...metamask.info, uuid: undefined } },
    { ...metamask, info: { ...metamask.info, uuid: "not-a-uuid" } },
    { ...metamask, info: { ...metamask.info, name: " " } },
    { ...metamask, provider: { request: true } },
    { get provider() { throw new Error("bad injected getter"); } }]) target.announce(invalid);
  assert.equal(getProviders().length, 1);
  assert.equal(getProviders()[0].provider, metamask.provider);
});

test("legacy multi-wallet injection offers actual providers and labels Brave before its isMetaMask flag", (t) => {
  const brave = provider({ isBraveWallet: true, isMetaMask: true });
  const metamask = provider({ isMetaMask: true });
  const container = provider({ providers: [brave, metamask] });
  const target = page(t, container);
  let choices;
  const stop = watchProviders((found) => { choices = found; });
  t.after(stop);
  assert.deepEqual(choices.map((choice) => choice.info.name), ["MetaMask", "Brave Wallet"]);
  assert.deepEqual(choices.map((choice) => choice.provider), [metamask, brave]);
  const stableId = providerId(metamask);
  target.announce(wallet("MetaMask", "io.metamask", metamask, UUIDS[1]));
  assert.equal(choices.length, 2, "the announcement replaces the legacy label, not the provider");
  assert.equal(providerId(choices[0].provider), stableId);
  assert.deepEqual([...container.requests, ...brave.requests, ...metamask.requests], []);
});

test("bounded discovery retains later announcements, and legacy pick uses the extension", async (t) => {
  const brave = provider({ isBraveWallet: true, isMetaMask: true });
  const metamask = provider({ isMetaMask: true });
  const target = page(t, provider({ providers: [brave, metamask] }));
  const snapshot = await discoverProviders(0);
  assert.deepEqual(snapshot.map((choice) => choice.provider), [metamask, brave]);
  target.announce(wallet("MetaMask", "io.metamask", metamask, UUIDS[1]));
  assert.equal(getProviders()[0].info.uuid, UUIDS[1]);
  assert.equal(await pickProvider(), metamask);
  assert.deepEqual([...brave.requests, ...metamask.requests], []);
});

test("manual refresh rescans legacy providers injected after the picker opened", (t) => {
  const brave = provider({ isBraveWallet: true, isMetaMask: true });
  const metamask = provider({ isMetaMask: true });
  const target = page(t, provider({ providers: [brave] }));
  let choices;
  let requests = 0;
  target.addEventListener("eip6963:requestProvider", () => { requests++; });
  const stop = watchProviders((found) => { choices = found; });
  t.after(stop);
  target.ethereum.providers.push(metamask);
  refreshProviders();
  assert.equal(requests, 2, "mount and refresh both ask extensions to announce");
  assert.deepEqual(choices.map((choice) => choice.info.name), ["MetaMask", "Brave Wallet"]);
  assert.deepEqual([...brave.requests, ...metamask.requests], []);
});

test("a malformed legacy provider cannot hide another installed wallet", (t) => {
  const metamask = provider({ isMetaMask: true });
  page(t, provider({ providers: [{ get request() { throw new Error("bad legacy getter"); } }, metamask] }));
  assert.deepEqual(getProviders().map((choice) => choice.provider), [metamask]);
});
