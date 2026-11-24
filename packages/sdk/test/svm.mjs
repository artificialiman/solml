// Adapter over LiteSVM 1.x (built on @solana/kit) that keeps the web3.js-v1 shapes the tests use:
// PublicKey arguments, Transaction objects, and accounts as { owner, data, lamports, executable }.
import { LiteSVM, TransactionMetadata, Clock } from "litesvm";
import { address, lamports } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";

const a = (k) => address(k.toBase58());

export { Clock, TransactionMetadata };

export class Svm {
  constructor() {
    this.inner = new LiteSVM();
  }
  airdrop(key, amount) {
    return this.inner.airdrop(a(key), lamports(amount));
  }
  addProgramFromFile(key, path) {
    this.inner.addProgramFromFile(a(key), path);
  }
  minimumBalanceForRentExemption(len) {
    return this.inner.minimumBalanceForRentExemption(len);
  }
  setAccount(key, acc) {
    this.inner.setAccount({
      address: a(key),
      data: Uint8Array.from(acc.data),
      executable: acc.executable,
      lamports: lamports(BigInt(acc.lamports)),
      programAddress: a(acc.owner),
      space: BigInt(acc.data.length),
    });
  }
  /** null when the account does not exist; otherwise the web3.js-style account. */
  getAccount(key) {
    const acc = this.inner.getAccount(a(key));
    if (!acc.exists) return null;
    return {
      data: Uint8Array.from(acc.data),
      owner: new PublicKey(acc.programAddress),
      lamports: Number(acc.lamports),
      executable: acc.executable,
    };
  }
  getBalance(key) {
    return this.inner.getBalance(a(key));
  }
  latestBlockhash() {
    return this.inner.latestBlockhash();
  }
  expireBlockhash() {
    this.inner.expireBlockhash();
  }
  getClock() {
    return this.inner.getClock();
  }
  setClock(c) {
    this.inner.setClock(c);
  }
  /** Sends a signed web3.js legacy Transaction. */
  sendTransaction(tx) {
    const signatures = {};
    for (const s of tx.signatures) signatures[s.publicKey.toBase58()] = s.signature ? Uint8Array.from(s.signature) : null;
    return this.inner.sendTransaction({ messageBytes: Uint8Array.from(tx.serializeMessage()), signatures });
  }
}
