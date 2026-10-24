"use client";

import { useEffect, useState } from "react";
import { providerId, refreshProviders, watchProviders, type DiscoveredProvider } from "../../lib/chain/wallet";
import { LEDGER } from "../../lib/render/lore";
import { useDialogFocusTrap } from "./focusTrap";

/** Discovery only: account access starts after the player selects a wallet. */
export function WalletPicker({ onSelect, onClose }: {
  onSelect: (wallet: DiscoveredProvider) => void;
  onClose: () => void;
}) {
  const [wallets, setWallets] = useState<readonly DiscoveredProvider[]>([]);
  const ref = useDialogFocusTrap(onClose);
  useEffect(() => watchProviders(setWallets), []);
  return <div className="modal-scrim" onMouseDown={onClose}>
    <div className="wallet-modal" ref={ref} tabIndex={-1} role="dialog" aria-modal="true"
      aria-labelledby="wallet-picker-title" aria-describedby="wallet-picker-description"
      onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onKeyUp={event => event.stopPropagation()}>
      <button className="modal-close" aria-label={LEDGER.wallet.close} onClick={onClose}>×</button>
      <h2 id="wallet-picker-title">{LEDGER.wallet.title}</h2>
      <p id="wallet-picker-description">{LEDGER.wallet.description}</p>
      <div className="wallet-options">
        {wallets.map(wallet => <button key={providerId(wallet.provider)} className="wallet-option"
          onClick={() => onSelect(wallet)}>{wallet.info.name}<span aria-hidden="true">→</span></button>)}
      </div>
      {!wallets.length && <p role="status">{LEDGER.wallet.empty}</p>}
      <p className="wallet-help">{LEDGER.wallet.missing}</p>
      <button className="text-button" onClick={refreshProviders}>
        {LEDGER.wallet.refresh}
      </button>
    </div>
  </div>;
}
